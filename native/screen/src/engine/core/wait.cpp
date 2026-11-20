#include "wait.hpp"
#include <cerrno>
#include <ctime>
#include <stdexcept>

#ifdef _WIN32
#include <windows.h>
#elif defined(__linux__)
#include <poll.h>
#include <sys/eventfd.h>
#include <unistd.h>
#else
#include <climits>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#endif

namespace relay {
#ifdef _WIN32
Wake::Wake() : handle_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
Wake::~Wake() { if (handle_) CloseHandle(handle_); }
bool Wake::valid() const { return handle_ != nullptr; }
void Wake::signal() { if (handle_) SetEvent(handle_); }
bool Wake::consume() {
  if (!handle_ || WaitForSingleObject(handle_, 0) != WAIT_OBJECT_0) return false;
  ResetEvent(handle_);
  return true;
}
WaitReady wait(WaitHandle source, Wake& wake, int64_t timeout_ns) {
  thread_local HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                                      TIMER_ALL_ACCESS);
  HANDLE handles[3] = {source, wake.handle(), timer};
  DWORD count = 2, limit = INFINITE;
  if (timeout_ns >= 0) {
    if (timer) {
      LARGE_INTEGER due;
      due.QuadPart = -(timeout_ns / 100);
      if (!SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE)) throw std::runtime_error("capture timer failed");
      count = 3;
    } else {
      limit = DWORD((timeout_ns + 999999) / 1000000);
    }
  }
  const DWORD result = WaitForMultipleObjects(count, handles, FALSE, limit);
  if (result == WAIT_FAILED) throw std::runtime_error("capture wait failed");
  WaitReady ready;
  ready.source = WaitForSingleObject(source, 0) == WAIT_OBJECT_0;
  ready.wake = result == WAIT_OBJECT_0 + 1;
  return ready;
}
#elif defined(__linux__)
Wake::Wake() : handle_(eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK)) {}
Wake::~Wake() { if (handle_ >= 0) close(handle_); }
bool Wake::valid() const { return handle_ >= 0; }
void Wake::signal() {
  const uint64_t one = 1;
  if (handle_ >= 0) { const auto result = write(handle_, &one, sizeof(one)); (void)result; }
}
bool Wake::consume() {
  uint64_t value;
  return handle_ >= 0 && read(handle_, &value, sizeof(value)) == sizeof(value);
}
WaitReady wait(WaitHandle source, Wake& wake, int64_t timeout_ns) {
  timespec timeout{};
  const timespec* timeout_ptr = nullptr;
  if (timeout_ns >= 0) {
    timeout = {static_cast<time_t>(timeout_ns / 1000000000), static_cast<long>(timeout_ns % 1000000000)};
    timeout_ptr = &timeout;
  }
  pollfd descriptors[2] = {{source, POLLIN, 0}, {wake.handle(), POLLIN, 0}};
  if (ppoll(descriptors, 2, timeout_ptr, nullptr) < 0) {
    if (errno == EINTR) return {};
    throw std::runtime_error("capture ppoll failed");
  }
  if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) throw std::runtime_error("capture source connection closed");
  return {bool(descriptors[0].revents & POLLIN), bool(descriptors[1].revents & POLLIN)};
}
#else
Wake::Wake() : handle_(-1) {
  int descriptors[2] = {-1, -1};
  if (pipe(descriptors) != 0) return;
  for (const int fd : descriptors) {
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    fcntl(fd, F_SETFD, fcntl(fd, F_GETFD) | FD_CLOEXEC);
  }
  handle_ = descriptors[0];
  write_handle_ = descriptors[1];
}
Wake::~Wake() {
  if (handle_ >= 0) close(handle_);
  if (write_handle_ >= 0) close(write_handle_);
}
bool Wake::valid() const { return handle_ >= 0 && write_handle_ >= 0; }
void Wake::signal() {
  const char one = 1;
  if (write_handle_ >= 0) { const auto result = write(write_handle_, &one, sizeof(one)); (void)result; }
}
bool Wake::consume() {
  if (handle_ < 0) return false;
  char buffer[64];
  bool any = false;
  for (;;) {
    const auto count = read(handle_, buffer, sizeof(buffer));
    if (count > 0) { any = true; continue; }
    if (count < 0 && errno == EINTR) continue;
    return any;
  }
}
WaitReady wait(WaitHandle source, Wake& wake, int64_t timeout_ns) {
  int timeout_ms = -1;
  if (timeout_ns >= 0) {
    const int64_t milliseconds = timeout_ns / 1000000 + (timeout_ns % 1000000 != 0 ? 1 : 0);
    timeout_ms = milliseconds > INT_MAX ? INT_MAX : static_cast<int>(milliseconds);
  }
  pollfd descriptors[2] = {{source, POLLIN, 0}, {wake.handle(), POLLIN, 0}};
  if (poll(descriptors, 2, timeout_ms) < 0) {
    if (errno == EINTR) return {};
    throw std::runtime_error("capture poll failed");
  }
  if (descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) throw std::runtime_error("capture source connection closed");
  return {bool(descriptors[0].revents & POLLIN), bool(descriptors[1].revents & POLLIN)};
}
#endif
}
