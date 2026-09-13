#!/usr/bin/env bash
# Install the helm desktop app for the current user.
#
# Tauri's AppImage bundler downloads its tooling from raw.githubusercontent.com,
# which is not reachable from every network. This installs the binary that was
# already built, which is all an Arch-style system needs anyway.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HERE/src-tauri/target/release/helm-desktop"

if [ ! -x "$BIN" ]; then
  echo "not built yet - run: npm run desktop:build" >&2
  exit 1
fi

install -Dm755 "$BIN" "$HOME/.local/bin/helm-desktop"

ICONS="$HOME/.local/share/icons"
SVG="$HERE/../web/public/icon.svg"
PNG="$HERE/../web/public/icon-512.png"

render() {  # size dest
  if command -v rsvg-convert >/dev/null; then
    rsvg-convert -w "$1" -h "$1" "$SVG" -o "$2"
  elif command -v magick >/dev/null; then
    magick "$PNG" -resize "${1}x${1}" "$2"
  else
    install -Dm644 "$PNG" "$2"
  fi
}

for size in 32 48 64 128 256 512; do
  dest="$ICONS/hicolor/${size}x${size}/apps/helm.png"
  mkdir -p "$(dirname "$dest")"
  render "$size" "$dest"
done
install -Dm644 "$SVG" "$ICONS/hicolor/scalable/apps/helm.svg"

# A user icon theme with no index.theme is never indexed, so the icons are
# installed but invisible - which looks exactly like a missing icon.
if [ ! -f "$ICONS/hicolor/index.theme" ]; then
  if [ -f /usr/share/icons/hicolor/index.theme ]; then
    cp /usr/share/icons/hicolor/index.theme "$ICONS/hicolor/index.theme"
  else
    cat > "$ICONS/hicolor/index.theme" <<'THEME'
[Icon Theme]
Name=Hicolor
Comment=Fallback icon theme
Directories=32x32/apps,48x48/apps,64x64/apps,128x128/apps,256x256/apps,512x512/apps,scalable/apps

[32x32/apps]
Size=32
Context=Applications
Type=Fixed

[48x48/apps]
Size=48
Context=Applications
Type=Fixed

[64x64/apps]
Size=64
Context=Applications
Type=Fixed

[128x128/apps]
Size=128
Context=Applications
Type=Fixed

[256x256/apps]
Size=256
Context=Applications
Type=Fixed

[512x512/apps]
Size=512
Context=Applications
Type=Fixed

[scalable/apps]
MinSize=16
Size=128
MaxSize=512
Context=Applications
Type=Scalable
THEME
  fi
fi

# Some launchers read neither theme; give them a flat copy too.
install -Dm644 "$ICONS/hicolor/256x256/apps/helm.png" "$HOME/.local/share/pixmaps/helm.png"

# An absolute path removes icon-theme lookup from the equation entirely,
# which is the one thing every launcher agrees on.
install -Dm644 /dev/stdin "$HOME/.local/share/applications/helm.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=helm
Comment=Control your coding agents on every machine you own
Exec=$HOME/.local/bin/helm-desktop
Icon=$ICONS/hicolor/256x256/apps/helm.png
Terminal=false
Categories=Development;
StartupWMClass=helm
DESKTOP

command -v update-desktop-database >/dev/null && \
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
if command -v gtk-update-icon-cache >/dev/null; then
  gtk-update-icon-cache -f -t "$ICONS/hicolor" || \
    echo "  (icon cache refresh failed - icons are still installed)"
fi

echo "installed: $HOME/.local/bin/helm-desktop"
echo "it should now appear in your launcher as \"helm\""
