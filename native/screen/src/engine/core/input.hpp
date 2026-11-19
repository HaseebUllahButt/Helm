#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <optional>
#include <set>
#include <utility>

namespace relay {
enum class InputStatus : uint8_t { ok = 0, invalid = 1, unsupported = 2 };
struct InputEvent {
  uint8_t type = 0, reserved = 0;
  uint16_t code = 0;
  int32_t value = 0;
  uint16_t x = 0, y = 0, buttons = 0, modifiers = 0;
};
/// Platform key identifier returned by a backend, tracked by InputController.
using NativeKey = uint32_t;
/// Completion notice for posted input, called by the backend on its own thread.
class InputFence {
 public:
  virtual ~InputFence() = default;
  /// Runs once after every action posted before the fence, reporting whether all of them applied and how many records were dropped.
  virtual void complete(bool applied, size_t dropped) = 0;
};
/// One queued backend action; the actions posted for a single protocol record form one queue unit.
struct InputJob {
  enum class Kind : uint8_t { key, text, button, motion, scroll, locks, flush, fence } kind = Kind::flush;
  uint32_t code = 0, codepoint = 0;
  unsigned number = 0;
  int x = 0, y = 0, notches = 0;
  bool press = false;
  size_t dropped = 0;
  std::shared_ptr<InputFence> fence;
  InputJob() = default;
  explicit InputJob(Kind value) : kind(value) {}
  /// Completes the fence after the work before it reached the platform, reporting the records dropped from before it.
  void complete() const { if (fence) fence->complete(dropped == 0, dropped); }
};
/// Backend work queue that counts one protocol record as one unit however many actions it posts; not thread safe.
class InputQueue {
 public:
  void post(InputJob job);
  bool empty() const;
  /// Removes the next action, closing the record unit whose trailing flush it applies.
  InputJob take();
  /// Records queued, one per protocol record.
  size_t pending() const;
  /// Drops queued text and moves as not applied, leaving the fences that covered them for the worker to complete.
  void cancel();

 private:
  struct Entry {
    InputJob job;
    uint64_t unit = 0;
  };
  std::deque<Entry> queue;
  uint64_t next = 0, open = 0;
  size_t records = 0;
};
/// Platform primitives only; protocol rules, coordinate mapping and held input live in InputController.
class InputBackend {
 public:
  virtual ~InputBackend() = default;
  /// Native key for a HID usage, or nothing when the backend cannot produce one.
  virtual std::optional<NativeKey> nativeKey(uint16_t usage) const = 0;
  virtual void pressKey(NativeKey key) = 0;
  virtual void releaseKey(NativeKey key) = 0;
  /// Types one Unicode scalar value without changing held keys; false when the platform cannot produce it.
  virtual bool typeText(uint32_t codepoint) = 0;
  virtual void pressButton(unsigned button) = 0;
  virtual void releaseButton(unsigned button) = 0;
  virtual void move(int x, int y) = 0;
  /// Scrolls notches on axis 0 (vertical) or 1 (horizontal); positive means down or right.
  virtual void scroll(unsigned axis, int notches) = 0;
  /// Turns lock keys off, currently Caps Lock.
  virtual void resetLocks() = 0;
  /// Completes mark after every event posted so far, without waiting for it.
  virtual void fence(std::shared_ptr<InputFence> mark) = 0;
  /// Records posted but not yet applied, so a caller can refuse a batch before it queues behind them.
  virtual size_t pending() const = 0;
  /// Drops queued text and moves as not applied, keeping key and button releases and counting each dropped record once.
  virtual void cancel() = 0;
  virtual void flush() = 0;
  virtual std::pair<uint16_t, uint16_t> dimensions() const = 0;
  virtual const char* name() const = 0;
};
/// Records allowed to wait in a backend queue; a batch that would exceed it is refused before any of it is queued.
constexpr size_t max_queued_events = 1024;
/** Validates protocol events, maps pointer coordinates and dedupes held input for one backend. */
class InputController {
 public:
  explicit InputController(std::unique_ptr<InputBackend> source);
  ~InputController();
  InputController(const InputController&) = delete;
  InputController& operator=(const InputController&) = delete;
  InputStatus apply(const InputEvent& event);
  void releaseAll();
  void resetLocks();
  /// Completes mark once every event applied so far has reached the backend.
  void fence(std::shared_ptr<InputFence> mark);
  /// Records posted but not yet applied.
  size_t pending() const;
  /// Drops queued text and moves, so their fences complete as not applied.
  void cancel();
  std::pair<uint16_t, uint16_t> dimensions() const;
  const char* name() const;

 private:
  std::unique_ptr<InputBackend> backend;
  std::set<NativeKey> keys;
  std::set<unsigned> buttons;
};
}  // namespace relay
