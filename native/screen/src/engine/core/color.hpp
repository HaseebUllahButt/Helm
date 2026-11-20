#pragma once

#include <cstdint>

namespace relay {
// Full-range BGRA or ARGB (alpha ignored) to limited-range BT.709 NV12 (interleaved UV).
// Chroma uses a 2x2 box with channels rounded to nearest before conversion.
// Requires disjoint buffers covering every row and positive, even dimensions.
// Invalid pointers, dimensions or strides return false without writing.
bool bgraToNv12(const uint8_t* source, int sourceStride,
                uint8_t* y, int yStride, uint8_t* uv, int uvStride,
                int width, int height);
bool argbToNv12(const uint8_t* source, int sourceStride,
                uint8_t* y, int yStride, uint8_t* uv, int uvStride,
                int width, int height);
}  // namespace relay
