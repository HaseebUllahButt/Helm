#include "wayland.hpp"
#include "core/capture-source.hpp"
#include <sys/mman.h>
#include <poll.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <exception>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace relay::wayland {
namespace {
constexpr size_t max_damage_rects = 64;

void checkSize(int width, int height) {
  try {
    requireSurfaceSize(width, height);
  } catch (const std::runtime_error& error) {
    throw std::runtime_error(std::string(error.what()) +
      "; create a headless output of a supported size (for example, swaymsg create_output or "
      "hyprctl output create headless <name>) and select it with --output");
  }
}

struct Buffer {
  wl_buffer* proxy = nullptr;
  uint8_t* data = nullptr;
  size_t size = 0;
  uint32_t format = 0;
  int width = 0, height = 0, stride = 0;

  ~Buffer() {
    if (proxy) wl_buffer_destroy(proxy);
    if (data) munmap(data, size);
  }

  void init(wl_shm* shm, uint32_t offeredFormat, int offeredWidth, int offeredHeight, int offeredStride) {
    format = offeredFormat; width = offeredWidth; height = offeredHeight; stride = offeredStride;
    size = size_t(stride) * size_t(height);
    FileDescriptor fd = createMemfd("relay-wayland-capture");
    require(fd.get() >= 0, "creating Wayland shared memory failed");
    require(ftruncate(fd.get(), static_cast<off_t>(size)) == 0, "sizing Wayland shared memory failed");
    void* mapping = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd.get(), 0);
    require(mapping != MAP_FAILED, "mapping Wayland shared memory failed");
    data = static_cast<uint8_t*>(mapping);
    std::unique_ptr<wl_shm_pool, decltype(&wl_shm_pool_destroy)> pool(
      wl_shm_create_pool(shm, fd.get(), static_cast<int32_t>(size)), &wl_shm_pool_destroy);
    require(bool(pool), "creating Wayland shared memory pool failed");
    proxy = wl_shm_pool_create_buffer(pool.get(), 0, width, height, stride, format);
    require(proxy, "creating Wayland shared memory buffer failed");
  }

  void orient(bool inverted) {
    if (inverted) {
      for (int row = 0; row < height / 2; ++row)
        std::swap_ranges(data + size_t(row) * stride, data + size_t(row + 1) * stride,
                         data + size_t(height - row - 1) * stride);
    }
  }

  FrameView view() const { return {data, stride, width, height, PixelFormat::BGRA}; }
};

struct Frame {
  zwlr_screencopy_frame_v1* proxy = nullptr;
  int target = 0;
  bool damageCopy = false, hasShm = false, hasDmabuf = false;
  bool bufferDone = false, copied = false, ready = false, failed = false;
  uint32_t format = 0, width = 0, height = 0, stride = 0, dmabufFormat = 0, flags = 0;
  std::vector<DamageRect> damage;
  std::exception_ptr error;

  ~Frame() { if (proxy) zwlr_screencopy_frame_v1_destroy(proxy); }
};

void frameBuffer(void* data, zwlr_screencopy_frame_v1*, uint32_t format,
                 uint32_t width, uint32_t height, uint32_t stride) {
  auto& frame = *static_cast<Frame*>(data);
  frame.hasShm = true; frame.format = format; frame.width = width; frame.height = height; frame.stride = stride;
}
void frameFlags(void* data, zwlr_screencopy_frame_v1*, uint32_t flags) {
  static_cast<Frame*>(data)->flags = flags;
}
void frameReady(void* data, zwlr_screencopy_frame_v1*, uint32_t, uint32_t, uint32_t) {
  static_cast<Frame*>(data)->ready = true;
}
void frameFailed(void* data, zwlr_screencopy_frame_v1*) {
  static_cast<Frame*>(data)->failed = true;
}
void frameDamage(void* data, zwlr_screencopy_frame_v1*, uint32_t x, uint32_t y,
                 uint32_t width, uint32_t height) {
  auto& frame = *static_cast<Frame*>(data);
  if (x >= frame.width || y >= frame.height) return;
  width = std::min(width, frame.width - x);
  height = std::min(height, frame.height - y);
  if (!width || !height) return;
  try {
    frame.damage.push_back({static_cast<int>(x), static_cast<int>(y),
                            static_cast<int>(width), static_cast<int>(height)});
    if (frame.damage.size() > max_damage_rects)
      frame.damage = {{0, 0, static_cast<int>(frame.width), static_cast<int>(frame.height)}};
  } catch (...) {
    frame.error = std::current_exception();
  }
}
void frameDmabuf(void* data, zwlr_screencopy_frame_v1*, uint32_t format, uint32_t, uint32_t) {
  auto& frame = *static_cast<Frame*>(data);
  frame.hasDmabuf = true; frame.dmabufFormat = format;
}
void frameBufferDone(void* data, zwlr_screencopy_frame_v1*) {
  static_cast<Frame*>(data)->bufferDone = true;
}

const zwlr_screencopy_frame_v1_listener frameListener = {
  frameBuffer, frameFlags, frameReady, frameFailed, frameDamage, frameDmabuf, frameBufferDone
};

class WaylandCaptureSource final : public CaptureSource {
  Connection connection;
  std::array<std::unique_ptr<Buffer>, 3> buffers;
  std::unique_ptr<Frame> frame;
  std::vector<DamageRect> damage;
  const int width, height;
  int current = -1;
  unsigned failures = 0;

  void request(int target, bool damageCopy) {
    auto next = std::make_unique<Frame>();
    next->target = target; next->damageCopy = damageCopy;
    next->proxy = zwlr_screencopy_manager_v1_capture_output(connection.screencopyManager, 0, connection.output);
    require(next->proxy, "requesting Wayland screencopy frame failed");
    require(zwlr_screencopy_frame_v1_add_listener(next->proxy, &frameListener, next.get()) == 0,
            "listening for Wayland screencopy frame failed");
    frame = std::move(next);
  }

  void copy() {
    auto& pending = *frame;
    if (!pending.hasShm || (pending.format != WL_SHM_FORMAT_XRGB8888 && pending.format != WL_SHM_FORMAT_ARGB8888)) {
      const std::string shm = pending.hasShm ? std::to_string(pending.format) : "none";
      const std::string dmabuf = pending.hasDmabuf ? std::to_string(pending.dmabufFormat) : "none";
      throw std::runtime_error("Unsupported Wayland screencopy formats (wl_shm: " + shm +
                               ", linux-dmabuf: " + dmabuf + ")");
    }
    if (pending.width > unsigned(std::numeric_limits<int>::max()) ||
        pending.height > unsigned(std::numeric_limits<int>::max()))
      throw std::runtime_error("Unsupported Wayland screencopy dimensions");
    const int frameWidth = static_cast<int>(pending.width), frameHeight = static_cast<int>(pending.height);
    checkSize(frameWidth, frameHeight);
    require(pending.stride >= pending.width * 4 && pending.stride <= pending.width * 8,
            "Unsupported Wayland screencopy stride");
    auto& buffer = buffers[pending.target];
    if (!buffer || buffer->format != pending.format || buffer->stride != static_cast<int>(pending.stride)) {
      auto replacement = std::make_unique<Buffer>();
      replacement->init(connection.shm, pending.format, frameWidth, frameHeight, static_cast<int>(pending.stride));
      buffer = std::move(replacement);
    }
    if (pending.damageCopy) zwlr_screencopy_frame_v1_copy_with_damage(pending.proxy, buffer->proxy);
    else zwlr_screencopy_frame_v1_copy(pending.proxy, buffer->proxy);
    pending.copied = true;
  }

  bool process() {
    if (!frame) return false;
    if (frame->hasShm && (frame->width != static_cast<uint32_t>(width) ||
                          frame->height != static_cast<uint32_t>(height)))
      throw std::runtime_error("Wayland output size changed from " + std::to_string(width) + "x" +
                               std::to_string(height) + " to " + std::to_string(frame->width) + "x" +
                               std::to_string(frame->height) +
                               "; restart relay and, in attach mode, keep the output mode fixed");
    if (frame->error) std::rethrow_exception(frame->error);
    if (frame->failed) {
      const int target = frame->target;
      const bool damageCopy = frame->damageCopy;
      frame.reset();
      if (!damageCopy) throw std::runtime_error("Wayland screencopy failed");
      if (++failures >= 3) throw std::runtime_error("Wayland screencopy failed three consecutive times");
      request(target, true);
      return false;
    }
    if (frame->ready) {
      const int target = frame->target;
      const bool damageCopy = frame->damageCopy;
      auto& buffer = *buffers[target];
      buffer.orient(frame->flags & ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT);
      failures = 0;
      if (damageCopy) {
        damage.insert(damage.end(), frame->damage.begin(), frame->damage.end());
        if (damage.size() > max_damage_rects) damage = {{0, 0, width, height}};
        current = target;
      }
      frame.reset();
      if (damageCopy) request(1 - target, true);
      return damageCopy;
    }
    if (frame->bufferDone && !frame->copied) copy();
    return false;
  }

  void flush() {
    require(wl_display_flush(connection.display) >= 0, "flushing Wayland requests failed");
  }

  bool dispatch(int timeout) {
    const bool hadFrame = bool(frame);
    require(wl_display_dispatch_pending(connection.display) >= 0, "dispatching Wayland events failed");
    bool dirty = process();
    if (dirty || (hadFrame && !frame)) { flush(); return dirty; }
    while (wl_display_prepare_read(connection.display) != 0) {
      require(wl_display_dispatch_pending(connection.display) >= 0, "dispatching Wayland events failed");
      dirty = process() || dirty;
      if (dirty || (hadFrame && !frame)) { flush(); return dirty; }
    }
    if (wl_display_flush(connection.display) < 0) {
      wl_display_cancel_read(connection.display);
      throw std::runtime_error("flushing Wayland requests failed");
    }
    pollfd descriptor{fd(), POLLIN, 0};
    const int result = poll(&descriptor, 1, timeout);
    const int pollError = errno;
    if (result <= 0 || !(descriptor.revents & POLLIN)) {
      wl_display_cancel_read(connection.display);
      if (result < 0 && pollError != EINTR) throw std::runtime_error("polling Wayland display failed");
      if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL))
        throw std::runtime_error("Wayland display connection closed");
      return dirty;
    }
    require(wl_display_read_events(connection.display) >= 0, "reading Wayland events failed");
    require(wl_display_dispatch_pending(connection.display) >= 0, "dispatching Wayland events failed");
    dirty = process() || dirty;
    flush();
    return dirty;
  }

  void captureBlocking(int target) {
    require(!frame, "Wayland screencopy frame already in flight");
    request(target, false);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (frame) {
      const auto now = std::chrono::steady_clock::now();
      if (now >= deadline) {
        frame.reset();
        throw std::runtime_error("Wayland screencopy timed out");
      }
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
      dispatch(static_cast<int>(remaining));
    }
  }

 public:
  WaylandCaptureSource() : width(connection.width), height(connection.height) {
    require(connection.screencopyManager, "Wayland compositor does not offer zwlr_screencopy_manager_v1");
    require(wl_proxy_get_version(reinterpret_cast<wl_proxy*>(connection.screencopyManager)) >= 3,
            "Wayland compositor must offer zwlr_screencopy_manager_v1 version 3");
    require(connection.shm, "Wayland compositor does not offer wl_shm");
    checkSize(width, height);
  }

  int fd() const override { return wl_display_get_fd(connection.display); }
  std::pair<int, int> dimensions() const override { return {width, height}; }
  PixelFormat pixelFormat() const override { return PixelFormat::BGRA; }
  bool cursorSupported() const override { return false; }
  bool drainDamage() override { return dispatch(0); }

  FrameView capture() override {
    captureBlocking(2);
    return buffers[2]->view();
  }

  FrameView captureChanged(bool) override {
    if (current < 0) {
      captureBlocking(0);
      current = 0;
      request(1, true);
      flush();
    }
    return buffers[current]->view();
  }

  bool changedRects(std::vector<DamageRect>& out) override {
    out = std::move(damage);
    damage.clear();
    return true;
  }
};
}

std::unique_ptr<CaptureSource> makeCaptureSource() {
  return std::make_unique<WaylandCaptureSource>();
}
}
