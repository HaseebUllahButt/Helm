#pragma once
#include <string>
#include <utility>
#include <windows.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

namespace relay {
namespace windows {
struct Output {
  Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
  Microsoft::WRL::ComPtr<IDXGIOutput1> output;
  RECT bounds{};
  int width() const { return int(bounds.right - bounds.left); }
  int height() const { return int(bounds.bottom - bounds.top); }
  /// Mip level that halves the display until it fits the stream's maximum frame size.
  int level() const;
  /// Even stream size for this display after scaling by level().
  std::pair<int, int> streamSize() const { return {(width() >> level()) & ~1, (height() >> level()) & ~1}; }
};
/// Finds the display chosen with --output, such as \\.\DISPLAY2, or the primary display when none was chosen.
Output findOutput();
/// Throws with the HRESULT and a readable action when a Windows call fails.
void check(HRESULT result, const char* action);
}
}
