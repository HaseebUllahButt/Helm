#include "wire.hpp"
#include "config.hpp"
#include "core/capture-source.hpp"
#include "core/flow.hpp"
#include <libwebsockets.h>
#include <algorithm>
#include <cstring>

namespace relay {
namespace {
uint8_t* start(std::vector<uint8_t>& out, size_t pre, size_t size, uint8_t type, uint32_t generation) {
  out.assign(pre + size, 0);
  auto* p = out.data() + pre;
  std::memcpy(p, "NSL1", 4); p[4] = 1; p[5] = type;
  put(p+8, generation, 4);
  return p;
}
}  // namespace
uint16_t u16(const uint8_t* p) { return (uint16_t(p[0]) << 8) | p[1]; }
uint32_t u32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
void put(uint8_t* p, uint64_t value, unsigned count) {
  while (count) { p[--count] = uint8_t(value); value >>= 8; }
}
InputEvent inputEvent(const uint8_t* p) {
  const uint32_t raw = u32(p + 4);
  const int64_t value = raw <= INT32_MAX ? int64_t(raw) : int64_t(raw) - (int64_t(1) << 32);
  return {p[0], p[1], u16(p+2), int32_t(value), u16(p+8), u16(p+10), u16(p+12), u16(p+14)};
}
unsigned inputLength(const std::string& text, uint64_t& length) {
  if (text.empty()) return HTTP_STATUS_LENGTH_REQUIRED;
  if (!unsignedNumber(text, length) || !length || length % 16) return HTTP_STATUS_BAD_REQUEST;
  return length > max_input_batch * 16 ? HTTP_STATUS_REQ_ENTITY_TOO_LARGE : 0;
}
bool viewerTarget(const std::string& target, bool& control, bool& viewOnly) {
  control = target == "/control";
  viewOnly = target == "/stream?view=1";
  return control || viewOnly || target == "/stream";
}
bool frameMessage(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint32_t lastSequence, const EncodedFrame& f,
                  uint16_t width, uint16_t height) {
  if (!f.sequence || f.sequence != lastSequence + 1 || !f.width || !f.height ||
      f.width > width || f.height > height || f.annex_b.empty() || f.annex_b.size() > FlowControl::max_bytes ||
      (!lastSequence && !f.keyframe)) return false;
  auto* p = start(out, pre, 32 + f.annex_b.size(), 1, generation);
  put(p+6, f.keyframe ? 1 : 0, 2); put(p+12, f.sequence, 4);
  put(p+16, 12+f.annex_b.size(), 4); put(p+20, f.width, 2); put(p+22, f.height, 2); put(p+24, f.pts_us, 8);
  std::memcpy(p+32, f.annex_b.data(), f.annex_b.size());
  return true;
}
bool cursorMessage(std::vector<uint8_t>& out, size_t pre, uint32_t generation, const CursorImage& c) {
  if (c.width > CursorImage::max_extent || c.height > CursorImage::max_extent ||
      c.rgba.size() != size_t(c.width) * c.height * 4 ||
      (c.width && c.height ? c.xhot >= c.width || c.yhot >= c.height
                          : c.width || c.height || c.xhot || c.yhot)) return false;
  auto* p = start(out, pre, 28 + c.rgba.size(), 6, generation);
  put(p+16, 8 + c.rgba.size(), 4);
  put(p+20, c.width, 2); put(p+22, c.height, 2); put(p+24, c.xhot, 2); put(p+26, c.yhot, 2);
  std::copy(c.rgba.begin(), c.rgba.end(), p+28);
  return true;
}
void controlReady(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint16_t width, uint16_t height) {
  auto* p = start(out, pre, 24, 4, generation);
  put(p+16, 4, 4); put(p+20, width, 2); put(p+22, height, 2);
}
void inputReply(std::vector<uint8_t>& out, size_t pre, uint32_t generation, uint32_t sequence, InputStatus status) {
  auto* p = start(out, pre, 21, 5, generation);
  put(p+12, sequence, 4); put(p+16, 1, 4);
  p[20] = uint8_t(status);
}
}  // namespace relay
