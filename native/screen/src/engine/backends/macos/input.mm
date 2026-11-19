#include "core/input.hpp"
#include "backends/linux/keycodes.hpp"
#include "backends/macos/display.hpp"
#include "backends/macos/keys.hpp"
#include <AppKit/AppKit.h>
#include <Carbon/Carbon.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <thread>
#include <utility>
#include <vector>

namespace relay {
namespace {
/// Tap that receives every posted event.
constexpr CGEventTapLocation eventTap = kCGHIDEventTap;
/// Sign that turns a positive relay notch into a line step down or right; flip it if the VM scrolls backwards.
constexpr int scrollSign = -1;
/// Points of cursor travel still counted as the same click position.
constexpr double clickSlop = 5;
/// Modifier flag a held key contributes to every posted event.
constexpr CGEventFlags modifierFlag(NativeKey key) {
  switch (key) {
    case kVK_Shift: case kVK_RightShift: return kCGEventFlagMaskShift;
    case kVK_Control: case kVK_RightControl: return kCGEventFlagMaskControl;
    case kVK_Option: case kVK_RightOption: return kCGEventFlagMaskAlternate;
    case kVK_Command: case kVK_RightCommand: return kCGEventFlagMaskCommand;
    default: return 0;
  }
}
/// Applies queued input as CGEvents on one thread that owns a private event source.
class MacInput final : public InputBackend {
  CGRect bounds{};
  uint16_t width = 0, height = 0;
  CGEventSourceRef source = nullptr;
  CGPoint position{}, clickPoint{};
  std::set<NativeKey> held;
  std::map<unsigned, unsigned> heldButtons;
  unsigned clicks = 1, clickButton = 0;
  std::chrono::steady_clock::time_point clickTime{};
  std::chrono::steady_clock::duration clickInterval{};
  bool capsLock = false;
  mutable std::mutex mutex;
  std::condition_variable wake;
  InputQueue queue;
  bool stopping = false;
  std::thread worker;

 public:
  MacInput() {
    const auto display = macos::findDisplay();
    bounds = display.bounds;
    width = uint16_t(display.width);
    height = uint16_t(display.height);
    position = CGPointMake(CGRectGetMidX(bounds), CGRectGetMidY(bounds));
    capsLock = (CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & kCGEventFlagMaskAlphaShift) != 0;
    clickInterval = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
        std::chrono::duration<double>([NSEvent doubleClickInterval]));
    worker = std::thread([this] { run(); });
  }
  ~MacInput() override {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    wake.notify_all();
    if (worker.joinable()) worker.join();
  }
  std::pair<uint16_t, uint16_t> dimensions() const override { return {width, height}; }
  const char* name() const override { return "macos"; }
  std::optional<NativeKey> nativeKey(uint16_t usage) const override {
    const int key = macos::macKey(hidKeycode(usage));
    if (key < 0) return std::nullopt;
    return NativeKey(key);
  }
  bool typeText(uint32_t codepoint) override {
    if (codepoint == 0 || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
    InputJob job{InputJob::Kind::text};
    job.codepoint = codepoint;
    post(job);
    return true;
  }
  void pressKey(NativeKey key) override { postKey(key, true); }
  void releaseKey(NativeKey key) override { postKey(key, false); }
  void pressButton(unsigned button) override { postButton(button, true); }
  void releaseButton(unsigned button) override { postButton(button, false); }
  void move(int x, int y) override {
    InputJob job{InputJob::Kind::motion};
    job.x = x; job.y = y;
    post(job);
  }
  void scroll(unsigned axis, int notches) override {
    InputJob job{InputJob::Kind::scroll};
    job.number = axis; job.notches = notches;
    post(job);
  }
  void resetLocks() override { post(InputJob{InputJob::Kind::locks}); }
  void fence(std::shared_ptr<InputFence> mark) override {
    InputJob job{InputJob::Kind::fence};
    job.fence = std::move(mark);
    post(job);
  }
  void cancel() override {
    { std::lock_guard<std::mutex> lock(mutex); queue.cancel(); }
    wake.notify_one();
  }
  void flush() override { post(InputJob{InputJob::Kind::flush}); }
  size_t pending() const override {
    std::lock_guard<std::mutex> lock(mutex);
    return queue.pending();
  }

 private:
  void postKey(NativeKey key, bool press) {
    InputJob job{InputJob::Kind::key};
    job.code = key; job.press = press;
    post(job);
  }
  void postButton(unsigned button, bool press) {
    InputJob job{InputJob::Kind::button};
    job.number = button; job.press = press;
    post(job);
  }
  void post(InputJob job) {
    { std::lock_guard<std::mutex> lock(mutex); queue.post(std::move(job)); }
    wake.notify_one();
  }
  void run() {
    source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    std::unique_lock<std::mutex> lock(mutex);
    for (;;) {
      wake.wait(lock, [this] { return stopping || !queue.empty(); });
      if (stopping) queue.cancel();
      if (queue.empty()) break;
      const InputJob job = queue.take();
      lock.unlock();
      apply(job);
      lock.lock();
    }
    lock.unlock();
    releaseHeld();
    if (source) { CFRelease(source); source = nullptr; }
  }
  CGEventFlags flags() const {
    CGEventFlags value = capsLock ? kCGEventFlagMaskAlphaShift : 0;
    for (const auto key : held) value |= modifierFlag(key);
    return value;
  }
  static CGEventRef withFlags(CGEventRef event, CGEventFlags state) {
    if (event) CGEventSetFlags(event, state);
    return event;
  }
  CGEventRef keyEvent(NativeKey key, bool press, CGEventFlags state) const {
    return withFlags(CGEventCreateKeyboardEvent(source, CGKeyCode(key), press), state);
  }
  CGEventRef mouseEvent(CGEventType type, CGPoint where, CGMouseButton button, unsigned clickCount,
                        CGEventFlags state) const {
    CGEventRef event = withFlags(CGEventCreateMouseEvent(source, type, where, button), state);
    if (event && clickCount) CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickCount);
    return event;
  }
  static void send(CGEventRef event) {
    if (!event) return;
    CGEventPost(eventTap, event);
    CFRelease(event);
  }
  void apply(const InputJob& job) {
    const CGEventFlags state = flags();
    switch (job.kind) {
      case InputJob::Kind::key:
        if (job.press) held.insert(job.code); else held.erase(job.code);
        if (job.press && job.code == NativeKey(kVK_CapsLock)) capsLock = !capsLock;
        send(keyEvent(job.code, job.press, flags()));
        break;
      case InputJob::Kind::text: type(job.codepoint); break;
      case InputJob::Kind::button: applyButton(job.number, job.press, state); break;
      case InputJob::Kind::motion: {
        const CGPoint target = globalPoint(job.x, job.y);
        if (CGPointEqualToPoint(target, position) && !heldButtons.empty()) break;
        position = target;
        send(mouseEvent(motionType(), position, dragButton(), 0, state));
        break;
      }
      case InputJob::Kind::scroll: applyScroll(job.number, job.notches, state); break;
      case InputJob::Kind::locks: applyLocks(state); break;
      case InputJob::Kind::flush: break;
      case InputJob::Kind::fence:
        if (!CGPreflightPostEventAccess() && job.fence) job.fence->complete(false, job.dropped);
        else job.complete();
        break;
    }
  }
  /// UTF-16 units for one codepoint, as a surrogate pair above the BMP; returns the unit count.
  static UniCharCount unicodeUnits(uint32_t codepoint, UniChar units[2]) {
    if (codepoint < 0x10000) { units[0] = UniChar(codepoint); return 1; }
    units[0] = UniChar(0xd800 + ((codepoint - 0x10000) >> 10));
    units[1] = UniChar(0xdc00 + ((codepoint - 0x10000) & 0x3ff));
    return 2;
  }
  void type(uint32_t codepoint) {
    if (codepoint == '\n' || codepoint == '\t') {
      const NativeKey key = NativeKey(codepoint == '\n' ? kVK_Return : kVK_Tab);
      send(keyEvent(key, true, 0));
      send(keyEvent(key, false, 0));
      return;
    }
    UniChar units[2];
    const UniCharCount count = unicodeUnits(codepoint, units);
    for (const bool press : {true, false}) {
      CGEventRef event = CGEventCreateKeyboardEvent(source, 0, press);
      if (!event) continue;
      CGEventKeyboardSetUnicodeString(event, count, units);
      send(withFlags(event, 0));
    }
  }
  void applyButton(unsigned number, bool press, CGEventFlags state) {
    unsigned count = 1;
    if (press) {
      count = nextClicks(number, position);
      heldButtons[number] = count;
    } else {
      const auto found = heldButtons.find(number);
      if (found == heldButtons.end()) return;
      count = found->second;
      heldButtons.erase(found);
    }
    const CGEventType type = number == 1 ? (press ? kCGEventLeftMouseDown : kCGEventLeftMouseUp)
                             : number == 3 ? (press ? kCGEventRightMouseDown : kCGEventRightMouseUp)
                                           : (press ? kCGEventOtherMouseDown : kCGEventOtherMouseUp);
    const CGMouseButton button = number == 1 ? kCGMouseButtonLeft
                                : number == 3 ? kCGMouseButtonRight : kCGMouseButtonCenter;
    send(mouseEvent(type, position, button, count, state));
  }
  void applyScroll(unsigned axis, int notches, CGEventFlags state) {
    const int32_t amount = scrollSign * notches;
    CGEventRef event = axis == 0
        ? CGEventCreateScrollWheelEvent2(source, kCGScrollEventUnitLine, 1, amount, 0, 0)
        : CGEventCreateScrollWheelEvent2(source, kCGScrollEventUnitLine, 2, 0, amount, 0);
    send(withFlags(event, state));
  }
  void applyLocks(CGEventFlags state) {
    if (CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) & kCGEventFlagMaskAlphaShift) {
      send(keyEvent(NativeKey(kVK_CapsLock), true, state));
      send(keyEvent(NativeKey(kVK_CapsLock), false, state));
    }
    capsLock = false;
  }
  void releaseHeld() {
    while (!held.empty()) {
      const NativeKey key = *held.begin();
      held.erase(held.begin());
      send(keyEvent(key, false, flags()));
    }
    while (!heldButtons.empty()) applyButton(heldButtons.begin()->first, false, flags());
  }
  CGPoint globalPoint(int x, int y) const {
    return CGPointMake(bounds.origin.x + (x + 0.5) * bounds.size.width / std::max(1, int(width)),
                       bounds.origin.y + (y + 0.5) * bounds.size.height / std::max(1, int(height)));
  }
  CGEventType motionType() const {
    if (heldButtons.count(1)) return kCGEventLeftMouseDragged;
    if (heldButtons.count(3)) return kCGEventRightMouseDragged;
    if (heldButtons.count(2)) return kCGEventOtherMouseDragged;
    return kCGEventMouseMoved;
  }
  CGMouseButton dragButton() const {
    if (heldButtons.count(3)) return kCGMouseButtonRight;
    return heldButtons.count(2) ? kCGMouseButtonCenter : kCGMouseButtonLeft;
  }
  unsigned nextClicks(unsigned number, CGPoint where) {
    const auto now = std::chrono::steady_clock::now();
    const bool near = std::abs(where.x - clickPoint.x) <= clickSlop && std::abs(where.y - clickPoint.y) <= clickSlop;
    clicks = number == clickButton && near && now - clickTime <= clickInterval ? std::min(clicks + 1, 3u) : 1u;
    clickButton = number; clickPoint = where; clickTime = now;
    return clicks;
  }
};
}
namespace macos {
std::unique_ptr<InputBackend> makeInputBackend() { return std::make_unique<MacInput>(); }
}
}
