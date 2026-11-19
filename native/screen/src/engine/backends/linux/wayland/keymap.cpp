#include "backends/linux/wayland/keymap.hpp"
#include "backends/linux/wayland/wayland.hpp"
#include <cstdlib>
#include <cstring>
#include <stdexcept>

namespace relay::wayland {
namespace {
/** XKB text v1 carries names of at most four characters; the serializer renames longer ones, so a spare key needs a short name. */
bool shortName(const char* name) { return name && std::strlen(name) <= 4; }
/** Whether any layout gives keycode a level, so the base keymap already spends that keycode. */
bool hasSymbols(xkb_keymap* keymap, xkb_keycode_t keycode) {
  const xkb_layout_index_t layouts = xkb_keymap_num_layouts_for_key(keymap, keycode);
  for (xkb_layout_index_t layout = 0; layout < layouts; ++layout)
    if (xkb_keymap_num_levels_for_key(keymap, keycode, layout) > 0) return true;
  return false;
}
/** Offset of the closing brace of the keymap's symbols section, where spare key definitions are written. */
size_t symbolsEnd(const std::string& text) {
  const size_t section = text.find("xkb_symbols");
  require(section != std::string::npos, "keymap text has no symbols section");
  const size_t open = text.find('{', section);
  require(open != std::string::npos, "keymap text has a malformed symbols section");
  size_t depth = 0;
  for (size_t index = open; index < text.size(); ++index) {
    if (text[index] == '{') ++depth;
    else if (text[index] == '}' && --depth == 0) return index;
  }
  throw std::runtime_error("keymap text has a malformed symbols section");
}
std::string keysymName(uint32_t symbol) {
  char name[64] = {};
  xkb_keysym_get_name(xkb_keysym_t(symbol), name, sizeof name);
  return name;
}
/** Maps the newline and tab codepoints to the Return and Tab keys, so applications see the named keys. */
xkb_keysym_t textKeysym(uint32_t codepoint) {
  if (codepoint == '\n') return XKB_KEY_Return;
  if (codepoint == '\t') return XKB_KEY_Tab;
  return xkb_utf32_to_keysym(codepoint);
}
}

std::string defaultKeymap() {
  XkbContext context(xkb_context_new(XKB_CONTEXT_NO_FLAGS));
  require(bool(context), "libxkbcommon context unavailable");
  const xkb_rule_names names{};
  XkbKeymap keymap(xkb_keymap_new_from_names(context.get(), &names, XKB_KEYMAP_COMPILE_NO_FLAGS));
  require(bool(keymap), "libxkbcommon cannot compile the default keymap; check the XKB_DEFAULT_* variables");
  char* text = xkb_keymap_get_as_string(keymap.get(), XKB_KEYMAP_FORMAT_TEXT_V1);
  std::string result = text ? text : "";
  std::free(text);
  if (result.empty()) throw std::runtime_error("libxkbcommon cannot serialize the default keymap");
  return result;
}

Keymap::Keymap(const std::string& base) {
  XkbContext context(xkb_context_new(XKB_CONTEXT_NO_FLAGS));
  require(bool(context), "libxkbcommon context unavailable");
  XkbKeymap keymap(xkb_keymap_new_from_string(context.get(), base.c_str(), XKB_KEYMAP_FORMAT_TEXT_V1,
                                              XKB_KEYMAP_COMPILE_NO_FLAGS));
  require(bool(keymap), "libxkbcommon cannot compile the keymap text");
  char* text = xkb_keymap_get_as_string(keymap.get(), XKB_KEYMAP_FORMAT_TEXT_V1);
  require(text, "libxkbcommon cannot serialize the keymap");
  original = text;
  std::free(text);
  for (uint32_t keycode = 9; keycode <= 255; ++keycode) {
    const xkb_keysym_t* symbols = nullptr;
    if (xkb_keymap_key_get_syms_by_level(keymap.get(), keycode, 0, 0, &symbols) != 1) continue;
    direct.emplace(symbols[0], keycode - 8);
  }
  for (uint32_t keycode = 9; keycode <= 255 && slots.size() < spareSlots; ++keycode) {
    if (hasSymbols(keymap.get(), keycode)) continue;
    const char* name = xkb_keymap_key_get_name(keymap.get(), keycode);
    if (!shortName(name)) continue;
    slots.push_back(Slot{keycode - 8, name, 0, 0, 0});
  }
  insertAt = symbolsEnd(original);
  current = original;
}

uint32_t Keymap::assign(uint32_t codepoint, bool& changed) {
  changed = false;
  const xkb_keysym_t symbol = textKeysym(codepoint);
  if (!symbol) return 0;
  const auto existing = direct.find(symbol);
  if (existing != direct.end()) return existing->second;
  for (auto& slot : slots)
    if (slot.codepoint == codepoint) {
      slot.used = ++typed;
      return slot.keycode;
    }
  Slot* slot = nullptr;
  for (auto& candidate : slots)
    if (!candidate.codepoint) { slot = &candidate; break; }
  if (!slot)
    for (auto& candidate : slots)
      if (!slot || candidate.used < slot->used) slot = &candidate;
  if (!slot) return 0;
  slot->codepoint = codepoint;
  slot->symbol = symbol;
  slot->used = ++typed;
  changed = true;
  refresh();
  return slot->keycode;
}

const std::string& Keymap::text() const { return current; }

void Keymap::refresh() {
  current = original.substr(0, insertAt);
  for (const auto& slot : slots) {
    if (!slot.codepoint) continue;
    current += "\t\tkey <" + slot.name + "> { [ " + keysymName(slot.symbol) + " ] };\n";
  }
  current += original.substr(insertAt);
}
}
