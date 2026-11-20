#pragma once
#include <CoreGraphics/CoreGraphics.h>

namespace relay {
namespace macos {
/// A display with global bounds and a stream size based on native pixels when available.
struct Display {
  /// CoreGraphics display ID (CGDirectDisplayID).
  CGDirectDisplayID id;
  /// Display bounds in global points, origin at the top-left of the main display.
  CGRect bounds;
  /// Stream width in pixels, even and within the maximum frame size.
  int width;
  /// Stream height in pixels, even and within the maximum frame size.
  int height;
};
/// Finds the display chosen with --output by CGDirectDisplayID, or the main display when none was chosen.
Display findDisplay();
}
}
