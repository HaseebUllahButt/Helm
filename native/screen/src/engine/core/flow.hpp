#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>

namespace relay {
// All times are server steady-clock microseconds; service thread owns this state.
struct FlowControl {
  static constexpr size_t max_bytes = 8 * 1024 * 1024;
  static constexpr uint64_t pause_age_us = 250000;
  static constexpr uint64_t timeout_us = 3000000;
  static constexpr size_t max_frames = timeout_us * 120 / 1000000;
  static constexpr uint64_t base_window_us = 10000000;
  static constexpr uint64_t viewer_hold_limit_us = 100000;
  enum class Pressure { clear, building, congested, paused };
  static constexpr uint64_t delivery_window_us = 1000000;
  static constexpr uint64_t bitrate_smoothing_us = 500000;
  static constexpr uint64_t sample_interval_us = 10000, idle_sample_interval_us = 100000;
  struct TransportSample {
    uint64_t min_rtt_us = 0, rtt_us = 0, delivery_rate_bps = 0;
    uint64_t notsent_bytes = 0, bytes_acked = 0, application_queued_bytes = 0;
    uint32_t snd_cwnd = 0, total_retrans = 0;
    bool app_limited = false;
  };
  struct DeliverySample { uint64_t time_us, rate_bps; };
  /** Sliding-window extreme of timestamped values: keep a span, read the smallest (or largest) value over any shorter trailing window. */
  struct WindowExtreme {
    struct Sample { uint64_t time_us, value; };
    std::deque<Sample> samples;
    bool smallest = true;
    void push(uint64_t now, uint64_t value, uint64_t span_us) {
      while (!samples.empty() && now - std::min(now, samples.front().time_us) >= span_us) samples.pop_front();
      while (!samples.empty() && (smallest ? samples.back().value >= value : samples.back().value <= value)) samples.pop_back();
      samples.push_back({now, value});
    }
    bool empty() const { return samples.empty(); }
    uint64_t overall(uint64_t none) const { return samples.empty() ? none : samples.front().value; }
    /** Makes later reads over a window ignore anything older than `window_us` before `now`, even if a longer window is read later. */
    void forget(uint64_t now, uint64_t window_us) { forgotten_us = std::max(forgotten_us, now - std::min(now, window_us)); }
    uint64_t over(uint64_t now, uint64_t window_us, uint64_t none, uint64_t floor_us = 0) const {
      for (const auto& sample : samples) {
        if (sample.time_us > std::max(forgotten_us, floor_us) && now - std::min(now, sample.time_us) < window_us) return sample.value;
      }
      return none;
    }
    uint64_t forgotten_us = 0;
  };
  WindowExtreme depth, network, peak{{}, false}, held{{}, false};
  /** Age of the oldest unacknowledged frame, sampled on service ticks; lets a stall be seen while no acknowledgements arrive. */
  WindowExtreme waiting;
  TransportSample transport;
  bool transport_available = false;
  uint64_t delivery_rate_bps = 0, last_transport_update_us = 0;
  std::deque<DeliverySample> delivery_samples;
  uint64_t min_bitrate = 1000000, initial_bitrate = 8000000, max_bitrate = 40000000;
  struct Frame { uint32_t sequence; size_t bytes; uint64_t captured_us; bool sent = false; uint64_t sent_us = 0; };
  std::deque<Frame> frames;
  size_t bytes = 0;
  /** Largest frame this generation; capture pauses while the byte budget left could not hold one, since enqueue rejects a frame that does not fit and the server then closes the stream. */
  size_t largest_frame = 0;
  uint32_t last_encoded = 0;
  uint64_t acknowledged = 0, encoded = 0, last_progress_us = 0;
  uint64_t target_bitrate = initial_bitrate;
  /** Smoothed send-to-acknowledgement time; reported by /metrics only. */
  double ack_rtt_us = 0;
  unsigned window = 1;
  uint64_t sample_start_us = 0, sample_bytes = 0, sample_acks = 0, previous_sent_us = 0;
  uint64_t last_decrease_us = 0, last_increase_us = 0;
  /** Rate measured over the last busy sample; reported by /metrics, and caps a cut. */
  double goodput_bps = 0;
  unsigned frame_rate = 60;

  /** Applies the configured bitrate limits and starts at the configured initial rate. */
  void configure(uint64_t minimum, uint64_t initial, uint64_t maximum, unsigned fps = 60) {
    min_bitrate = minimum; initial_bitrate = initial; max_bitrate = maximum; target_bitrate = initial; frame_rate = std::max(1u, fps);
  }
  /** Restores the idle transport state while keeping the configured bitrate limits. */
  void reset() {
    const uint64_t minimum = min_bitrate, initial = initial_bitrate, maximum = max_bitrate;
    const unsigned fps = frame_rate;
    *this = FlowControl{};
    configure(minimum, initial, maximum, fps);
  }
  /** Reads the viewer wait from an acknowledgement payload: 4 bytes of big-endian microseconds, or zero when absent or malformed. */
  static uint64_t ackWaitUs(const uint8_t* payload, size_t size) {
    return size == 4 ? (uint64_t(payload[0]) << 24) | (uint64_t(payload[1]) << 16) | (uint64_t(payload[2]) << 8) | payload[3] : 0;
  }
  uint64_t oldestAge(uint64_t now) const {
    return frames.empty() ? 0 : now - std::min(now, frames.front().captured_us);
  }
  uint64_t frameIntervalUs() const { return (1000000ULL + frame_rate - 1) / frame_rate; }
  uint64_t serviceDeadlineUs(uint64_t now, uint64_t pending) const {
    const uint64_t next = now + (frames.empty() ? idle_sample_interval_us : sample_interval_us);
    return pending ? std::min(pending, next) : next;
  }
  /** Capture-to-acknowledgement time of an uncongested frame: the network base plus the viewer's wait, so a hold the viewer adds is not read as queue; zero when unmeasured. A queue that stands for the whole window becomes the new base because nothing drains it; the pause and the 3 s timeout bound that. */
  uint64_t baseDepthUs() const { return networkBaseDepthUs() + viewerWaitUs(); }
  /** Largest capture-to-acknowledgement time over the last 10 s; sizes the frame window. */
  uint64_t peakDepthUs() const { return peak.overall(0); }
  /** Smallest network depth (capture-to-acknowledgement minus viewer wait) over the last 10 s; zero when unmeasured. */
  uint64_t networkBaseDepthUs() const { return network.overall(0); }
  /** Span over which the smallest queueing delay is taken: one base round trip, at least two frame intervals. */
  uint64_t standingWindowUs() const { return std::max(baseDepthUs(), 2 * frameIntervalUs()); }
  /** Standing queue at which capture stops: the base plus two frame intervals, or 250 ms before any acknowledgement. This mirrors the TCP-statistics rule of twice the round trip plus two frame intervals. */
  uint64_t pauseQueueUs() const {
    return depth.empty() ? pause_age_us : baseDepthUs() + 2 * frameIntervalUs();
  }
  /** Oldest-frame age at which capture pauses, as /metrics reports it. With TCP statistics it also gates admission; without, it is the base depth plus the pause queue. */
  uint64_t admissionAgeUs() const {
    return transport_available ? transportAgeLimitUs() : baseDepthUs() + pauseQueueUs();
  }
  /** Longest wait a viewer reported for a frame in the last 10 s, up to the 100 ms a viewer may hold one. A longer wait is a viewer falling behind and must not widen the limits. */
  uint64_t viewerWaitUs() const { return std::min(viewer_hold_limit_us, held.overall(0)); }
  /** Oldest-frame age at which capture stops with TCP statistics: twice the minimum round trip plus two frame intervals plus the viewer's wait, capped at 3 s, or 250 ms before a round trip is known. */
  uint64_t transportAgeLimitUs() const {
    if (!transport.min_rtt_us) return pause_age_us;
    return std::min(timeout_us, 2 * std::min(transport.min_rtt_us, timeout_us) + 2 * frameIntervalUs() + viewerWaitUs());
  }
  /** Queueing delay present for the whole recent window: the smallest oldest-frame age or acknowledgement time in it, above the given base. */
  uint64_t standingAbove(uint64_t now, const WindowExtreme& acknowledged_depths, uint64_t base) const {
    if (frames.empty()) return 0;
    const uint64_t window = standingWindowUs();
    const uint64_t lowest = std::min({oldestAge(now), acknowledged_depths.over(now, window, ~0ULL),
        waiting.over(now, window, ~0ULL, acknowledged_depths.forgotten_us)});
    return lowest > base ? lowest - base : 0;
  }
  /** The total standing queue, viewer wait included. */
  uint64_t standingQueueUs(uint64_t now) const { return standingAbove(now, depth, baseDepthUs()); }
  /** The part of the standing queue that is in the network, with the time frames wait inside the viewer taken out. */
  uint64_t standingNetworkQueueUs(uint64_t now) const { return standingAbove(now, network, networkBaseDepthUs()); }
  /** Classifies a standing queue against the pause limit: clear below a quarter of it, building below half, congested below the limit, paused at it. */
  Pressure levelOf(uint64_t queue) const {
    const uint64_t limit = pauseQueueUs();
    if (queue >= limit) return Pressure::paused;
    if (queue >= limit / 2) return Pressure::congested;
    return queue >= limit / 4 ? Pressure::building : Pressure::clear;
  }
  /** Bitrate decisions without TCP statistics: the standing network queue against the same limit as the pause. */
  Pressure networkPressure(uint64_t now) const { return levelOf(standingNetworkQueueUs(now)); }
  unsigned frameLimit() const {
    const uint64_t count = (timeout_us * frame_rate + 999999) / 1000000;
    return unsigned(std::clamp<uint64_t>(count, 2, max_frames));
  }
  uint64_t notsentLowat() const {
    const uint64_t denominator = uint64_t(frame_rate) * 4;
    return std::max<uint64_t>(16 * 1024, (target_bitrate + denominator - 1) / denominator);
  }
  uint64_t senderQueueUs() const {
    double queued = double(transport.notsent_bytes) + double(transport.application_queued_bytes);
    for (const auto& frame : frames) if (!frame.sent) queued += double(frame.bytes);
    const uint64_t rate = delivery_rate_bps ? delivery_rate_bps : std::max<uint64_t>(1, target_bitrate);
    return uint64_t(std::ceil(queued * 8000000.0 / double(rate)));
  }
  static uint64_t headroomBitrate(uint64_t target, uint64_t maximum, uint64_t elapsed_us,
      uint64_t queued_us, uint64_t interval_us, uint64_t oldest_us, uint64_t age_limit_us) {
    if (queued_us >= (interval_us + 1) / 2 || oldest_us >= age_limit_us) return target;
    return uint64_t(std::round(std::min(double(maximum), double(target) *
        std::pow(1.25, double(elapsed_us) / 1000000.0))));
  }
  uint64_t frameBitrate() const {
    if (!transport_available) return target_bitrate;
    const uint64_t interval = frameIntervalUs();
    const uint64_t queued = std::clamp(senderQueueUs(), interval, 3 * interval);
    return uint64_t(double(target_bitrate) *
        (1.0 - 0.75 * double(queued - interval) / double(2 * interval)));
  }
  bool pausedWithTransport(uint64_t now) const {
    return oldestAge(now) >= transportAgeLimitUs() || frames.size() >= window || senderQueueUs() >= 3 * frameIntervalUs();
  }
  bool pausedWithoutTransport(uint64_t now) const {
    return levelOf(standingQueueUs(now)) == Pressure::paused;
  }
  bool paused(uint64_t now) const {
    return bytes + largest_frame > max_bytes || (transport_available ? pausedWithTransport(now) : pausedWithoutTransport(now));
  }
  bool timedOut(uint64_t now) const {
    return !frames.empty() && (now - std::min(now, last_progress_us) >= timeout_us ||
                               oldestAge(now) >= timeout_us);
  }
  bool enqueue(uint32_t seq, size_t size, uint64_t captured, uint64_t now) {
    if (!seq || seq != last_encoded + 1 || frames.size() >= frameLimit() ||
        !size || size > max_bytes || size > max_bytes - bytes) return false;
    if (frames.empty()) last_progress_us = now;
    frames.push_back({seq, size, captured}); bytes += size; largest_frame = std::max(largest_frame, size); last_encoded = seq; ++encoded;
    return true;
  }
  bool sent(uint32_t seq, uint64_t now) {
    for (auto& frame : frames) {
      if (frame.sent) continue;
      if (frame.sequence != seq) return false;
      frame.sent = true; frame.sent_us = now; return true;
    }
    return false;
  }
  /** Credits the oldest frame. The viewer's wait is untrusted: one longer than the frame's whole capture-to-acknowledgement time counts as zero. */
  bool ack(uint32_t seq, uint64_t now, uint64_t viewer_wait_us = 0) {
    if (frames.empty() || !frames.front().sent || frames.front().sequence != seq) return false;
    const auto frame = frames.front();
    const double rtt = double(now - std::min(now, frame.sent_us));
    ack_rtt_us = acknowledged ? ack_rtt_us * 0.875 + rtt * 0.125 : rtt;
    recordDepth(frame.captured_us, now, viewer_wait_us);
    // Sample continuous demand only: idle gaps and tiny updates are not capacity evidence.
    if (!transport_available) {
      if (previous_sent_us && frame.sent_us - previous_sent_us > 3 * frameIntervalUs()) {
        sample_start_us = sample_bytes = sample_acks = 0;
      }
      if (!sample_start_us) sample_start_us = frame.sent_us;
      previous_sent_us = frame.sent_us;
      sample_bytes += frame.bytes; ++sample_acks;
    }
    bytes -= frame.bytes; frames.pop_front(); ++acknowledged; last_progress_us = now;
    update(now);
    return true;
  }
  void recordDepth(uint64_t captured, uint64_t now, uint64_t viewer_wait_us) {
    const uint64_t total = now - std::min(now, captured);
    const uint64_t wait = viewer_wait_us <= total ? viewer_wait_us : 0;
    const uint64_t kept_before = transport_available ? 2 * frameIntervalUs() : standingWindowUs();
    network.forget(now, kept_before);
    depth.push(now, total, base_window_us);
    peak.push(now, total, base_window_us);
    held.push(now, wait, base_window_us);
    network.push(now, total - wait, base_window_us);
    depth.forget(now, transport_available ? 2 * frameIntervalUs() : standingWindowUs());
  }
  void expireDelivery(uint64_t now) {
    while (!delivery_samples.empty() &&
           now - std::min(now, delivery_samples.front().time_us) >= delivery_window_us) {
      delivery_samples.pop_front();
    }
    delivery_rate_bps = delivery_samples.empty() ? 0 : delivery_samples.front().rate_bps;
  }
  void sampleTransport(const TransportSample& sample, uint64_t now) {
    const bool progress = !transport_available || sample.bytes_acked > transport.bytes_acked;
    if (!transport_available) last_transport_update_us = now;
    transport = sample; transport_available = true;
    expireDelivery(now);
    if (progress && !sample.app_limited && sample.delivery_rate_bps) {
      if (delivery_samples.empty()) last_transport_update_us = now;
      while (!delivery_samples.empty() && delivery_samples.back().rate_bps <= sample.delivery_rate_bps) {
        delivery_samples.pop_back();
      }
      delivery_samples.push_back({now, sample.delivery_rate_bps});
    }
    update(now);
  }
  void clearTransport() {
    if (!transport_available) return;
    transport = {}; transport_available = false; delivery_rate_bps = last_transport_update_us = 0;
    delivery_samples.clear();
    sample_start_us = sample_bytes = sample_acks = previous_sent_us = 0;
    goodput_bps = 0;
    updateWindow();
  }
  void windowWithTransport() {
    const uint64_t count = transport.min_rtt_us ?
        ((2 * std::min(transport.min_rtt_us, timeout_us) + viewerWaitUs()) * frame_rate + 999999) / 1000000 + 2 :
        (pause_age_us * frame_rate + 999999) / 1000000;
    window = unsigned(std::clamp<uint64_t>(count, 2, frameLimit()));
  }
  void windowWithoutTransport() {
    window = acknowledged ? unsigned(std::clamp(
        std::ceil(double(peakDepthUs()) * frame_rate / 1000000.0) + 2.0, 2.0, double(frameLimit()))) : 1;
  }
  void updateWindow() { transport_available ? windowWithTransport() : windowWithoutTransport(); }
  void bitrateWithTransport(uint64_t now) {
    expireDelivery(now);
    const uint64_t elapsed = now - std::min(now, last_transport_update_us);
    last_transport_update_us = now;
    const uint64_t probe = transport.app_limited || !delivery_rate_bps ?
        headroomBitrate(target_bitrate, max_bitrate, elapsed, senderQueueUs(), frameIntervalUs(),
            oldestAge(now), transportAgeLimitUs()) : 0;
    if (delivery_rate_bps) {
      const double desired = std::clamp(double(delivery_rate_bps) * 0.85,
          double(min_bitrate), double(max_bitrate));
      if (!transport.app_limited || desired > double(target_bitrate)) {
        const double weight = 1.0 - std::exp(-double(elapsed) / double(bitrate_smoothing_us));
        target_bitrate = std::clamp<uint64_t>(uint64_t(std::round(double(target_bitrate) +
            (desired - double(target_bitrate)) * weight)), min_bitrate, max_bitrate);
      }
    }
    target_bitrate = std::max(target_bitrate, probe);
  }
  void bitrateWithoutTransport(uint64_t now) {
    if (!frames.empty()) {
      waiting.push(now, oldestAge(now), base_window_us);
      depth.forget(now, standingWindowUs());
      network.forget(now, standingWindowUs());
    }
    const bool busy = sample_start_us && sample_acks >= 8 && sample_bytes >= 65536;
    const uint64_t interval = sample_start_us ? now - std::min(now, sample_start_us) : 0;
    if (busy && interval >= 500000) goodput_bps = double(sample_bytes) * 8000000.0 / interval;
    const Pressure state = networkPressure(now);
    if (frames.size() >= 2 && bytes >= std::min<uint64_t>(target_bitrate / 80, 65536) &&
        state >= Pressure::congested &&
        now - last_decrease_us >= 500000) {
      uint64_t next = target_bitrate * 3 / 4;
      if (busy && interval >= 500000) next = std::min(next, uint64_t(goodput_bps * 0.9));
      target_bitrate = std::max<uint64_t>(min_bitrate, next); last_decrease_us = now;
      last_increase_us = now;
    } else if (busy && interval >= 1000000 && state == Pressure::clear &&
               now - last_increase_us >= 1000000 && now - last_decrease_us >= 2000000) {
      // CRF can emit far below its cap; prompt ACKs of sustained demand permit a probe.
      target_bitrate = std::min<uint64_t>(max_bitrate, target_bitrate + target_bitrate / 10);
      last_increase_us = now;
    }
    if (interval >= 1000000) { sample_start_us = now; sample_bytes = sample_acks = 0; }
  }
  void update(uint64_t now) {
    updateWindow();
    transport_available ? bitrateWithTransport(now) : bitrateWithoutTransport(now);
  }
};
}  // namespace relay
