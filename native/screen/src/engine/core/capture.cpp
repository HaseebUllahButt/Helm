#include "capture.hpp"
#include "capture-bucket.hpp"
#include "color.hpp"
#include "flow.hpp"
#include "capture-source.hpp"
#include "cpu-budget.hpp"
#include "wait.hpp"

#include <cstdint>
#include <x264.h>
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace relay {
namespace {
/// Motion frames get 4 frame budgets; forced keyframes and refinement get 8.
constexpr int vbvBufferKbit(uint64_t bitrate, unsigned fps, bool wide) {
  const uint64_t motion = 4 * bitrate / (1000ull * fps);
  const uint64_t legacy_wide = 8 * bitrate / (1000ull * fps);
  return int(std::max<uint64_t>(1, wide ? std::max(motion, legacy_wide) : motion));
}
static_assert(vbvBufferKbit(1000000, 10, false) == 400);
static_assert(vbvBufferKbit(1000000, 30, false) == 133);
static_assert(vbvBufferKbit(1000000, 60, false) == 66);
static_assert(vbvBufferKbit(250000, 60, false) == 16);
static_assert(vbvBufferKbit(1000000, 10, true) == 800);
static_assert(vbvBufferKbit(1000000, 30, true) == 266);
static_assert(vbvBufferKbit(250000, 60, true) == 33);
static_assert(vbvBufferKbit(1000000, 120, false) == 33);
static_assert(vbvBufferKbit(1000000, 120, true) == 66);
static_assert(vbvBufferKbit(62500, 120, false) == 2);
static_assert(vbvBufferKbit(62500, 120, true) == 4);
constexpr float encoder_crf = 10;
/// Changed macroblocks above which damage conversion is split across worker threads.
constexpr int parallel_convert_macroblocks = 512;
using Clock = std::chrono::steady_clock;

uint64_t ns(Clock::duration d) {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(d).count();
}
bool hasNal(const std::vector<uint8_t>& bytes, uint8_t type) {
  for (size_t i = 0; i + 3 < bytes.size(); ++i) {
    if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1 &&
        (bytes[i + 3] & 31) == type) return true;
  }
  return false;
}
void require(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}
/// Runs one job on every thread at once, the caller included, and returns when all of them finish.
class Workers {
 public:
  explicit Workers(int count) {
    for (int i = 1; i < count; ++i) threads.emplace_back([this] { loop(); });
  }
  ~Workers() {
    { std::lock_guard<std::mutex> lock(mutex); stopping = true; }
    wake.notify_all();
    for (auto& thread : threads) thread.join();
  }
  int size() const { return int(threads.size()) + 1; }
  void run(const std::function<void(int)>& job) {
    { std::lock_guard<std::mutex> lock(mutex); task = &job; next = 1; pending = int(threads.size()); ++round; }
    wake.notify_all();
    job(0);
    std::unique_lock<std::mutex> lock(mutex);
    finished.wait(lock, [this] { return pending == 0; });
    task = nullptr;
  }
 private:
  void loop() {
    uint64_t seen = 0;
    std::unique_lock<std::mutex> lock(mutex);
    while (true) {
      wake.wait(lock, [&] { return stopping || round != seen; });
      if (stopping) return;
      seen = round;
      const int part = next++;
      const auto* job = task;
      lock.unlock();
      (*job)(part);
      lock.lock();
      if (--pending == 0) finished.notify_one();
    }
  }
  std::vector<std::thread> threads;
  std::mutex mutex;
  std::condition_variable wake, finished;
  const std::function<void(int)>* task = nullptr;
  uint64_t round = 0;
  int next = 0, pending = 0;
  bool stopping = false;
};
struct Resources {
  PixelFormat format;
  int width, height;
  CaptureSettings settings;
  x264_t* codec = nullptr;
  x264_picture_t frame{};
  std::vector<uint8_t> mb_info;
  int threads;
  std::vector<std::vector<uint8_t>> scratch;
  Workers workers;
  bool frame_allocated = false;
  uint64_t bitrate;
  bool wide_vbv = false;
  Resources(PixelFormat f, int w, int h, CaptureSettings s)
      : format(f), width(w), height(h), settings(s),
        mb_info(size_t((w + 15) / 16) * size_t((h + 15) / 16)),
        threads(encoderThreads(h)),
        scratch(size_t(threads), std::vector<uint8_t>(size_t(w) * 24)), workers(threads),
        bitrate(s.start_bitrate) {}
  ~Resources() {
    if (codec) x264_encoder_close(codec);
    if (frame_allocated) x264_picture_clean(&frame);
  }
  void openEncoder() {
    if (codec) x264_encoder_close(codec);
    codec = nullptr;
    x264_param_t params;
    require(x264_param_default_preset(&params, "ultrafast", "zerolatency") >= 0,
            "setting x264 options failed");
    params.i_width = width; params.i_height = height; params.i_csp = X264_CSP_NV12;
    params.i_timebase_num = 1; params.i_timebase_den = 1000000;
    params.i_fps_num = int(settings.fps); params.i_fps_den = 1;
    params.i_threads = threads; params.b_sliced_threads = 1; params.i_keyint_max = X264_KEYINT_MAX_INFINITE; params.i_bframe = 0;
    params.i_scenecut_threshold = 0; params.i_sync_lookahead = 0;
    params.rc.i_rc_method = X264_RC_CRF; params.rc.f_rf_constant = encoder_crf;
    params.rc.i_lookahead = 0; params.rc.i_vbv_max_bitrate = int(settings.start_bitrate / 1000); params.rc.i_vbv_buffer_size = vbvBufferKbit(settings.start_bitrate, settings.fps, true);
    params.analyse.b_mb_info = 1; params.analyse.b_mb_info_update = 0;
    params.b_annexb = 1; params.b_repeat_headers = 1;
    params.vui.b_fullrange = 0; params.vui.i_colmatrix = 1;
    params.vui.i_colorprim = 1; params.vui.i_transfer = 1;
    params.vui.i_chroma_loc = 1;
    codec = x264_encoder_open(&params);
    require(codec, "opening libx264 failed");
    bitrate = settings.start_bitrate;
    wide_vbv = true;
  }
  void init() {
    openEncoder();
    require(x264_picture_alloc(&frame, X264_CSP_NV12, width, height) == 0,
            "allocating YUV buffer failed");
    frame_allocated = true;
  }
  bool convertDamage(const FrameView& view, const std::vector<DamageRect>& rects) {
    const int columns = (width + 15) / 16;
    std::fill(mb_info.begin(), mb_info.end(), uint8_t(X264_MBINFO_CONSTANT));
    int damaged = 0;
    for (const auto& rect : rects) {
      const int64_t x0 = std::max<int64_t>(view.x, rect.x);
      const int64_t y0 = std::max<int64_t>(view.y, rect.y);
      const int64_t x1 = std::min<int64_t>(view.x + view.width, int64_t(rect.x) + rect.width);
      const int64_t y1 = std::min<int64_t>(view.y + view.height, int64_t(rect.y) + rect.height);
      if (x1 <= x0 || y1 <= y0) continue;
      for (int row = int(y0) / 16; row <= (y1 - 1) / 16; ++row)
        for (int column = int(x0) / 16; column <= (x1 - 1) / 16; ++column)
          if (mb_info[row * columns + column]) { mb_info[row * columns + column] = 0; ++damaged; }
    }
    const int first = view.y / 16, rows = (view.y + view.height - 1) / 16 - first + 1;
    std::atomic<bool> changed{false}, failed{false};
    const int parts = damaged >= parallel_convert_macroblocks ? workers.size() : 1;
    const std::function<void(int)> job = [&](int part) {
      bool different = false;
      if (!convertRows(view, first + rows * part / parts, first + rows * (part + 1) / parts, scratch[part], different))
        failed = true;
      if (different) changed = true;
    };
    if (parts > 1) workers.run(job); else job(0);
    require(!failed, "RGB conversion failed");
    return changed;
  }
  bool convertRows(const FrameView& view, int begin, int end, std::vector<uint8_t>& buffer, bool& changed) {
    const int columns = (width + 15) / 16;
    const auto convert = view.format == PixelFormat::BGRA ? bgraToNv12 : argbToNv12;
    for (int row = begin; row < end; ++row) {
      const int y0 = std::max(row * 16, view.y);
      const int y1 = std::min(row * 16 + 16, view.y + view.height);
      for (int column = view.x / 16; column <= (view.x + view.width - 1) / 16;) {
        if (mb_info[row * columns + column]) { ++column; continue; }
        const int first = column;
        while (column <= (view.x + view.width - 1) / 16 && !mb_info[row * columns + column]) ++column;
        const int x0 = std::max(first * 16, view.x);
        const int x1 = std::min(column * 16, view.x + view.width);
        if (!convert(view.data + (y0 - view.y) * view.stride + (x0 - view.x) * 4, view.stride,
                     buffer.data(), width, buffer.data() + width * 16, width, x1 - x0, y1 - y0)) return false;
        for (int block = first; block < column; ++block) {
          const int left = std::max(block * 16, x0);
          const int right = std::min(block * 16 + 16, x1);
          bool different = false;
          for (int plane = 0; plane < 2; ++plane) {
            const int lines = plane ? (y1 - y0) / 2 : y1 - y0;
            uint8_t* target = frame.img.plane[plane] + (plane ? y0 / 2 : y0) * frame.img.i_stride[plane] + left;
            const uint8_t* source = buffer.data() + (plane ? width * 16 : 0) + left - x0;
            for (int line = 0; line < lines; ++line) {
              if (std::memcmp(target, source, right - left) != 0) {
                std::memcpy(target, source, right - left);
                different = true;
              }
              target += frame.img.i_stride[plane];
              source += width;
            }
          }
          mb_info[row * columns + block] = different ? 0 : uint8_t(X264_MBINFO_CONSTANT);
          changed |= different;
        }
      }
    }
    return true;
  }
};
}  // namespace

struct CaptureEncoder::Impl {
  explicit Impl(Publish callback, CaptureSettings options, CaptureSourceFactory factory, PublishCursor cursor)
      : source_factory(std::move(factory)), publish(std::move(callback)), publish_cursor(std::move(cursor)),
        settings(options) {}
  CaptureSourceFactory source_factory;
  Publish publish;
  PublishCursor publish_cursor;
  CaptureSettings settings;
  mutable std::mutex mutex;
  std::condition_variable ready;
  std::thread worker;
  Wake wake_event;
  bool stopping = false, initialized = false, running = false;
  std::string startup_error;
  std::string fatal_error;
  uint32_t generation = 0, sequence = 0, acknowledged = 0;
  unsigned window = 1;
  uint64_t bitrate = settings.start_bitrate, admit_until_us = 0;
  bool paused = false;
  uint64_t revision = 0;
  bool active = false;
  CaptureStats counters;
  void wake() { wake_event.signal(); }
  void run() {
    try {
      auto source = source_factory();
      require(bool(source), "capture source factory returned null");
      require(validWaitHandle(source->fd()), "invalid capture source fd");
      const auto format = source->pixelFormat();
      require(format == PixelFormat::BGRA || format == PixelFormat::ARGB, "unsupported capture pixel format");
      const auto dimensions = source->dimensions();
      const int width = dimensions.first, height = dimensions.second;
      requireSurfaceSize(width, height);
      Resources r(format, width, height, settings);
      r.init();
      { std::lock_guard<std::mutex> lock(mutex);
        counters.cursor_supported = source->cursorSupported(); initialized = true; running = true;
      }
      ready.notify_all();
      bool dirty = true, force_idr = true;
      uint64_t seen_revision = 0;
      int64_t last_pts = -1;
      std::vector<DamageRect> rects;
      unsigned consecutive_failures = 0;
      const auto frame_interval = std::chrono::nanoseconds(1000000000LL / settings.fps);
      const auto refinement_delay = std::chrono::milliseconds(150);
      constexpr unsigned refinement_max_frames = 8;
      CaptureBucket bucket;
      const auto started = Clock::now();
      bucket.reset(ns(started.time_since_epoch()), ns(frame_interval));
      auto last_publish = started;
      auto retry_after = Clock::time_point::min();
      bool last_was_refinement = true, refining = false;
      unsigned cascade_frames = 0;
      uint64_t first_refinement_size = 0;
      auto reset_refinement = [&] {
        refining = false;
        cascade_frames = 0;
        first_refinement_size = 0;
      };
      while (true) {
        if (source->drainDamage()) dirty = true;
        uint32_t gen, seq;
        uint64_t rev, rate;
        bool admitted, cursor_active, queue_empty, refresh_cursor = false;
        {
          std::lock_guard<std::mutex> lock(mutex);
          if (stopping) break;
          if (revision != seen_revision) {
            seen_revision = revision; dirty = true; force_idr = true;
            reset_refinement();
            refresh_cursor = true;
          }
          gen = generation; rev = revision; rate = bitrate;
          cursor_active = gen != 0 && active && bool(publish_cursor);
          queue_empty = sequence == acknowledged;
          admitted = gen != 0 && active && !paused &&
                     (!admit_until_us || uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(
                         Clock::now().time_since_epoch()).count()) < admit_until_us) &&
                     sequence - acknowledged < window &&
                     sequence < std::numeric_limits<uint32_t>::max();
          seq = sequence + (admitted ? 1 : 0);
        }
        bool cursor_published = false;
        if (cursor_active) {
          if (auto cursor = source->cursor(refresh_cursor)) {
            publish_cursor(gen, std::move(*cursor)); cursor_published = true;
          }
        }
        const auto now = Clock::now();
        const int64_t now_ns = ns(now.time_since_epoch());
        const bool refinement_pending = !dirty && refining;
        const auto refinement_pace = last_was_refinement ? frame_interval : refinement_delay;
        const bool refinement_ready = !refinement_pending || now >= last_publish + refinement_pace;
        if (admitted && (dirty || (refinement_pending && queue_empty)) && now >= retry_after &&
            refinement_ready && bucket.ready(now_ns)) {
          bool refinement = !dirty;
          const bool captured_frame = !refinement;
          const auto capture_start = Clock::now();
          try {
            assert(!refinement || (!force_idr && last_pts >= 0));
            dirty = false;
            auto captured = capture_start, converted = capture_start;
            if (!refinement) {
              const FrameView view = source->captureChanged(force_idr);
              captured = Clock::now();
              require(view.data && view.width > 0 && view.height > 0 &&
                      view.x >= 0 && view.x <= width && view.y >= 0 && view.y <= height &&
                      view.width <= width - view.x && view.height <= height - view.y &&
                      view.stride >= view.width * 4 && view.stride <= width * 8 &&
                      !(view.x & 1) && !(view.y & 1) && !(view.width & 1) && !(view.height & 1) &&
                      !(force_idr && (view.width != width || view.height != height)) &&
                      view.format == r.format, "invalid capture frame");
              bool changed = true;
              if (force_idr) {
                const auto convert = view.format == PixelFormat::BGRA ? bgraToNv12 : argbToNv12;
                require(convert(view.data, view.stride, r.frame.img.plane[0], r.frame.img.i_stride[0],
                                r.frame.img.plane[1], r.frame.img.i_stride[1], view.width, view.height),
                        "RGB conversion failed");
              } else {
                if (!source->changedRects(rects)) rects = {{view.x, view.y, view.width, view.height}};
                changed = r.convertDamage(view, rects);
              }
              converted = Clock::now();
              if (!changed) {
                if (refining && queue_empty && converted >= last_publish + refinement_pace) {
                  refinement = true;
                } else {
                  { std::lock_guard<std::mutex> lock(mutex);
                    ++counters.captures;
                    counters.capture_ns += ns(captured - capture_start);
                    counters.convert_ns += ns(converted - captured);
                  }
                  consecutive_failures = 0;
                  bucket.spend(ns(converted.time_since_epoch()));
                  continue;
                }
              }
            }
            const int64_t timestamp = std::chrono::duration_cast<std::chrono::microseconds>(capture_start.time_since_epoch()).count();
            r.frame.i_pts = last_pts = std::max(last_pts + 1, timestamp);
            const bool wide_vbv = refinement || force_idr;
            if (rate != r.bitrate || wide_vbv != r.wide_vbv) {
              x264_param_t params;
              x264_encoder_parameters(r.codec, &params);
              params.rc.i_vbv_max_bitrate = int(rate / 1000);
              params.rc.i_vbv_buffer_size = vbvBufferKbit(rate, settings.fps, wide_vbv);
              require(x264_encoder_reconfig(r.codec, &params) == 0, "encoder reconfiguration failed");
              r.bitrate = rate;
              r.wide_vbv = wide_vbv;
            }
            r.frame.i_type = force_idr ? X264_TYPE_IDR : X264_TYPE_AUTO;
            r.frame.prop.mb_info = nullptr; r.frame.prop.mb_info_free = nullptr;
            if (!refinement && !force_idr) r.frame.prop.mb_info = r.mb_info.data();
            x264_nal_t* nals = nullptr;
            int nal_count = 0;
            x264_picture_t picture;
            const int size = x264_encoder_encode(r.codec, &nals, &nal_count, &r.frame, &picture);
            require(size > 0 && nal_count > 0 && nals && picture.i_pts == last_pts &&
                    static_cast<size_t>(size) <= FlowControl::max_bytes,
                    "invalid or delayed encoded access unit");
            const bool converged = refinement && picture.prop.f_crf_avg <= encoder_crf + 1 &&
                                   uint64_t(size) <= rate / (4ull * settings.fps);
            EncodedFrame output;
            output.generation = gen; output.sequence = seq; output.pts_us = last_pts;
            output.width = uint16_t(width); output.height = uint16_t(height);
            output.keyframe = picture.b_keyframe;
            output.annex_b.assign(nals[0].p_payload, nals[0].p_payload + size);
            require(!force_idr || (output.keyframe &&
                    hasNal(output.annex_b, 5) && hasNal(output.annex_b, 7) && hasNal(output.annex_b, 8)),
                    "encoder buffered frame or omitted IDR/SPS/PPS");
            const auto encoded = Clock::now();
            bucket.spend(ns(encoded.time_since_epoch()));
            bool current;
            {
              std::lock_guard<std::mutex> lock(mutex);
              if (captured_frame) ++counters.captures;
              ++counters.encoded;
              counters.capture_ns += ns(captured - capture_start);
              counters.convert_ns += ns(converted - captured);
              counters.encode_ns += ns(encoded - converted);
              current = revision == rev && generation == gen && active;
              if (current) sequence = seq;
            }
            if (current) {
              if (!publish(std::move(output))) {
                // A rejected reference packet stalls this generation until transport recovery.
                std::fprintf(stderr, "capture: publish rejected; awaiting new session\n");
                { std::lock_guard<std::mutex> lock(mutex); if (generation == gen) active = false; }
                dirty = true; force_idr = true;
                reset_refinement();
              } else {
                force_idr = false;
                last_publish = Clock::now();
                last_was_refinement = refinement;
                if (refinement) {
                  if (cascade_frames == 0) first_refinement_size = uint64_t(size);
                  ++cascade_frames;
                  refining = !converged && cascade_frames < refinement_max_frames &&
                             uint64_t(size) * 8 > first_refinement_size;
                } else {
                  cascade_frames = 0;
                  first_refinement_size = 0;
                  refining = true;
                }
              }
            } else {
              dirty = true;
              force_idr = true;
              reset_refinement();
            }
            consecutive_failures = 0;
          } catch (const std::exception& error) {
            std::fprintf(stderr, "capture: %s; retrying with IDR\n", error.what());
            dirty = true;
            force_idr = true;
            reset_refinement();
            if (++consecutive_failures >= 3) {
              throw std::runtime_error(std::string("capture failed three consecutive times: ") + error.what());
            }
            r.openEncoder();
            retry_after = Clock::now() + std::chrono::seconds(1);
          }
          continue;
        }
        // A synchronous cursor read may have buffered display events in Xlib.
        if (cursor_published) continue;
        int64_t timeout_ns = -1;
        if (admitted && (dirty || (refinement_pending && queue_empty))) {
          const auto wait_now = Clock::now();
          const int64_t wait_now_ns = ns(wait_now.time_since_epoch());
          auto wake_at = wait_now + std::chrono::nanoseconds(bucket.wait_ns(wait_now_ns));
          if (retry_after > wake_at) wake_at = retry_after;
          if (refinement_pending && queue_empty && last_publish + refinement_pace > wake_at)
            wake_at = last_publish + refinement_pace;
          const auto remaining = std::chrono::duration_cast<std::chrono::nanoseconds>(
              wake_at - wait_now).count();
          timeout_ns = std::max<int64_t>(0, remaining);
        }
        if (wait(source->fd(), wake_event, timeout_ns).wake) wake_event.consume();
      }
    } catch (const std::exception& error) {
      std::fprintf(stderr, "capture worker stopped: %s\n", error.what());
      {
        std::lock_guard<std::mutex> lock(mutex);
        fatal_error = error.what();
        if (!initialized) startup_error = fatal_error;
        initialized = true;
        running = false;
        active = false;
      }
      ready.notify_all();
    }
    std::lock_guard<std::mutex> lock(mutex); running = false;
  }
};

CaptureEncoder::CaptureEncoder(Publish publish, CaptureSettings settings, CaptureSourceFactory factory, PublishCursor cursor)
    : impl_(std::make_unique<Impl>(std::move(publish), settings, std::move(factory), std::move(cursor))) {}
CaptureEncoder::~CaptureEncoder() { stop(); }
bool CaptureEncoder::start(std::string& error) {
  auto& i = *impl_;
  std::unique_lock<std::mutex> lock(i.mutex);
  if (i.worker.joinable()) { error = "capture already started"; return false; }
  if (!i.publish) { error = "capture publish callback missing"; return false; }
  if (!i.wake_event.valid()) { error = "creating capture wake event failed"; return false; }
  i.wake_event.consume();
  i.stopping = false;
  i.initialized = false;
  i.startup_error.clear();
  i.fatal_error.clear();
  try { i.worker = std::thread([&i] { i.run(); }); }
  catch (const std::exception& e) { error = e.what(); return false; }
  i.ready.wait(lock, [&i] { return i.initialized; });
  error = i.startup_error.empty() ? i.fatal_error : i.startup_error;
  const bool success = i.running;
  lock.unlock();
  if (!success) stop();
  return success;
}
void CaptureEncoder::beginSession(uint32_t generation) {
  auto& i = *impl_;
  {
    std::lock_guard<std::mutex> lock(i.mutex);
    if (!generation || !i.running) return;
    i.generation = generation;
    i.sequence = 0;
    i.acknowledged = 0;
    i.window = 1; i.bitrate = i.settings.start_bitrate; i.paused = false; i.admit_until_us = 0;
    i.active = true;
    ++i.revision;
    i.wake();
  }
}
void CaptureEncoder::endSession(uint32_t generation) {
  auto& i = *impl_;
  std::lock_guard<std::mutex> lock(i.mutex);
  if (generation != i.generation) return;
  i.generation = 0;
  i.active = false;
  i.acknowledged = 0;
  ++i.revision;
  i.wake();
}
void CaptureEncoder::acknowledge(uint32_t generation, uint32_t sequence) {
  auto& i = *impl_;
  std::lock_guard<std::mutex> lock(i.mutex);
  if (!generation || generation != i.generation || sequence != i.acknowledged + 1 || sequence > i.sequence) return;
  i.acknowledged = sequence;
  i.wake();
}
void CaptureEncoder::setFlowControl(uint32_t generation, unsigned window, uint64_t bitrate, bool paused, uint64_t admit_until_us) {
  auto& i = *impl_;
  std::lock_guard<std::mutex> lock(i.mutex);
  if (!generation || generation != i.generation) return;
  i.window = std::clamp(window, 1u, unsigned(FlowControl::max_frames));
  i.bitrate = std::clamp<uint64_t>(bitrate, std::max<uint64_t>(1, i.settings.min_bitrate / 4), i.settings.max_bitrate);
  i.paused = paused;
  i.admit_until_us = admit_until_us;
  i.wake();
}
CaptureStats CaptureEncoder::stats() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->counters;
}
std::string CaptureEncoder::error() const {
  std::lock_guard<std::mutex> lock(impl_->mutex);
  return impl_->fatal_error;
}
void CaptureEncoder::stop() {
  auto& i = *impl_;
  {
    std::lock_guard<std::mutex> lock(i.mutex);
    i.stopping = true;
    i.wake();
  }
  if (i.worker.joinable()) i.worker.join();
  std::lock_guard<std::mutex> lock(i.mutex);
  i.generation = 0;
  i.active = false;
}
}  // namespace relay
