#include "backends/windows/output.hpp"
#include "core/capture-source.hpp"
#include <cstdio>
#include <mutex>
#include <stdexcept>

namespace relay {
namespace windows {
namespace {
std::string chosen;
std::string narrow(const wchar_t* text) {
  std::string out;
  for (; *text; ++text) out += *text < 128 ? char(*text) : '?';
  return out;
}
}
int Output::level() const {
  int level = 0;
  while ((width() >> level) > max_frame_width || (height() >> level) > max_frame_height) ++level;
  return level;
}
void check(HRESULT result, const char* action) {
  if (SUCCEEDED(result)) return;
  char code[16];
  std::snprintf(code, sizeof(code), "0x%08lx", static_cast<unsigned long>(result));
  throw std::runtime_error(std::string(action) + " failed (" + code + ")");
}
Output findOutput() {
  Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
  check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "creating the DXGI factory");
  std::string names;
  Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
  for (UINT a = 0; SUCCEEDED(factory->EnumAdapters1(a, &adapter)); ++a) {
    Microsoft::WRL::ComPtr<IDXGIOutput> candidate;
    for (UINT o = 0; SUCCEEDED(adapter->EnumOutputs(o, &candidate)); ++o) {
      DXGI_OUTPUT_DESC desc;
      if (FAILED(candidate->GetDesc(&desc)) || !desc.AttachedToDesktop) continue;
      const std::string name = narrow(desc.DeviceName);
      names += (names.empty() ? "" : ", ") + name;
      const bool primary = desc.DesktopCoordinates.left == 0 && desc.DesktopCoordinates.top == 0;
      if (chosen.empty() ? !primary : name != chosen) continue;
      Output found;
      found.adapter = adapter;
      check(candidate.As(&found.output), "opening the display for duplication");
      found.bounds = desc.DesktopCoordinates;
      return found;
    }
  }
  if (names.empty())
    throw std::runtime_error("No display is attached to this session; start relay in the signed-in user's desktop session");
  throw std::runtime_error(chosen.empty() ? "No primary display is attached to the desktop"
                                          : "Display " + chosen + " not found; attached displays: " + names);
}
bool initializeNativeBackend(const std::string& output) {
  static std::once_flag once;
  static bool initialized = false;
  std::call_once(once, [&] {
    chosen = output;
    initialized = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) ||
                  GetLastError() == ERROR_ACCESS_DENIED;
  });
  return initialized;
}
}
}
