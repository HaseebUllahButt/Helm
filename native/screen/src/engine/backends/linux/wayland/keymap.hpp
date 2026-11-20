#pragma once
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include <xkbcommon/xkbcommon.h>

namespace relay::wayland {
struct XkbContextDeleter {
  void operator()(xkb_context* context) const { xkb_context_unref(context); }
};
struct XkbKeymapDeleter {
  void operator()(xkb_keymap* keymap) const { xkb_keymap_unref(keymap); }
};
struct XkbStateDeleter {
  void operator()(xkb_state* state) const { xkb_state_unref(state); }
};
using XkbContext = std::unique_ptr<xkb_context, XkbContextDeleter>;
using XkbKeymap = std::unique_ptr<xkb_keymap, XkbKeymapDeleter>;
using XkbState = std::unique_ptr<xkb_state, XkbStateDeleter>;

/** Most spare keys a Keymap takes: a base keymap that leaves fewer keycodes unbound gets fewer. */
constexpr size_t spareSlots = 32;
/** Returns libxkbcommon's default XKB text v1 keymap. */
std::string defaultKeymap();
/** A virtual keyboard keymap: a base keymap plus spare keys that are reassigned to Unicode codepoints. */
class Keymap {
 public:
  /** Takes an XKB text v1 keymap; throws std::runtime_error if libxkbcommon cannot compile it. */
  explicit Keymap(const std::string& base);
  /** Returns the evdev keycode that types codepoint. Sets changed when text() needs re-upload and returns 0 when no keysym exists. */
  uint32_t assign(uint32_t codepoint, bool& changed);
  /** Current XKB text v1 keymap, NUL-free. */
  const std::string& text() const;

 private:
  struct Slot {
    uint32_t keycode = 0;
    std::string name;
    uint32_t codepoint = 0;
    uint32_t symbol = 0;
    uint64_t used = 0;
  };
  void refresh();
  std::string original;
  std::string current;
  std::map<uint32_t, uint32_t> direct;
  std::vector<Slot> slots;
  size_t insertAt = 0;
  uint64_t typed = 0;
};
}
