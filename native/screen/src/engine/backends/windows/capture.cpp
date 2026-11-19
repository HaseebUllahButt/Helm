#include "core/capture-source.hpp"
#include "backends/windows/output.hpp"
#include <d3d11.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <chrono>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

namespace relay {
namespace {
using Microsoft::WRL::ComPtr;
/// Damage rectangles a source holds before it treats the next capture as a full frame.
constexpr size_t max_pending_rects = 256;
/// Converts a duplication pointer shape to straight-alpha RGBA, box-filtered down to the stream's scale.
CursorImage cursorImage(const DXGI_OUTDUPL_POINTER_SHAPE_INFO& info, const std::vector<uint8_t>& data, int level) {
  const bool mono = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  const int w = int(info.Width), h = int(mono ? info.Height / 2 : info.Height);
  std::vector<uint8_t> full(size_t(w) * h * 4, 0);
  for (int y = 0; y < h; ++y)
    for (int x = 0; x < w; ++x) {
      uint8_t* out = full.data() + (size_t(y) * w + x) * 4;
      if (mono) {
        const int mask = 0x80 >> (x % 8);
        const bool andBit = data[size_t(y) * info.Pitch + x / 8] & mask;
        const bool xorBit = data[size_t(y + h) * info.Pitch + x / 8] & mask;
        if (andBit && !xorBit) continue;
        const uint8_t value = xorBit ? 255 : 0;
        out[0] = out[1] = out[2] = value; out[3] = 255;
        continue;
      }
      const uint8_t* in = data.data() + size_t(y) * info.Pitch + size_t(x) * 4;
      const bool masked = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR;
      out[0] = in[2]; out[1] = in[1]; out[2] = in[0];
      out[3] = masked ? (in[3] ? (in[0] | in[1] | in[2] ? 255 : 0) : 255) : in[3];
    }
  const int factor = 1 << level;
  const int sw = std::min<int>(CursorImage::max_extent, std::max(1, w / factor));
  const int sh = std::min<int>(CursorImage::max_extent, std::max(1, h / factor));
  CursorImage image;
  image.width = uint16_t(sw); image.height = uint16_t(sh);
  image.xhot = uint16_t(std::min(sw - 1, int(info.HotSpot.x) / factor));
  image.yhot = uint16_t(std::min(sh - 1, int(info.HotSpot.y) / factor));
  image.rgba.assign(size_t(sw) * sh * 4, 0);
  for (int y = 0; y < sh; ++y)
    for (int x = 0; x < sw; ++x) {
      unsigned sum[4] = {}, count = 0;
      for (int dy = 0; dy < factor && y * factor + dy < h; ++dy)
        for (int dx = 0; dx < factor && x * factor + dx < w; ++dx) {
          const uint8_t* p = full.data() + (size_t(y * factor + dy) * w + x * factor + dx) * 4;
          for (int c = 0; c < 3; ++c) sum[c] += p[c] * p[3];
          sum[3] += p[3]; ++count;
        }
      uint8_t* out = image.rgba.data() + (size_t(y) * sw + x) * 4;
      for (int c = 0; c < 3; ++c) out[c] = uint8_t(sum[3] ? sum[c] / sum[3] : 0);
      out[3] = uint8_t(count ? sum[3] / count : 0);
    }
  return image;
}
class WindowsCapture;
/// Owns the one Desktop Duplication a process may hold for a display and fans its frames out to every capture source.
class Duplicator {
 public:
  windows::Output display;
  int width = 0, height = 0;

  static std::shared_ptr<Duplicator> shared() {
    static std::mutex lock;
    static std::weak_ptr<Duplicator> current;
    std::lock_guard<std::mutex> guard(lock);
    auto existing = current.lock();
    if (!existing || existing->failed()) { existing = std::make_shared<Duplicator>(); current = existing; }
    return existing;
  }
  bool failed() {
    std::lock_guard<std::mutex> lock(mutex);
    return !failure.empty();
  }
  Duplicator() : display(windows::findOutput()) {
    level = display.level();
    std::tie(width, height) = display.streamSize();
    requireSurfaceSize(width, height);
    windows::check(D3D11CreateDevice(display.adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                     D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                                     &device, nullptr, &context), "creating the Direct3D device");
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = UINT(width); desc.Height = UINT(height); desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    windows::check(device->CreateTexture2D(&desc, nullptr, &staging), "creating the readback texture");
    if (level) {
      desc.Width = UINT(display.width()); desc.Height = UINT(display.height()); desc.MipLevels = UINT(level + 1);
      desc.Usage = D3D11_USAGE_DEFAULT; desc.CPUAccessFlags = 0;
      desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      desc.MiscFlags = D3D11_RESOURCE_MISC_GENERATE_MIPS;
      windows::check(device->CreateTexture2D(&desc, nullptr, &mips), "creating the scaling texture");
      windows::check(device->CreateShaderResourceView(mips.Get(), nullptr, &mipView), "creating the scaling view");
    }
    duplicate();
    image.assign(size_t(width) * height * 4, 0);
    worker = std::thread([this] { run(); });
  }
  ~Duplicator() {
    stopping = true;
    if (worker.joinable()) worker.join();
  }
  void subscribe(WindowsCapture* source);
  void unsubscribe(WindowsCapture* source);
  /// Waits up to timeout for the first frame so a new source never returns an empty image.
  void waitForFrame(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mutex);
    arrived.wait_for(lock, timeout, [this] { return haveFrame || !failure.empty(); });
  }
  /// Copies the latest image into target, entirely or only inside rects.
  void copy(std::vector<uint8_t>& target, const std::vector<DamageRect>* rects) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!failure.empty()) throw std::runtime_error(failure);
    if (!rects) { target = image; return; }
    for (const auto& rect : *rects)
      for (int y = rect.y; y < rect.y + rect.height; ++y)
        std::memcpy(target.data() + (size_t(y) * width + rect.x) * 4, image.data() + (size_t(y) * width + rect.x) * 4,
                    size_t(rect.width) * 4);
  }
  std::optional<CursorImage> currentCursor() {
    std::lock_guard<std::mutex> lock(mutex);
    if (!shape) return std::nullopt;
    return visible ? *shape : hidden();
  }
  static CursorImage hidden() {
    CursorImage image;
    image.width = image.height = 1;
    image.rgba.assign(4, 0);
    return image;
  }

 private:
  int level = 0;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IDXGIOutputDuplication> duplication;
  ComPtr<ID3D11Texture2D> mips, staging;
  ComPtr<ID3D11ShaderResourceView> mipView;
  std::mutex mutex;
  std::condition_variable arrived;
  std::vector<uint8_t> image;
  std::vector<WindowsCapture*> sources;
  std::optional<CursorImage> shape;
  bool visible = true, haveFrame = false;
  std::string failure;
  std::atomic<bool> stopping{false};
  std::thread worker;

  void duplicate() {
    duplication.Reset();
    const HRESULT result = display.output->DuplicateOutput(device.Get(), &duplication);
    if (result == E_ACCESSDENIED || result == DXGI_ERROR_UNSUPPORTED || result == DXGI_ERROR_SESSION_DISCONNECTED)
      throw std::runtime_error("Desktop Duplication is unavailable; start relay in the signed-in user's desktop session");
    windows::check(result, "duplicating the display");
  }
  void run();
  bool reconnect();
  void fail(const std::string& message);
  void pointer(const DXGI_OUTDUPL_FRAME_INFO& info, std::vector<uint8_t>& data);
  bool dirtyRects(const DXGI_OUTDUPL_FRAME_INFO& info, std::vector<uint8_t>& metadata, std::vector<DamageRect>& damage);
  void copyFrame(const ComPtr<IDXGIResource>& resource, const std::vector<DamageRect>& damage, bool full);
};
/// One consumer of the shared duplication, such as the stream encoder or a screenshot, with its own damage and image.
class WindowsCapture final : public CaptureSource {
 public:
  WindowsCapture() : duplicator(Duplicator::shared()) {
    width = duplicator->width; height = duplicator->height;
    ready = CreateEventW(nullptr, TRUE, TRUE, nullptr);
    if (!ready) throw std::runtime_error("creating the capture event failed");
    front.assign(size_t(width) * height * 4, 0);
    duplicator->subscribe(this);
    duplicator->waitForFrame(std::chrono::seconds(2));
  }
  ~WindowsCapture() override {
    duplicator->unsubscribe(this);
    CloseHandle(ready);
  }
  WaitHandle fd() const override { return ready; }
  std::pair<int, int> dimensions() const override { return {width, height}; }
  PixelFormat pixelFormat() const override { return PixelFormat::BGRA; }
  bool drainDamage() override {
    std::lock_guard<std::mutex> lock(mutex);
    ResetEvent(ready);
    return pendingFull || !pending.empty();
  }
  FrameView capture() override { return captureChanged(true); }
  FrameView captureChanged(bool full) override {
    std::vector<DamageRect> rects;
    {
      std::lock_guard<std::mutex> lock(mutex);
      lastFull = full || pendingFull;
      rects.swap(pending);
      pendingFull = false;
      last = lastFull ? std::vector<DamageRect>{} : rects;
    }
    duplicator->copy(front, lastFull ? nullptr : &rects);
    return {front.data(), width * 4, width, height, PixelFormat::BGRA};
  }
  bool changedRects(std::vector<DamageRect>& rects) override {
    std::lock_guard<std::mutex> lock(mutex);
    if (lastFull) return false;
    rects = last;
    return true;
  }
  bool cursorSupported() const override { return true; }
  std::optional<CursorImage> cursor(bool force) override {
    if (force) return duplicator->currentCursor();
    std::lock_guard<std::mutex> lock(mutex);
    auto next = std::move(cursorPending);
    cursorPending.reset();
    return next;
  }
  /// Called by the duplicator with the damage of each new frame.
  void damaged(const std::vector<DamageRect>& rects, bool full) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!full && !pendingFull) pending.insert(pending.end(), rects.begin(), rects.end());
    if (full || pending.size() > max_pending_rects) { pendingFull = true; pending.clear(); }
    SetEvent(ready);
  }
  /// Called by the duplicator when the pointer shape or visibility changes.
  void cursorChanged(const CursorImage& image) {
    std::lock_guard<std::mutex> lock(mutex);
    cursorPending = image;
    SetEvent(ready);
  }
  /// Called by the duplicator when capture fails; the pending full frame makes the next capture throw the error.
  void failed() {
    std::lock_guard<std::mutex> lock(mutex);
    pendingFull = true;
    pending.clear();
    SetEvent(ready);
  }

 private:
  std::shared_ptr<Duplicator> duplicator;
  int width = 0, height = 0;
  HANDLE ready = nullptr;
  std::mutex mutex;
  std::vector<uint8_t> front;
  std::vector<DamageRect> pending, last;
  bool pendingFull = true, lastFull = true;
  std::optional<CursorImage> cursorPending;
};
void Duplicator::subscribe(WindowsCapture* source) {
  std::lock_guard<std::mutex> lock(mutex);
  sources.push_back(source);
}
void Duplicator::unsubscribe(WindowsCapture* source) {
  std::lock_guard<std::mutex> lock(mutex);
  sources.erase(std::remove(sources.begin(), sources.end(), source), sources.end());
}
void Duplicator::run() {
  std::vector<uint8_t> metadata, shapeData;
  while (!stopping) {
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    const HRESULT result = duplication ? duplication->AcquireNextFrame(100, &info, &resource) : DXGI_ERROR_ACCESS_LOST;
    if (result == DXGI_ERROR_WAIT_TIMEOUT) continue;
    if (result == DXGI_ERROR_ACCESS_LOST || result == DXGI_ERROR_INVALID_CALL) {
      if (!reconnect()) return;
      continue;
    }
    try {
      windows::check(result, "capturing the display");
      std::vector<DamageRect> damage;
      bool full = false;
      if (info.LastMouseUpdateTime.QuadPart) pointer(info, shapeData);
      if (info.LastPresentTime.QuadPart) full = dirtyRects(info, metadata, damage);
      if (full || !damage.empty()) copyFrame(resource, damage, full);
    } catch (const std::exception& error) {
      if (duplication && SUCCEEDED(result)) duplication->ReleaseFrame();
      fail(error.what());
      return;
    }
    duplication->ReleaseFrame();
  }
}
bool Duplicator::reconnect() {
  while (!stopping) {
    try { duplicate(); break; } catch (const std::exception&) {}
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  try {
    const RECT now = windows::findOutput().bounds;
    if (!EqualRect(&now, &display.bounds)) {
      fail("The display changed from " + std::to_string(display.width()) + "x" + std::to_string(display.height()) + " to " +
           std::to_string(now.right - now.left) + "x" + std::to_string(now.bottom - now.top) +
           " or moved; restart relay to stream it");
      return false;
    }
  } catch (const std::exception& error) {
    fail(error.what());
    return false;
  }
  std::lock_guard<std::mutex> lock(mutex);
  for (auto* source : sources) source->damaged({}, true);
  return true;
}
void Duplicator::fail(const std::string& message) {
  duplication.Reset();
  std::lock_guard<std::mutex> lock(mutex);
  failure = message;
  arrived.notify_all();
  for (auto* source : sources) source->failed();
}
void Duplicator::pointer(const DXGI_OUTDUPL_FRAME_INFO& info, std::vector<uint8_t>& data) {
  std::optional<CursorImage> changed;
  if (info.PointerShapeBufferSize) {
    data.resize(info.PointerShapeBufferSize);
    DXGI_OUTDUPL_POINTER_SHAPE_INFO shapeInfo{};
    UINT required = 0;
    windows::check(duplication->GetFramePointerShape(UINT(data.size()), data.data(), &required, &shapeInfo),
                   "reading the pointer shape");
    changed = cursorImage(shapeInfo, data, level);
  }
  std::lock_guard<std::mutex> lock(mutex);
  const bool nowVisible = info.PointerPosition.Visible;
  if (changed) shape = changed;
  if ((!changed && nowVisible == visible) || !shape) { visible = nowVisible; return; }
  visible = nowVisible;
  const CursorImage image = visible ? *shape : hidden();
  for (auto* source : sources) source->cursorChanged(image);
}
bool Duplicator::dirtyRects(const DXGI_OUTDUPL_FRAME_INFO& info, std::vector<uint8_t>& metadata,
                            std::vector<DamageRect>& damage) {
  if (!info.TotalMetadataBufferSize) return true;
  metadata.resize(info.TotalMetadataBufferSize);
  UINT used = 0;
  windows::check(duplication->GetFrameMoveRects(UINT(metadata.size()), reinterpret_cast<DXGI_OUTDUPL_MOVE_RECT*>(metadata.data()), &used),
                 "reading moved regions");
  std::vector<RECT> rects;
  for (UINT i = 0; i < used / sizeof(DXGI_OUTDUPL_MOVE_RECT); ++i)
    rects.push_back(reinterpret_cast<DXGI_OUTDUPL_MOVE_RECT*>(metadata.data())[i].DestinationRect);
  UINT dirty = 0;
  windows::check(duplication->GetFrameDirtyRects(UINT(metadata.size()), reinterpret_cast<RECT*>(metadata.data()), &dirty),
                 "reading changed regions");
  for (UINT i = 0; i < dirty / sizeof(RECT); ++i) rects.push_back(reinterpret_cast<RECT*>(metadata.data())[i]);
  const int round = (1 << level) - 1;
  for (const auto& r : rects) {
    const int x0 = std::clamp(int(r.left) >> level, 0, width), y0 = std::clamp(int(r.top) >> level, 0, height);
    const int x1 = std::clamp((int(r.right) + round) >> level, 0, width);
    const int y1 = std::clamp((int(r.bottom) + round) >> level, 0, height);
    if (x1 > x0 && y1 > y0) damage.push_back({x0, y0, x1 - x0, y1 - y0});
  }
  return false;
}
void Duplicator::copyFrame(const ComPtr<IDXGIResource>& resource, const std::vector<DamageRect>& damage, bool full) {
  ComPtr<ID3D11Texture2D> desktop;
  windows::check(resource.As(&desktop), "reading the desktop image");
  const D3D11_BOX box{0, 0, 0, UINT(width), UINT(height), 1};
  if (level) {
    context->CopySubresourceRegion(mips.Get(), 0, 0, 0, 0, desktop.Get(), 0, nullptr);
    context->GenerateMips(mipView.Get());
    context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, mips.Get(), UINT(level), &box);
  } else {
    context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, desktop.Get(), 0, &box);
  }
  D3D11_MAPPED_SUBRESOURCE mapped{};
  windows::check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "reading back the desktop image");
  const auto* source = static_cast<const uint8_t*>(mapped.pData);
  std::lock_guard<std::mutex> lock(mutex);
  const bool whole = full || !haveFrame;
  if (whole) {
    for (int y = 0; y < height; ++y)
      std::memcpy(image.data() + size_t(y) * width * 4, source + size_t(y) * mapped.RowPitch, size_t(width) * 4);
  } else {
    for (const auto& rect : damage)
      for (int y = rect.y; y < rect.y + rect.height; ++y)
        std::memcpy(image.data() + (size_t(y) * width + rect.x) * 4, source + size_t(y) * mapped.RowPitch + size_t(rect.x) * 4,
                    size_t(rect.width) * 4);
  }
  context->Unmap(staging.Get(), 0);
  haveFrame = true;
  arrived.notify_all();
  for (auto* consumer : sources) consumer->damaged(damage, whole);
}
}  // namespace
namespace windows {
std::unique_ptr<CaptureSource> makeCaptureSource() { return std::make_unique<WindowsCapture>(); }
}
}  // namespace relay
