#include "backends/linux/keycodes.hpp"
#include "backends/linux/wayland/keymap.hpp"
#include "backends/linux/wayland/wayland.hpp"
#include "core/input.hpp"
#include <linux/input-event-codes.h>
#include <poll.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <xkbcommon/xkbcommon.h>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <exception>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace relay::wayland {
namespace {
using Seat = std::unique_ptr<wl_seat, decltype(&wl_seat_destroy)>;
using Keyboard = std::unique_ptr<wl_keyboard, decltype(&wl_keyboard_destroy)>;
using Registry = std::unique_ptr<wl_registry, decltype(&wl_registry_destroy)>;
using VirtualKeyboard = std::unique_ptr<zwp_virtual_keyboard_v1, decltype(&zwp_virtual_keyboard_v1_destroy)>;
using VirtualPointer = std::unique_ptr<zwlr_virtual_pointer_v1, decltype(&zwlr_virtual_pointer_v1_destroy)>;

class Mapping {
 public:
  Mapping(int fd, size_t size) : size_(size), data_(::mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0)) {
    if (data_ == MAP_FAILED) throw std::runtime_error("Cannot map the Wayland keyboard keymap");
  }
  ~Mapping() { ::munmap(data_, size_); }
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  const char* data() const { return static_cast<const char*>(data_); }

 private:
  size_t size_;
  void* data_;
};

struct SeatWatch {
  bool hasKeyboard = false;
};

struct SeatRegistry {
  Seat seat{nullptr, wl_seat_destroy};
  SeatWatch* watch = nullptr;
  bool failed = false;
};

struct KeymapCapture {
  std::string text;
  std::exception_ptr error;
  bool received = false;
};

void seatCapabilities(void* data, wl_seat*, uint32_t capabilities) {
  static_cast<SeatWatch*>(data)->hasKeyboard = capabilities & WL_SEAT_CAPABILITY_KEYBOARD;
}

void seatName(void*, wl_seat*, const char*) {}

const wl_seat_listener seatListener = {seatCapabilities, seatName};

void registryGlobal(void* data, wl_registry* registry, uint32_t name, const char* interface, uint32_t version) {
  auto* state = static_cast<SeatRegistry*>(data);
  if (state->seat || std::strcmp(interface, wl_seat_interface.name) != 0) return;
  state->seat.reset(static_cast<wl_seat*>(wl_registry_bind(registry, name, &wl_seat_interface,
                                                          std::min(version, 1u))));
  if (!state->seat || wl_seat_add_listener(state->seat.get(), &seatListener, state->watch) < 0)
    state->failed = true;
}

void registryGlobalRemove(void*, wl_registry*, uint32_t) {}

const wl_registry_listener registryListener = {registryGlobal, registryGlobalRemove};

void keyboardKeymap(void* data, wl_keyboard*, uint32_t format, int32_t fd, uint32_t size) {
  auto* capture = static_cast<KeymapCapture*>(data);
  FileDescriptor keymapFd(fd);
  try {
    if (format != WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 || fd < 0 || !size)
      throw std::runtime_error("Wayland seat did not provide an XKB v1 keyboard keymap");
    struct stat status {};
    if (::fstat(keymapFd.get(), &status) < 0 || status.st_size < 0 || uint64_t(status.st_size) < size)
      throw std::runtime_error("Wayland keyboard keymap fd is shorter than its advertised size");
    Mapping mapping(keymapFd.get(), size);
    const char* end = static_cast<const char*>(std::memchr(mapping.data(), '\0', size));
    capture->text.assign(mapping.data(), end ? size_t(end - mapping.data()) : size_t(size));
    if (capture->text.empty()) throw std::runtime_error("Wayland seat provided an empty keyboard keymap");
    capture->received = true;
  } catch (...) {
    capture->error = std::current_exception();
  }
}

void keyboardEnter(void*, wl_keyboard*, uint32_t, wl_surface*, wl_array*) {}
void keyboardLeave(void*, wl_keyboard*, uint32_t, wl_surface*) {}
void keyboardKey(void*, wl_keyboard*, uint32_t, uint32_t, uint32_t, uint32_t) {}
void keyboardModifiers(void*, wl_keyboard*, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t) {}
void keyboardRepeatInfo(void*, wl_keyboard*, int32_t, int32_t) {}

const wl_keyboard_listener keyboardListener = {
  keyboardKeymap, keyboardEnter, keyboardLeave, keyboardKey, keyboardModifiers, keyboardRepeatInfo
};

uint32_t linuxButton(unsigned button) {
  switch (button) {
    case 1: return BTN_LEFT;
    case 2: return BTN_MIDDLE;
    case 3: return BTN_RIGHT;
    default: throw std::runtime_error("Unsupported Wayland pointer button");
  }
}

std::set<uint32_t> findModifierKeys(xkb_keymap* keymap) {
  std::set<uint32_t> result;
  const auto modifiers = xkb_keymap_num_mods(keymap);
  for (xkb_keycode_t key = xkb_keymap_min_keycode(keymap); key <= xkb_keymap_max_keycode(keymap); ++key) {
    if (key < 8) continue;
    XkbState state(xkb_state_new(keymap));
    if (!state) throw std::runtime_error("Cannot create XKB state to identify modifiers");
    bool modifier = false;
    for (const auto direction : {XKB_KEY_DOWN, XKB_KEY_UP}) {
      xkb_state_update_key(state.get(), key, direction);
      for (xkb_mod_index_t index = 0; index < modifiers; ++index)
        if (xkb_state_mod_index_is_active(state.get(), index, XKB_STATE_MODS_EFFECTIVE) > 0) {
          modifier = true;
          break;
        }
      if (modifier) break;
    }
    if (modifier) result.insert(key - 8);
  }
  return result;
}

bool flushDisplay(wl_display* display) {
  for (;;) {
    if (wl_display_flush(display) >= 0) return true;
    if (errno == EINTR) continue;
    if (errno != EAGAIN && errno != EWOULDBLOCK) return false;
    const int fd = wl_display_get_fd(display);
    if (fd < 0) return false;
    pollfd writable{fd, POLLOUT, 0};
    int ready;
    do { ready = ::poll(&writable, 1, 5000); } while (ready < 0 && errno == EINTR);
    if (ready <= 0 || (writable.revents & (POLLERR | POLLHUP | POLLNVAL))) return false;
  }
}
}

class WaylandInput final : public InputBackend {
 public:
  WaylandInput() {
    worker_ = std::thread([this] { run(); });
    std::unique_lock<std::mutex> lock(mutex_);
    wake_.wait(lock, [this] { return startupDone_; });
    const auto error = startupError_;
    lock.unlock();
    if (error) {
      if (worker_.joinable()) worker_.join();
      std::rethrow_exception(error);
    }
  }

  ~WaylandInput() override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopping_ = true;
    }
    wake_.notify_all();
    if (worker_.joinable()) worker_.join();
  }

  std::optional<NativeKey> nativeKey(uint16_t usage) const override {
    const int keycode = hidKeycode(usage);
    if (!keycode) return std::nullopt;
    return NativeKey(keycode);
  }

  void pressKey(NativeKey key) override {
    InputJob job{InputJob::Kind::key};
    job.code = key;
    job.press = true;
    post(std::move(job));
  }

  void releaseKey(NativeKey key) override {
    InputJob job{InputJob::Kind::key};
    job.code = key;
    post(std::move(job));
  }

  bool typeText(uint32_t codepoint) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_ || workerFailed_ || !xkb_utf32_to_keysym(codepoint)) return false;
      InputJob job{InputJob::Kind::text};
      job.codepoint = codepoint;
      queue_.post(std::move(job));
    }
    wake_.notify_one();
    return true;
  }

  void pressButton(unsigned button) override {
    InputJob job{InputJob::Kind::button};
    job.number = button;
    job.press = true;
    post(std::move(job));
  }

  void releaseButton(unsigned button) override {
    InputJob job{InputJob::Kind::button};
    job.number = button;
    post(std::move(job));
  }

  void move(int x, int y) override {
    InputJob job{InputJob::Kind::motion};
    job.x = x;
    job.y = y;
    post(std::move(job));
  }

  void scroll(unsigned axis, int notches) override {
    InputJob job{InputJob::Kind::scroll};
    job.number = axis;
    job.notches = notches;
    post(std::move(job));
  }

  void resetLocks() override { post(InputJob{InputJob::Kind::locks}); }

  void fence(std::shared_ptr<InputFence> mark) override {
    InputJob job{InputJob::Kind::fence};
    job.fence = std::move(mark);
    post(std::move(job));
  }

  size_t pending() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.pending();
  }

  void cancel() override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      queue_.cancel();
    }
    wake_.notify_one();
  }

  void flush() override { post(InputJob{InputJob::Kind::flush}); }

  std::pair<uint16_t, uint16_t> dimensions() const override { return {width_, height_}; }
  const char* name() const override { return "wayland"; }

 private:
  struct Masks {
    xkb_mod_mask_t latched = 0;
    xkb_mod_mask_t locked = 0;
    xkb_layout_index_t latchedLayout = 0;
    xkb_layout_index_t lockedLayout = 0;
  };

  std::unique_ptr<Connection> connection_;
  Seat seat_{nullptr, wl_seat_destroy};
  VirtualKeyboard keyboard_{nullptr, zwp_virtual_keyboard_v1_destroy};
  VirtualPointer pointer_{nullptr, zwlr_virtual_pointer_v1_destroy};
  XkbContext xkbContext_;
  XkbState xkbState_;
  std::unique_ptr<Keymap> keymap_;
  SeatWatch seatWatch_;
  std::set<uint32_t> held_;
  std::set<uint32_t> modifierKeys_;
  uint16_t width_ = 0;
  uint16_t height_ = 0;
  mutable std::mutex mutex_;
  std::condition_variable wake_;
  InputQueue queue_;
  bool stopping_ = false;
  bool workerFailed_ = false;
  bool startupDone_ = false;
  std::exception_ptr startupError_;
  std::thread worker_;

  void post(InputJob job) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_) return;
      queue_.post(std::move(job));
    }
    wake_.notify_one();
  }

  void initialize() {
    connection_ = std::make_unique<Connection>();
    if (!connection_->virtualKeyboardManager)
      throw std::runtime_error("Wayland input requires zwp_virtual_keyboard_manager_v1");
    if (!connection_->virtualPointerManager)
      throw std::runtime_error("Wayland input requires zwlr_virtual_pointer_manager_v1 version 2");
    if (connection_->width < 1 || connection_->height < 1 ||
        connection_->width > std::numeric_limits<uint16_t>::max() ||
        connection_->height > std::numeric_limits<uint16_t>::max())
      throw std::runtime_error("Selected Wayland output has invalid dimensions");
    width_ = uint16_t(connection_->width);
    height_ = uint16_t(connection_->height);
    bindSeat();
    const std::string base = seatWatch_.hasKeyboard ? currentSeatKeymap() : defaultKeymap();
    keymap_ = std::make_unique<Keymap>(base);
    xkbContext_.reset(xkb_context_new(XKB_CONTEXT_NO_FLAGS));
    if (!xkbContext_) throw std::runtime_error("libxkbcommon context unavailable");
    keyboard_.reset(zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(
      connection_->virtualKeyboardManager, seat_.get()));
    if (!keyboard_) throw std::runtime_error("Cannot create Wayland virtual keyboard");
    pointer_.reset(zwlr_virtual_pointer_manager_v1_create_virtual_pointer_with_output(
      connection_->virtualPointerManager, seat_.get(), connection_->output));
    if (!pointer_) throw std::runtime_error("Cannot create output-bound Wayland virtual pointer");
    uploadKeymap(keymap_->text());
    if (!flushDisplay(connection_->display) || wl_display_roundtrip(connection_->display) < 0)
      throw std::runtime_error("Wayland input device registration failed");
  }

  void bindSeat() {
    Registry registry(wl_display_get_registry(connection_->display), wl_registry_destroy);
    if (!registry) throw std::runtime_error("Could not get Wayland input registry");
    SeatRegistry state;
    state.watch = &seatWatch_;
    if (wl_registry_add_listener(registry.get(), &registryListener, &state) < 0)
      throw std::runtime_error("Could not listen to Wayland input registry");
    if (wl_display_roundtrip(connection_->display) < 0)
      throw std::runtime_error("Wayland input registry roundtrip failed");
    if (state.failed) throw std::runtime_error("Could not listen to Wayland seat capabilities");
    if (wl_display_roundtrip(connection_->display) < 0)
      throw std::runtime_error("Wayland seat capability roundtrip failed");
    if (state.failed) throw std::runtime_error("Could not listen to Wayland seat capabilities");
    if (!state.seat) throw std::runtime_error("No Wayland seat available for input");
    seat_ = std::move(state.seat);
  }

  std::string currentSeatKeymap() {
    Keyboard source(wl_seat_get_keyboard(seat_.get()), wl_keyboard_destroy);
    if (!source) throw std::runtime_error("Could not create wl_keyboard to read the seat keymap");
    KeymapCapture capture;
    if (wl_keyboard_add_listener(source.get(), &keyboardListener, &capture) < 0)
      throw std::runtime_error("Could not listen to the Wayland seat keymap");
    if (wl_display_roundtrip(connection_->display) < 0)
      throw std::runtime_error("Wayland keyboard keymap roundtrip failed");
    if (capture.error) std::rethrow_exception(capture.error);
    if (!capture.received) throw std::runtime_error("Wayland seat did not send a keyboard keymap");
    return std::move(capture.text);
  }

  void uploadKeymap(const std::string& text) {
    XkbKeymap nextKeymap(xkb_keymap_new_from_string(xkbContext_.get(), text.c_str(),
                                                     XKB_KEYMAP_FORMAT_TEXT_V1,
                                                     XKB_KEYMAP_COMPILE_NO_FLAGS));
    if (!nextKeymap) throw std::runtime_error("libxkbcommon cannot compile the uploaded keymap");
    XkbState nextState(xkb_state_new(nextKeymap.get()));
    if (!nextState) throw std::runtime_error("libxkbcommon cannot create state for the uploaded keymap");
    Masks previous;
    const bool hadState = bool(xkbState_);
    if (hadState) {
      previous.latched = xkb_state_serialize_mods(xkbState_.get(), XKB_STATE_MODS_LATCHED);
      previous.locked = xkb_state_serialize_mods(xkbState_.get(), XKB_STATE_MODS_LOCKED);
      previous.latchedLayout = xkb_state_serialize_layout(xkbState_.get(), XKB_STATE_LAYOUT_LATCHED);
      previous.lockedLayout = xkb_state_serialize_layout(xkbState_.get(), XKB_STATE_LAYOUT_LOCKED);
    }
    for (const auto key : held_) xkb_state_update_key(nextState.get(), key + 8, XKB_KEY_DOWN);
    if (hadState) {
      xkb_state_update_mask(nextState.get(),
                            xkb_state_serialize_mods(nextState.get(), XKB_STATE_MODS_DEPRESSED),
                            previous.latched, previous.locked,
                            xkb_state_serialize_layout(nextState.get(), XKB_STATE_LAYOUT_DEPRESSED),
                            previous.latchedLayout, previous.lockedLayout);
    } else {
      modifierKeys_ = findModifierKeys(nextKeymap.get());
    }
    std::string contents = text;
    contents.push_back('\0');
    if (contents.size() > std::numeric_limits<uint32_t>::max())
      throw std::runtime_error("Wayland keyboard keymap is too large");
    auto fd = createMemfd("relay-keymap");
    if (fd.get() < 0) throw std::runtime_error("Cannot create Wayland keyboard keymap memfd");
    size_t written = 0;
    while (written < contents.size()) {
      const ssize_t count = ::write(fd.get(), contents.data() + written, contents.size() - written);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) throw std::runtime_error("Cannot write Wayland keyboard keymap memfd");
      written += size_t(count);
    }
    zwp_virtual_keyboard_v1_keymap(keyboard_.get(), WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1,
                                   fd.get(), uint32_t(contents.size()));
    xkbState_ = std::move(nextState);
    sendModifiers();
  }

  void sendModifiers() {
    zwp_virtual_keyboard_v1_modifiers(
      keyboard_.get(),
      uint32_t(xkb_state_serialize_mods(xkbState_.get(), XKB_STATE_MODS_DEPRESSED)),
      uint32_t(xkb_state_serialize_mods(xkbState_.get(), XKB_STATE_MODS_LATCHED)),
      uint32_t(xkb_state_serialize_mods(xkbState_.get(), XKB_STATE_MODS_LOCKED)),
      uint32_t(xkb_state_serialize_layout(xkbState_.get(), XKB_STATE_LAYOUT_EFFECTIVE)));
  }

  void emitKey(uint32_t key, bool press) {
    zwp_virtual_keyboard_v1_key(keyboard_.get(), timestamp(), key,
                                press ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
    xkb_state_update_key(xkbState_.get(), key + 8, press ? XKB_KEY_DOWN : XKB_KEY_UP);
    sendModifiers();
  }

  void type(uint32_t key) {
    std::vector<uint32_t> lifted;
    for (const auto held : held_)
      if (held == key || modifierKeys_.count(held)) lifted.push_back(held);
    for (const auto modifier : lifted) emitKey(modifier, false);
    emitKey(key, true);
    emitKey(key, false);
    for (auto modifier = lifted.rbegin(); modifier != lifted.rend(); ++modifier) emitKey(*modifier, true);
  }

  static uint32_t timestamp() {
    const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
    return uint32_t(milliseconds);
  }

  bool apply(const InputJob& job, bool previouslyFailed) {
    switch (job.kind) {
      case InputJob::Kind::key:
        if (job.press) held_.insert(job.code); else held_.erase(job.code);
        emitKey(job.code, job.press);
        break;
      case InputJob::Kind::text: {
        bool changed = false;
        const uint32_t key = keymap_->assign(job.codepoint, changed);
        if (!key) throw std::runtime_error("Wayland keymap could not assign the queued codepoint");
        if (changed) uploadKeymap(keymap_->text());
        type(key);
        break;
      }
      case InputJob::Kind::button:
        zwlr_virtual_pointer_v1_button(pointer_.get(), timestamp(), linuxButton(job.number),
                                       job.press ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
        zwlr_virtual_pointer_v1_frame(pointer_.get());
        break;
      case InputJob::Kind::motion:
        zwlr_virtual_pointer_v1_motion_absolute(pointer_.get(), timestamp(), uint32_t(job.x), uint32_t(job.y),
                                                width_, height_);
        zwlr_virtual_pointer_v1_frame(pointer_.get());
        break;
      case InputJob::Kind::scroll:
        zwlr_virtual_pointer_v1_axis_source(pointer_.get(), WL_POINTER_AXIS_SOURCE_WHEEL);
        zwlr_virtual_pointer_v1_axis_discrete(
          pointer_.get(), timestamp(), job.number == 0 ? WL_POINTER_AXIS_VERTICAL_SCROLL : WL_POINTER_AXIS_HORIZONTAL_SCROLL,
          wl_fixed_from_int(job.notches * 15), job.notches);
        zwlr_virtual_pointer_v1_frame(pointer_.get());
        break;
      case InputJob::Kind::locks:
        xkb_state_update_mask(xkbState_.get(),
                              xkb_state_serialize_mods(xkbState_.get(), XKB_STATE_MODS_DEPRESSED),
                              xkb_state_serialize_mods(xkbState_.get(), XKB_STATE_MODS_LATCHED), 0,
                              xkb_state_serialize_layout(xkbState_.get(), XKB_STATE_LAYOUT_DEPRESSED),
                              xkb_state_serialize_layout(xkbState_.get(), XKB_STATE_LAYOUT_LATCHED),
                              xkb_state_serialize_layout(xkbState_.get(), XKB_STATE_LAYOUT_LOCKED));
        sendModifiers();
        break;
      case InputJob::Kind::flush:
        return flushDisplay(connection_->display);
      case InputJob::Kind::fence:
        if (job.fence) {
          const bool reached = !previouslyFailed && wl_display_roundtrip(connection_->display) >= 0;
          job.fence->complete(reached && job.dropped == 0, job.dropped);
          return reached;
        }
        return !previouslyFailed && wl_display_roundtrip(connection_->display) >= 0;
    }
    return true;
  }

  void cleanup() {
    pointer_.reset();
    keyboard_.reset();
    seat_.reset();
    xkbState_.reset();
    xkbContext_.reset();
    connection_.reset();
  }

  void run() {
    std::exception_ptr error;
    try {
      initialize();
    } catch (...) {
      error = std::current_exception();
      cleanup();
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      startupError_ = error;
      startupDone_ = true;
      if (error) stopping_ = true;
    }
    wake_.notify_all();
    if (error) return;
    bool failed = false;
    bool logged = false;
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      wake_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_) {
        queue_.cancel();
      }
      if (queue_.empty()) break;
      const InputJob job = queue_.take();
      lock.unlock();
      bool success = false;
      try {
        success = apply(job, failed);
      } catch (const std::exception& failure) {
        if (!logged) std::fprintf(stderr, "input worker stopped: %s\n", failure.what());
        logged = true;
      } catch (...) {
        if (!logged) std::fprintf(stderr, "input worker stopped: unknown error\n");
        logged = true;
      }
      lock.lock();
      if (!success) {
        failed = true;
        workerFailed_ = true;
      }
    }
    lock.unlock();
    const std::vector<uint32_t> held(held_.begin(), held_.end());
    for (const auto key : held) emitKey(key, false);
    held_.clear();
    if (connection_) flushDisplay(connection_->display);
    cleanup();
  }
};

std::unique_ptr<InputBackend> makeInputBackend() {
  return std::make_unique<WaylandInput>();
}
}
