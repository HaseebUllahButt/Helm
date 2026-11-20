#include "core/capture-source.hpp"
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xdamage.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xfixes.h>
#include <sys/shm.h>
#include <atomic>
#include <stdexcept>
#include <mutex>
#include <algorithm>
#include <memory>
#include <vector>
namespace relay {
namespace {
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
// Xlib's handler is process-wide; the attach probe is limited to this Display.
std::atomic<Display*> probe_display{nullptr};
std::atomic<bool> probe_error{false};
std::atomic<XErrorHandler> previous_handler{nullptr};
std::mutex attach_mutex;
int attachError(Display* display, XErrorEvent* event) {
  if (display == probe_display.load()) { probe_error = true; return 0; }
  const auto previous = previous_handler.load();
  return previous ? previous(display, event) : 0;
}
class X11CaptureSource final : public CaptureSource {
  Display* display = nullptr;
  Damage damage = 0;
  XserverRegion parts = 0;
  std::vector<DamageRect> rects;
  bool rects_valid = false;
  XImage* image = nullptr;
  XShmSegmentInfo shm{};
  bool attached = false;
  int damage_event = 0;
  int cursor_event = 0;
  int width = 0, height = 0;
  bool cursor_dirty = true;
 public:
  X11CaptureSource() { shm.shmid = -1; shm.shmaddr = reinterpret_cast<char*>(-1); }
  ~X11CaptureSource() override {
    if (attached) { XShmDetach(display, &shm); XSync(display, False); }
    if (image) { image->data = nullptr; XDestroyImage(image); }
    if (shm.shmaddr != reinterpret_cast<char*>(-1)) shmdt(shm.shmaddr);
    if (shm.shmid >= 0) shmctl(shm.shmid, IPC_RMID, nullptr);
    if (parts) XFixesDestroyRegion(display, parts);
    if (damage) XDamageDestroy(display, damage);
    if (display) XCloseDisplay(display);
  }
  void init() {
    display = XOpenDisplay(nullptr);
    require(display, "opening X display failed");
    int ignored;
    require(XDamageQueryExtension(display, &damage_event, &ignored), "XDamage unavailable");
    int major = 1, minor = 0;
    require(XFixesQueryExtension(display, &cursor_event, &ignored) &&
            XFixesQueryVersion(display, &major, &minor) && major >= 1, "XFixes cursor tracking unavailable");
    require(XShmQueryExtension(display), "MIT-SHM unavailable");
    const int screen = DefaultScreen(display);
    width = DisplayWidth(display, screen); height = DisplayHeight(display, screen);
    image = XShmCreateImage(display, DefaultVisual(display, screen), DefaultDepth(display, screen),
                            ZPixmap, nullptr, &shm, width, height);
    require(image && image->bytes_per_line >= width * 4 && image->bytes_per_line <= width * 8 &&
            image->bits_per_pixel == 32 && image->red_mask == 0xff0000 &&
            image->green_mask == 0xff00 && image->blue_mask == 0xff,
            "unsupported X image masks, depth, or stride");
    require(image->byte_order == LSBFirst || image->byte_order == MSBFirst,
            "unsupported X image byte order");
    const size_t size = static_cast<size_t>(image->bytes_per_line) * image->height;
    shm.shmid = shmget(IPC_PRIVATE, size, IPC_CREAT | 0600);
    require(shm.shmid >= 0, "shmget failed");
    shm.shmaddr = static_cast<char*>(shmat(shm.shmid, nullptr, 0));
    require(shm.shmaddr != reinterpret_cast<char*>(-1), "shmat failed");
    image->data = shm.shmaddr; shm.readOnly = False;
    std::lock_guard<std::mutex> lock(attach_mutex);
    XSync(display, False);
    probe_display = display; probe_error = false;
    previous_handler = XSetErrorHandler(attachError);
    const bool requested = XShmAttach(display, &shm);
    XSync(display, False);
    XSetErrorHandler(previous_handler.load()); probe_display = nullptr;
    attached = requested && !probe_error;
    require(attached, "XShmAttach failed");
    require(shmctl(shm.shmid, IPC_RMID, nullptr) == 0, "marking shared memory for removal failed");
    shm.shmid = -1;
    damage = XDamageCreate(display, RootWindow(display, screen), XDamageReportNonEmpty);
    require(damage != 0, "creating XDamage failed");
    parts = XFixesCreateRegion(display, nullptr, 0);
    XFixesSelectCursorInput(display, RootWindow(display, screen), XFixesDisplayCursorNotifyMask);
    XFlush(display);
  }
  int fd() const override { return ConnectionNumber(display); }
  std::pair<int, int> dimensions() const override { return {width, height}; }
  bool drainDamage() override {
    bool dirty = false;
    while (XPending(display)) {
      XEvent event; XNextEvent(display, &event);
      if (event.type == damage_event + XDamageNotify) dirty = true;
      if (event.type == cursor_event + XFixesCursorNotify) cursor_dirty = true;
    }
    return dirty;
  }
  bool cursorSupported() const override { return true; }
  std::optional<CursorImage> cursor(bool force) override {
    if (!force && !cursor_dirty) return std::nullopt;
    cursor_dirty = false;
    std::unique_ptr<XFixesCursorImage, decltype(&XFree)> image(XFixesGetCursorImage(display), &XFree);
    CursorImage result;
    // Bound an application-provided image; never leave a previous shape stuck on failure.
    if (!image || !image->width || !image->height ||
        image->width > CursorImage::max_extent || image->height > CursorImage::max_extent ||
        image->xhot >= image->width || image->yhot >= image->height) return result;
    result.width = image->width; result.height = image->height;
    result.xhot = image->xhot; result.yhot = image->yhot;
    result.rgba.resize(size_t(result.width) * result.height * 4);
    for (size_t pixel = 0; pixel < result.rgba.size() / 4; ++pixel) {
      // Xlib uses unsigned long even on LP64; XFixes colors are premultiplied ARGB.
      const uint32_t argb = uint32_t(image->pixels[pixel]);
      const unsigned alpha = argb >> 24;
      for (unsigned channel = 0; channel < 3; ++channel) {
        const unsigned component = (argb >> (16 - channel * 8)) & 255;
        result.rgba[pixel * 4 + channel] = alpha ? std::min(255u, (component * 255 + alpha / 2) / alpha) : 0;
      }
      result.rgba[pixel * 4 + 3] = alpha;
    }
    return result;
  }
  PixelFormat pixelFormat() const override {
    return image->byte_order == LSBFirst ? PixelFormat::BGRA : PixelFormat::ARGB;
  }
  bool changedRects(std::vector<DamageRect>& out) override {
    if (!rects_valid) return false;
    out = rects;
    return true;
  }
  void collectDamage() {
    XDamageSubtract(display, damage, None, parts);
    rects.clear(); rects_valid = false;
    int count = 0;
    std::unique_ptr<XRectangle, decltype(&XFree)> fetched(XFixesFetchRegion(display, parts, &count), &XFree);
    if (fetched && count > 0) {
      for (int i = 0; i < count; ++i)
        rects.push_back({fetched.get()[i].x, fetched.get()[i].y, fetched.get()[i].width, fetched.get()[i].height});
      rects_valid = true;
    }
  }
  FrameView grab(int x, int y, int width, int height) {
    const Window root = RootWindow(display, DefaultScreen(display));
    if (x == 0 && y == 0 && width == image->width && height == image->height) {
      require(XShmGetImage(display, root, image, 0, 0, AllPlanes), "XShmGetImage failed");
      return {reinterpret_cast<const uint8_t*>(image->data), image->bytes_per_line,
              image->width, image->height, pixelFormat(), 0, 0};
    }
    XImage* scratch = XShmCreateImage(display, DefaultVisual(display, DefaultScreen(display)),
                                      DefaultDepth(display, DefaultScreen(display)), ZPixmap,
                                      shm.shmaddr, &shm, width, height);
    require(scratch, "creating sub-rect X image failed");
    scratch->data = shm.shmaddr;
    require(scratch->bytes_per_line == width * 4, "unexpected sub-rect X image stride");
    const bool ok = XShmGetImage(display, root, scratch, x, y, AllPlanes);
    FrameView view{reinterpret_cast<const uint8_t*>(scratch->data), scratch->bytes_per_line,
                   width, height, pixelFormat(), x, y};
    scratch->data = nullptr;
    XDestroyImage(scratch);
    require(ok, "XShmGetImage failed");
    return view;
  }
  FrameView capture() override {
    collectDamage();
    return grab(0, 0, image->width, image->height);
  }
  FrameView captureChanged(bool full) override {
    collectDamage();
    if (full || !rects_valid || rects.empty() || pixelFormat() == PixelFormat::ARGB)
      return grab(0, 0, image->width, image->height);
    int x0 = image->width, y0 = image->height, x1 = 0, y1 = 0;
    for (const auto& r : rects) {
      if (r.width <= 0 || r.height <= 0) continue;
      x0 = std::min(x0, std::clamp(r.x, 0, image->width));
      y0 = std::min(y0, std::clamp(r.y, 0, image->height));
      x1 = std::max(x1, std::clamp(r.x + r.width, 0, image->width));
      y1 = std::max(y1, std::clamp(r.y + r.height, 0, image->height));
    }
    if (x1 <= x0 || y1 <= y0) return grab(0, 0, image->width, image->height);
    x0 &= ~15; y0 &= ~15;
    x1 = std::min((x1 + 15) & ~15, image->width);
    y1 = std::min((y1 + 15) & ~15, image->height);
    return grab(x0, y0, x1 - x0, y1 - y0);
  }
};
}
namespace x11 {
bool initializeNativeBackend(const std::string&) {
  static std::once_flag once;
  static bool initialized = false;
  std::call_once(once, [] { initialized = XInitThreads() != 0; });
  return initialized;
}
std::unique_ptr<CaptureSource> makeCaptureSource() {
  auto source = std::make_unique<X11CaptureSource>();
  source->init();
  return source;
}
}
}
