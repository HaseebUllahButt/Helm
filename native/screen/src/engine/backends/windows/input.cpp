#include "core/input.hpp"
#include "backends/linux/keycodes.hpp"
#include "backends/windows/output.hpp"
#include <algorithm>
#include <condition_variable>
#include <mutex>
#include <set>
#include <stdexcept>
#include <thread>
#include <vector>

namespace relay {
namespace {
constexpr NativeKey extended = 0x100, virtualKey = 0x200;
/// Set-1 scan code, with the extended flag, for an evdev keycode; Pause and Num Lock use virtual keys.
NativeKey scanCode(int keycode) {
  if (keycode == 69) return virtualKey | VK_NUMLOCK;
  if (keycode == 119) return virtualKey | VK_PAUSE;
  if (keycode > 0 && keycode <= 88) return NativeKey(keycode);
  if (keycode >= 183 && keycode <= 193) return NativeKey(0x64 + keycode - 183);
  switch (keycode) {
    case 194: return 0x76;
    case 96: return extended | 0x1c; case 97: return extended | 0x1d; case 98: return extended | 0x35;
    case 99: return extended | 0x37; case 100: return extended | 0x38; case 102: return extended | 0x47;
    case 103: return extended | 0x48; case 104: return extended | 0x49; case 105: return extended | 0x4b;
    case 106: return extended | 0x4d; case 107: return extended | 0x4f; case 108: return extended | 0x50;
    case 109: return extended | 0x51; case 110: return extended | 0x52; case 111: return extended | 0x53;
    case 117: return 0x59; case 125: return extended | 0x5b; case 126: return extended | 0x5c;
    case 139: return extended | 0x5d;
    default: return 0;
  }
}
const std::set<NativeKey> modifierKeys = {0x1d, extended | 0x1d, 0x2a, 0x36, 0x38, extended | 0x38,
                                          extended | 0x5b, extended | 0x5c};
INPUT keyInput(NativeKey key, bool press) {
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  if (key & virtualKey) {
    input.ki.wVk = WORD(key & 0xff);
  } else {
    input.ki.wScan = WORD(key & 0xff);
    input.ki.dwFlags = KEYEVENTF_SCANCODE | ((key & extended) ? KEYEVENTF_EXTENDEDKEY : 0);
  }
  if (!press) input.ki.dwFlags |= KEYEVENTF_KEYUP;
  return input;
}
/// Applies queued input with SendInput on one thread attached to the active input desktop.
class WindowsInput final : public InputBackend {
  RECT bounds{};
  int desktopWidth = 0, desktopHeight = 0;
  uint16_t width = 0, height = 0;
  std::set<NativeKey> held;
  mutable std::mutex mutex;
  std::condition_variable wake;
  InputQueue queue;
  bool stopping = false, rejected = false;
  std::thread worker;

 public:
  WindowsInput() {
    const auto display = windows::findOutput();
    bounds = display.bounds;
    desktopWidth = display.width();
    desktopHeight = display.height();
    const auto size = display.streamSize();
    width = uint16_t(size.first);
    height = uint16_t(size.second);
    worker = std::thread([this] { run(); });
  }
  ~WindowsInput() override {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    wake.notify_all();
    if (worker.joinable()) worker.join();
  }
  std::pair<uint16_t, uint16_t> dimensions() const override { return {width, height}; }
  const char* name() const override { return "windows"; }
  std::optional<NativeKey> nativeKey(uint16_t usage) const override {
    const NativeKey key = scanCode(hidKeycode(usage));
    if (!key) return std::nullopt;
    return key;
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
  void attach() {
    if (HDESK desktop = OpenInputDesktop(0, FALSE, GENERIC_ALL)) {
      SetThreadDesktop(desktop);
      CloseDesktop(desktop);
    }
  }
  void run() {
    attach();
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
    std::vector<INPUT> releases;
    for (const auto key : held) releases.push_back(keyInput(key, false));
    send(releases);
  }
  bool send(std::vector<INPUT>& inputs) {
    if (inputs.empty()) return true;
    if (SendInput(UINT(inputs.size()), inputs.data(), sizeof(INPUT)) == inputs.size()) return true;
    attach();
    return SendInput(UINT(inputs.size()), inputs.data(), sizeof(INPUT)) == inputs.size();
  }
  void apply(const InputJob& job) {
    std::vector<INPUT> inputs;
    switch (job.kind) {
      case InputJob::Kind::key:
        if (job.press) held.insert(job.code); else held.erase(job.code);
        inputs.push_back(keyInput(job.code, job.press));
        break;
      case InputJob::Kind::text: type(job.codepoint, inputs); break;
      case InputJob::Kind::button: inputs.push_back(button(job.number, job.press)); break;
      case InputJob::Kind::motion: inputs.push_back(motion(job.x, job.y)); break;
      case InputJob::Kind::scroll: {
        INPUT input{};
        input.type = INPUT_MOUSE;
        input.mi.dwFlags = job.number == 0 ? MOUSEEVENTF_WHEEL : MOUSEEVENTF_HWHEEL;
        input.mi.mouseData = DWORD(job.number == 0 ? -job.notches * WHEEL_DELTA : job.notches * WHEEL_DELTA);
        inputs.push_back(input);
        break;
      }
      case InputJob::Kind::locks:
        if (GetKeyState(VK_CAPITAL) & 1) {
          inputs.push_back(keyInput(virtualKey | VK_CAPITAL, true));
          inputs.push_back(keyInput(virtualKey | VK_CAPITAL, false));
        }
        break;
      case InputJob::Kind::flush: break;
      case InputJob::Kind::fence:
        if (rejected && job.fence) job.fence->complete(false, job.dropped);
        else job.complete();
        rejected = false;
        return;
    }
    if (!send(inputs)) rejected = true;
  }
  void type(uint32_t codepoint, std::vector<INPUT>& inputs) {
    if (codepoint == '\n' || codepoint == '\t') {
      const NativeKey key = codepoint == '\n' ? 0x1c : 0x0f;
      inputs.push_back(keyInput(key, true));
      inputs.push_back(keyInput(key, false));
      return;
    }
    std::vector<NativeKey> lifted;
    for (const auto key : held) if (modifierKeys.count(key)) lifted.push_back(key);
    for (const auto key : lifted) inputs.push_back(keyInput(key, false));
    if (layoutKey(codepoint, inputs)) {
      for (auto it = lifted.rbegin(); it != lifted.rend(); ++it) inputs.push_back(keyInput(*it, true));
      return;
    }
    wchar_t units[2];
    int count = 1;
    if (codepoint >= 0x10000) {
      units[0] = wchar_t(0xd800 + ((codepoint - 0x10000) >> 10));
      units[1] = wchar_t(0xdc00 + ((codepoint - 0x10000) & 0x3ff));
      count = 2;
    } else {
      units[0] = wchar_t(codepoint);
    }
    for (const bool press : {true, false})
      for (int i = 0; i < count; ++i) {
        INPUT input{};
        input.type = INPUT_KEYBOARD;
        input.ki.wScan = WORD(units[i]);
        input.ki.dwFlags = KEYEVENTF_UNICODE | (press ? 0 : KEYEVENTF_KEYUP);
        inputs.push_back(input);
      }
    for (auto it = lifted.rbegin(); it != lifted.rend(); ++it) inputs.push_back(keyInput(*it, true));
  }
  /// Types codepoint with its key on the foreground window's keyboard layout, if the layout has one.
  bool layoutKey(uint32_t codepoint, std::vector<INPUT>& inputs) {
    if (codepoint > 0xffff) return false;
    const HKL layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), nullptr));
    const SHORT found = VkKeyScanExW(wchar_t(codepoint), layout);
    if (found == -1 || (HIBYTE(found) & ~7)) return false;
    const UINT scan = MapVirtualKeyExW(LOBYTE(found), MAPVK_VK_TO_VSC_EX, layout);
    if (!scan) return false;
    const NativeKey key = (scan & 0xff) | ((scan & 0xff00) == 0xe000 ? extended : 0);
    std::vector<NativeKey> shifts;
    if (HIBYTE(found) & 1) shifts.push_back(0x2a);
    if (HIBYTE(found) & 2) shifts.push_back(0x1d);
    if (HIBYTE(found) & 4) shifts.push_back(0x38);
    for (const auto shift : shifts) inputs.push_back(keyInput(shift, true));
    inputs.push_back(keyInput(key, true));
    inputs.push_back(keyInput(key, false));
    for (auto it = shifts.rbegin(); it != shifts.rend(); ++it) inputs.push_back(keyInput(*it, false));
    return true;
  }
  INPUT button(unsigned number, bool press) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    if (number == 1) input.mi.dwFlags = press ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
    else if (number == 2) input.mi.dwFlags = press ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
    else input.mi.dwFlags = press ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
    return input;
  }
  INPUT motion(int x, int y) {
    const int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int spanX = std::max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1);
    const int spanY = std::max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1);
    INPUT input{};
    input.type = INPUT_MOUSE;
    const int64_t px = bounds.left + (int64_t(2 * x + 1) * desktopWidth) / (2 * width) - left;
    const int64_t py = bounds.top + (int64_t(2 * y + 1) * desktopHeight) / (2 * height) - top;
    input.mi.dx = LONG((px * 65535 + spanX / 2) / spanX);
    input.mi.dy = LONG((py * 65535 + spanY / 2) / spanY);
    input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    return input;
  }
};
}  // namespace
namespace windows {
std::unique_ptr<InputBackend> makeInputBackend() { return std::make_unique<WindowsInput>(); }
}
}  // namespace relay
