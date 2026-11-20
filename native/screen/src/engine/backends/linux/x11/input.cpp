#include "core/input.hpp"
#include "backends/linux/keycodes.hpp"
#include <X11/Xlib.h>
#include <X11/XKBlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <chrono>
#include <condition_variable>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <thread>
#include <vector>

namespace relay {
namespace {
constexpr size_t spareCount = 16;
/// Minimum time between tapping a spare keycode and rebinding it.
constexpr std::chrono::milliseconds spareReuse(50);
/// Minimum time between two keyboard mapping changes, so clients refresh their keysym cache first.
constexpr std::chrono::milliseconds spareBind(12);
using TimePoint = std::chrono::steady_clock::time_point;
KeySym textKeysym(uint32_t codepoint) {
  if (codepoint == '\n') return XK_Return;
  if (codepoint == '\t') return XK_Tab;
  return codepoint <= 0xff ? KeySym(codepoint) : KeySym(0x01000000u | codepoint);
}
/// Applies queued input on one thread that owns the X connection, with spare keycode reuse paced for late readers.
class X11Input final : public InputBackend {
  struct Spare {
    KeyCode code = 0;
    KeySym symbol = NoSymbol;
    uint64_t used = 0;
    TimePoint tapped{};
  };
  Display* display = nullptr;
  uint16_t width = 0, height = 0;
  int columns = 1;
  uint64_t typed = 0;
  std::map<KeySym, KeyCode> layout;
  std::set<KeyCode> modifiers;
  std::vector<Spare> spares;
  std::set<unsigned> held;
  TimePoint bound{}, lastTap{};
  mutable std::mutex mutex;
  std::condition_variable wake;
  InputQueue queue;
  bool stopping = false;
  std::thread worker;
 public:
  X11Input() {
    display = XOpenDisplay(nullptr);
    if (!display) throw std::runtime_error("X11 input display unavailable; Wayland is unsupported");
    int event, error, major, minor;
    const int screen = DefaultScreen(display);
    const int root_width = DisplayWidth(display, screen), root_height = DisplayHeight(display, screen);
    if (!XTestQueryExtension(display, &event, &error, &major, &minor)) {
      XCloseDisplay(display); display = nullptr;
      throw std::runtime_error("input requires the XTest extension");
    }
    width = uint16_t(root_width); height = uint16_t(root_height);
    findSpares();
    findModifiers();
    worker = std::thread([this] { run(); });
  }
  ~X11Input() override {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    wake.notify_all();
    if (worker.joinable()) worker.join();
    XCloseDisplay(display);
  }
  std::pair<uint16_t, uint16_t> dimensions() const override { return {width, height}; }
  const char* name() const override { return "x11"; }
  std::optional<NativeKey> nativeKey(uint16_t usage) const override {
    const int keycode = hidKeycode(usage);
    if (!keycode) return std::nullopt;
    return NativeKey(keycode + 8);
  }
  bool typeText(uint32_t codepoint) override {
    const KeySym symbol = textKeysym(codepoint);
    if (symbol == NoSymbol || (spares.empty() && !layout.count(symbol))) return false;
    InputJob job{InputJob::Kind::text};
    job.codepoint = codepoint;
    post(job);
    return true;
  }
  void pressKey(NativeKey key) override {
    InputJob job{InputJob::Kind::key};
    job.code = key; job.press = true;
    post(job);
  }
  void releaseKey(NativeKey key) override {
    InputJob job{InputJob::Kind::key};
    job.code = key;
    post(job);
  }
  void pressButton(unsigned button) override {
    InputJob job{InputJob::Kind::button};
    job.number = button; job.press = true;
    post(job);
  }
  void releaseButton(unsigned button) override {
    InputJob job{InputJob::Kind::button};
    job.number = button;
    post(job);
  }
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
  void post(InputJob job) {
    { std::lock_guard<std::mutex> lock(mutex); queue.post(std::move(job)); }
    wake.notify_one();
  }
  void run() {
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
    for (const auto key : held) XTestFakeKeyEvent(display, key, False, CurrentTime);
    held.clear();
    XSync(display, False);
    pace(lastTap + spareReuse);
    restoreSpares();
    XSync(display, False);
  }
  void apply(const InputJob& job) {
    switch (job.kind) {
      case InputJob::Kind::key:
        if (job.press) held.insert(job.code); else held.erase(job.code);
        XTestFakeKeyEvent(display, job.code, job.press, CurrentTime);
        break;
      case InputJob::Kind::text: type(job.codepoint); break;
      case InputJob::Kind::button: XTestFakeButtonEvent(display, job.number, job.press, CurrentTime); break;
      case InputJob::Kind::motion: XTestFakeMotionEvent(display, DefaultScreen(display), job.x, job.y, CurrentTime); break;
      case InputJob::Kind::scroll: wheel(job.number, job.notches); break;
      case InputJob::Kind::locks: XkbLockModifiers(display, XkbUseCoreKbd, LockMask, 0); break;
      case InputJob::Kind::flush: XFlush(display); break;
      case InputJob::Kind::fence: XSync(display, False); job.complete(); break;
    }
  }
  void type(uint32_t codepoint) {
    const KeySym symbol = textKeysym(codepoint);
    for (auto& spare : spares) {
      if (spare.symbol != symbol) continue;
      tap(spare);
      return;
    }
    const KeyCode found = XKeysymToKeycode(display, symbol);
    if (found && !held.count(found) && XkbKeycodeToKeysym(display, found, 0, 0) == symbol) {
      tapKey(found);
      return;
    }
    Spare* spare = nullptr;
    for (auto& candidate : spares) if (!spare || candidate.used < spare->used) spare = &candidate;
    if (!spare) return;
    pace(spare->tapped + spareReuse);
    bind(*spare, symbol);
    tap(*spare);
  }
  void tap(Spare& spare) {
    tapKey(spare.code);
    spare.used = ++typed;
    spare.tapped = lastTap = std::chrono::steady_clock::now();
  }
  /// Taps code with held modifiers lifted for the tap and pressed again right after.
  void tapKey(KeyCode code) {
    std::vector<KeyCode> lifted;
    for (const auto modifier : held)
      if (modifier != code && modifiers.count(modifier)) lifted.push_back(modifier);
    for (const auto modifier : lifted) XTestFakeKeyEvent(display, modifier, False, CurrentTime);
    XTestFakeKeyEvent(display, code, True, CurrentTime);
    XTestFakeKeyEvent(display, code, False, CurrentTime);
    for (auto it = lifted.rbegin(); it != lifted.rend(); ++it) XTestFakeKeyEvent(display, *it, True, CurrentTime);
  }
  void pace(TimePoint ready) {
    const auto now = std::chrono::steady_clock::now();
    if (ready > now) std::this_thread::sleep_for(ready - now);
  }
  void wheel(unsigned axis, int notches) {
    const unsigned button = axis == 0 ? (notches > 0 ? 5 : 4) : (notches > 0 ? 7 : 6);
    for (int n = 0; n < (notches < 0 ? -notches : notches); ++n) {
      XTestFakeButtonEvent(display, button, True, CurrentTime);
      XTestFakeButtonEvent(display, button, False, CurrentTime);
    }
  }
  void bind(Spare& spare, KeySym symbol) {
    pace(bound + spareBind);
    std::vector<KeySym> symbols(size_t(columns), symbol);
    XChangeKeyboardMapping(display, spare.code, columns, symbols.data(), 1);
    spare.symbol = symbol;
    bound = std::chrono::steady_clock::now();
  }
  void restoreSpares() {
    for (auto& spare : spares) unbind(spare);
    bound = std::chrono::steady_clock::now();
  }
  void unbind(Spare& spare) {
    if (spare.symbol == NoSymbol) return;
    std::vector<KeySym> symbols(size_t(columns), NoSymbol);
    XChangeKeyboardMapping(display, spare.code, columns, symbols.data(), 1);
    spare.symbol = NoSymbol;
  }
  void findModifiers() {
    XModifierKeymap* map = XGetModifierMapping(display);
    if (!map) return;
    for (int index = 0; index < 8 * map->max_keypermod; ++index)
      if (const KeyCode code = map->modifiermap[index]) modifiers.insert(code);
    XFreeModifiermap(map);
  }
  void findSpares() {
    int min = 0, max = 0, count = 0;
    XDisplayKeycodes(display, &min, &max);
    if (max < min) return;
    KeySym* keysyms = XGetKeyboardMapping(display, KeyCode(min), max - min + 1, &count);
    if (!keysyms || count < 1) { if (keysyms) XFree(keysyms); return; }
    columns = count;
    for (int index = 0; index <= max - min; ++index) {
      const KeySym symbol = keysyms[index * count];
      if (symbol != NoSymbol) { layout.emplace(symbol, KeyCode(min + index)); continue; }
      bool empty = true;
      for (int column = 0; column < count; ++column)
        if (keysyms[index * count + column] != NoSymbol) { empty = false; break; }
      if (empty && spares.size() < spareCount) spares.push_back(Spare{KeyCode(min + index), NoSymbol, 0, {}});
    }
    XFree(keysyms);
  }
};
}  // namespace
namespace x11 {
std::unique_ptr<InputBackend> makeInputBackend() {
  return std::make_unique<X11Input>();
}
}
}  // namespace relay
