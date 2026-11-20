#pragma once

#include <algorithm>
#include <cstdint>

namespace relay {
/** Token bucket pacing captures at the stream rate while allowing a burst of two frames. */
struct CaptureBucket {
  static constexpr int burst = 2;
  int64_t interval_ns = 1, credit_ns = 0, updated_ns = 0;

  /** Starts full at `now_ns`, refilling one token per `frame_interval_ns`. */
  void reset(int64_t now_ns, int64_t frame_interval_ns) {
    interval_ns = std::max<int64_t>(1, frame_interval_ns);
    credit_ns = int64_t(burst) * interval_ns;
    updated_ns = now_ns;
  }
  void refill(int64_t now_ns) {
    if (now_ns <= updated_ns) return;
    credit_ns = std::min(credit_ns + (now_ns - updated_ns), int64_t(burst) * interval_ns);
    updated_ns = now_ns;
  }
  /** Refills to `now_ns` and reports whether a capture token is available without taking it. */
  bool ready(int64_t now_ns) {
    refill(now_ns);
    return credit_ns >= interval_ns;
  }
  /** Refills to `now_ns` and charges one token for an encoded frame. */
  void spend(int64_t now_ns) {
    refill(now_ns);
    credit_ns = std::max<int64_t>(0, credit_ns - interval_ns);
  }
  /** Nanoseconds from `now_ns` until one token is available, without changing the bucket. */
  int64_t wait_ns(int64_t now_ns) const {
    const int64_t elapsed = now_ns > updated_ns ? now_ns - updated_ns : 0;
    const int64_t credit = std::min(credit_ns + elapsed, int64_t(burst) * interval_ns);
    return credit >= interval_ns ? 0 : interval_ns - credit;
  }
};
}  // namespace relay
