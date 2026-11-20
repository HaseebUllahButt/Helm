#pragma once
#include <cstdint>

namespace relay {
#ifdef _WIN32
/// A manual-reset event HANDLE that a capture source sets when it may have new damage and resets in drainDamage().
using WaitHandle = void*;
#else
/// A file descriptor that polls readable when a capture source may have new damage.
using WaitHandle = int;
#endif
/// Reports whether a capture source returned a usable handle.
inline bool validWaitHandle(WaitHandle handle) {
#ifdef _WIN32
  return handle != nullptr && handle != reinterpret_cast<void*>(-1);
#else
  return handle >= 0;
#endif
}
/// A flag that another thread sets to interrupt a blocked wait(); it also satisfies the WaitHandle contract.
class Wake {
 public:
  Wake();
  ~Wake();
  Wake(const Wake&) = delete;
  Wake& operator=(const Wake&) = delete;
  bool valid() const;
  void signal();
  /// Clears the flag and reports whether it was set.
  bool consume();
  WaitHandle handle() const { return handle_; }
 private:
  WaitHandle handle_;
#if !defined(_WIN32) && !defined(__linux__)
  int write_handle_ = -1;
#endif
};
struct WaitReady { bool source = false, wake = false; };
/// Blocks until the source or wake is ready or timeout_ns passes; a negative timeout waits indefinitely.
WaitReady wait(WaitHandle source, Wake& wake, int64_t timeout_ns);
}
