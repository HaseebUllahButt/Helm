#include "screenshot.hpp"
#include "backend.hpp"
#include "server.hpp"
#include "core/capture-source.hpp"
#include <libwebsockets.h>
#include <zlib.h>
#include <memory>
#include <stdexcept>

namespace relay {
namespace {
void require(bool ok, const char* error) {
  if (!ok) throw std::runtime_error(error);
}
void append32(std::vector<uint8_t>& bytes, uint32_t value) {
  bytes.push_back(value >> 24); bytes.push_back(value >> 16);
  bytes.push_back(value >> 8); bytes.push_back(value);
}
void chunk(std::vector<uint8_t>& bytes, const char* type, const uint8_t* data, size_t size) {
  append32(bytes, static_cast<uint32_t>(size));
  const size_t start = bytes.size();
  bytes.insert(bytes.end(), type, type + 4);
  if (size) bytes.insert(bytes.end(), data, data + size);
  append32(bytes, static_cast<uint32_t>(crc32(0, bytes.data() + start, size + 4)));
}
struct Resources {
  std::unique_ptr<CaptureSource> source;
  int width = 0, height = 0;
  void init(const Backend& backend) {
    source = backend.capture();
    require(bool(source), "screenshot source unavailable");
    const auto dimensions = source->dimensions();
    width = dimensions.first; height = dimensions.second;
  }
  std::vector<uint8_t> capture() {
    const size_t row = size_t(width) * 3 + 1;
    source->drainDamage();
    const auto image = source->capture();
    require(image.data && image.width == width && image.height == height && image.stride >= width * 4 &&
            image.stride <= width * 8 && (image.format == PixelFormat::BGRA || image.format == PixelFormat::ARGB),
            "unsupported screenshot frame");
    std::vector<uint8_t> pixels(size_t(height) * row);
    for (int y = 0; y < height; ++y) {
      const auto* source = image.data + y * image.stride;
      auto* target = pixels.data() + y * row + 1;
      for (int x = 0; x < width; ++x) {
        target[x * 3] = source[x * 4 + (image.format == PixelFormat::BGRA ? 2 : 1)];
        target[x * 3 + 1] = source[x * 4 + (image.format == PixelFormat::BGRA ? 1 : 2)];
        target[x * 3 + 2] = source[x * 4 + (image.format == PixelFormat::BGRA ? 0 : 3)];
      }
    }
    uLongf compressed_size = compressBound(pixels.size());
    std::vector<uint8_t> compressed(compressed_size);
    require(compress2(compressed.data(), &compressed_size, pixels.data(), pixels.size(), Z_DEFAULT_COMPRESSION) == Z_OK,
            "PNG encode failed");
    std::vector<uint8_t> header;
    append32(header, uint32_t(width)); append32(header, uint32_t(height));
    header.insert(header.end(), {8, 2, 0, 0, 0});
    std::vector<uint8_t> result{137, 80, 78, 71, 13, 10, 26, 10};
    chunk(result, "IHDR", header.data(), header.size());
    chunk(result, "IDAT", compressed.data(), compressed_size);
    chunk(result, "IEND", nullptr, 0);
    require(result.size() <= 8 * 1024 * 1024, "PNG output exceeds 8 MiB");
    return result;
  }
};
}  // namespace
void Screenshot::start(lws_context* context) {
  worker_ = std::thread([this, context] { run(context); });
}
bool Screenshot::request() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (busy_ || stopping_) return false;
  busy_ = requested_ = true; ready_.notify_one(); return true;
}
bool Screenshot::take(std::vector<uint8_t>& bytes, std::string& error) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!complete_) return false;
  bytes = std::move(bytes_); error = std::move(error_);
  complete_ = false; return true;
}
void Screenshot::finish() { std::lock_guard<std::mutex> lock(mutex_); busy_ = false; }
void Screenshot::stop() {
  { std::lock_guard<std::mutex> lock(mutex_); stopping_ = true; ready_.notify_one(); }
  if (worker_.joinable()) worker_.join();
}
void Screenshot::run(lws_context* context) {
  const auto& backend = backendFor(static_cast<Server*>(lws_context_user(context))->config.backend);
  std::unique_ptr<Resources> resources;
  for (;;) {
    { std::unique_lock<std::mutex> lock(mutex_);
      ready_.wait(lock, [this] { return stopping_ || requested_; });
      if (stopping_) return;
      requested_ = false;
    }
    std::vector<uint8_t> result;
    std::string error;
    try {
      if (!resources) { resources = std::make_unique<Resources>(); resources->init(backend); }
      result = resources->capture();
    } catch (const std::exception& failure) { error = failure.what(); resources.reset(); }
    { std::lock_guard<std::mutex> lock(mutex_);
      bytes_ = std::move(result); error_ = std::move(error); complete_ = true;
    }
    lws_cancel_service(context);
  }
}
}  // namespace relay
