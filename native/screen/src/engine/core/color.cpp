#include "color.hpp"

#include <cstddef>
#include <limits>

#if defined(__aarch64__)
#include <arm_neon.h>
#endif

#if defined(__SSE2__)
#include <emmintrin.h>
#endif

namespace relay {
namespace {
// BT.709 coefficients scaled by 2^14; biases keep all shifts nonnegative.
uint8_t luma(int b, int g, int r) {
  return static_cast<uint8_t>((2991 * r + 10064 * g + 1016 * b + 8192) / 16384 + 16);
}
uint8_t blueChroma(int b, int g, int r) {
  return static_cast<uint8_t>((128 * 16384 + 8192 - 1649 * r - 5547 * g + 7196 * b) / 16384);
}
uint8_t redChroma(int b, int g, int r) {
  return static_cast<uint8_t>((128 * 16384 + 8192 + 7196 * r - 6536 * g - 660 * b) / 16384);
}

#if defined(__aarch64__)
/** BT.709 limited-range luma for 8 pixels with 8-bit coefficients in 16-bit lanes. */
uint8x8_t luma8(uint8x8_t b, uint8x8_t g, uint8x8_t r) {
  auto sum = vmlal_u8(vmlal_u8(vmull_u8(r, vdup_n_u8(47)), g, vdup_n_u8(157)), b, vdup_n_u8(16));
  return vadd_u8(vshrn_n_u16(vaddq_u16(sum, vdupq_n_u16(128)), 8), vdup_n_u8(16));
}
/** Averages vertically adjacent pixel pairs and then horizontal neighbours, rounding to nearest. */
uint8x8_t box8(uint8x16_t top, uint8x16_t bottom) {
  return vmovn_u16(vrshrq_n_u16(vaddq_u16(vpaddlq_u8(top), vpaddlq_u8(bottom)), 2));
}
#endif

#if defined(__SSE2__)
void splitBgra8(const uint8_t* src, __m128i& b, __m128i& g, __m128i& r) {
  const auto mask = _mm_set1_epi32(0xFF);
  const auto lo = _mm_loadu_si128(reinterpret_cast<const __m128i*>(src));
  const auto hi = _mm_loadu_si128(reinterpret_cast<const __m128i*>(src + 16));
  b = _mm_packs_epi32(_mm_and_si128(lo, mask), _mm_and_si128(hi, mask));
  g = _mm_packs_epi32(_mm_and_si128(_mm_srli_epi32(lo, 8), mask),
                      _mm_and_si128(_mm_srli_epi32(hi, 8), mask));
  r = _mm_packs_epi32(_mm_and_si128(_mm_srli_epi32(lo, 16), mask),
                      _mm_and_si128(_mm_srli_epi32(hi, 16), mask));
}
__m128i lumaBlock8(__m128i b, __m128i g, __m128i r) {
  const auto ones = _mm_set1_epi16(1);
  const auto rgCoef = _mm_setr_epi16(2991, 10064, 2991, 10064, 2991, 10064, 2991, 10064);
  const auto bCoef = _mm_setr_epi16(1016, 8192, 1016, 8192, 1016, 8192, 1016, 8192);
  const auto bias = _mm_set1_epi32(16);
  const auto lo = _mm_add_epi32(
      _mm_srai_epi32(_mm_add_epi32(_mm_madd_epi16(_mm_unpacklo_epi16(r, g), rgCoef),
                                   _mm_madd_epi16(_mm_unpacklo_epi16(b, ones), bCoef)), 14),
      bias);
  const auto hi = _mm_add_epi32(
      _mm_srai_epi32(_mm_add_epi32(_mm_madd_epi16(_mm_unpackhi_epi16(r, g), rgCoef),
                                   _mm_madd_epi16(_mm_unpackhi_epi16(b, ones), bCoef)), 14),
      bias);
  const auto packed = _mm_packs_epi32(lo, hi);
  return _mm_packus_epi16(packed, packed);
}
__m128i boxAverage4(__m128i top, __m128i bottom) {
  const auto pairs = _mm_madd_epi16(_mm_add_epi16(top, bottom), _mm_set1_epi16(1));
  return _mm_srai_epi32(_mm_add_epi32(pairs, _mm_set1_epi32(2)), 2);
}
void chromaBlock4(__m128i blue, __m128i green, __m128i red, uint8_t* u, uint8_t* v, int step) {
  const auto zero = _mm_setzero_si128();
  const auto b = _mm_packs_epi32(blue, blue);
  const auto g = _mm_packs_epi32(green, green);
  const auto r = _mm_packs_epi32(red, red);
  const auto bias = _mm_set1_epi32(128 * 16384 + 8192);
  const auto cb = _mm_srai_epi32(
      _mm_add_epi32(bias,
                    _mm_add_epi32(_mm_madd_epi16(_mm_unpacklo_epi16(b, g),
                                                 _mm_setr_epi16(7196, -5547, 7196, -5547, 7196, -5547, 7196, -5547)),
                                  _mm_madd_epi16(_mm_unpacklo_epi16(r, zero),
                                                 _mm_setr_epi16(-1649, 0, -1649, 0, -1649, 0, -1649, 0)))),
      14);
  const auto cr = _mm_srai_epi32(
      _mm_add_epi32(bias,
                    _mm_add_epi32(_mm_madd_epi16(_mm_unpacklo_epi16(r, g),
                                                 _mm_setr_epi16(7196, -6536, 7196, -6536, 7196, -6536, 7196, -6536)),
                                  _mm_madd_epi16(_mm_unpacklo_epi16(b, zero),
                                                 _mm_setr_epi16(-660, 0, -660, 0, -660, 0, -660, 0)))),
      14);
  const auto packed = _mm_packs_epi32(cb, cr);
  uint8_t values[16];
  _mm_storeu_si128(reinterpret_cast<__m128i*>(values), _mm_packus_epi16(packed, packed));
  for (int k = 0; k < 4; ++k) {
    u[k * step] = values[k];
    v[k * step] = values[k + 4];
  }
}
#endif
}  // namespace

template<bool argb>
bool convertToNv12(const uint8_t* source, int sourceStride,
                   uint8_t* y, int yStride, uint8_t* uv, int uvStride,
                   int width, int height) {
  if (!source || !y || !uv || width <= 0 || height <= 0 ||
      (width & 1) || (height & 1) || width > std::numeric_limits<int>::max() / 4 ||
      sourceStride < width * 4 || yStride < width ||
      uvStride < width) return false;
  for (int row = 0; row < height; row += 2) {
    const auto* top = source + static_cast<ptrdiff_t>(row) * sourceStride;
    const auto* bottom = top + sourceStride;
    auto* y0 = y + static_cast<ptrdiff_t>(row) * yStride;
    auto* y1 = y0 + yStride;
    auto* uv0 = uv + static_cast<ptrdiff_t>(row / 2) * uvStride;
    int x = 0;
#if defined(__aarch64__)
    if constexpr (!argb) for (; x <= width - 16; x += 16) {
      const auto a = vld4q_u8(top + x * 4);
      const auto b = vld4q_u8(bottom + x * 4);
      vst1q_u8(y0 + x, vcombine_u8(luma8(vget_low_u8(a.val[0]), vget_low_u8(a.val[1]), vget_low_u8(a.val[2])),
                                   luma8(vget_high_u8(a.val[0]), vget_high_u8(a.val[1]), vget_high_u8(a.val[2]))));
      vst1q_u8(y1 + x, vcombine_u8(luma8(vget_low_u8(b.val[0]), vget_low_u8(b.val[1]), vget_low_u8(b.val[2])),
                                   luma8(vget_high_u8(b.val[0]), vget_high_u8(b.val[1]), vget_high_u8(b.val[2]))));
      const auto blue = box8(a.val[0], b.val[0]);
      const auto green = box8(a.val[1], b.val[1]);
      const auto red = box8(a.val[2], b.val[2]);
      const auto bias = vdupq_n_u16(128 * 256 + 128);
      auto cb = vmlal_u8(bias, blue, vdup_n_u8(112));
      cb = vmlsl_u8(vmlsl_u8(cb, red, vdup_n_u8(26)), green, vdup_n_u8(86));
      auto cr = vmlal_u8(bias, red, vdup_n_u8(112));
      cr = vmlsl_u8(vmlsl_u8(cr, green, vdup_n_u8(102)), blue, vdup_n_u8(10));
      const uint8x8x2_t chroma = {{vshrn_n_u16(cb, 8), vshrn_n_u16(cr, 8)}};
      vst2_u8(uv0 + x, chroma);
    }
#endif
#if defined(__SSE2__)
    if constexpr (!argb) for (; x <= width - 8; x += 8) {
      __m128i tb, tg, tr, bb, bg, br;
      splitBgra8(top + x * 4, tb, tg, tr);
      splitBgra8(bottom + x * 4, bb, bg, br);
      _mm_storel_epi64(reinterpret_cast<__m128i*>(y0 + x), lumaBlock8(tb, tg, tr));
      _mm_storel_epi64(reinterpret_cast<__m128i*>(y1 + x), lumaBlock8(bb, bg, br));
      chromaBlock4(boxAverage4(tb, bb), boxAverage4(tg, bg), boxAverage4(tr, br),
                   uv0 + x, uv0 + x + 1, 2);
    }
#endif
    for (; x < width; x += 2) {
      const auto* a = top + x * 4;
      const auto* b = bottom + x * 4;
      constexpr int blueOffset = argb ? 3 : 0;
      constexpr int greenOffset = argb ? 2 : 1;
      constexpr int redOffset = argb ? 1 : 2;
      y0[x] = luma(a[blueOffset], a[greenOffset], a[redOffset]);
      y0[x + 1] = luma(a[4 + blueOffset], a[4 + greenOffset], a[4 + redOffset]);
      y1[x] = luma(b[blueOffset], b[greenOffset], b[redOffset]);
      y1[x + 1] = luma(b[4 + blueOffset], b[4 + greenOffset], b[4 + redOffset]);
      const int blue = (a[blueOffset] + a[4 + blueOffset] + b[blueOffset] + b[4 + blueOffset] + 2) / 4;
      const int green = (a[greenOffset] + a[4 + greenOffset] + b[greenOffset] + b[4 + greenOffset] + 2) / 4;
      const int red = (a[redOffset] + a[4 + redOffset] + b[redOffset] + b[4 + redOffset] + 2) / 4;
      uv0[x] = blueChroma(blue, green, red);
      uv0[x + 1] = redChroma(blue, green, red);
    }
  }
  return true;
}
bool bgraToNv12(const uint8_t* source, int sourceStride,
                uint8_t* y, int yStride, uint8_t* uv, int uvStride,
                int width, int height) {
  return convertToNv12<false>(source, sourceStride, y, yStride, uv, uvStride, width, height);
}
bool argbToNv12(const uint8_t* source, int sourceStride,
                uint8_t* y, int yStride, uint8_t* uv, int uvStride,
                int width, int height) {
  return convertToNv12<true>(source, sourceStride, y, yStride, uv, uvStride, width, height);
}
}  // namespace relay
