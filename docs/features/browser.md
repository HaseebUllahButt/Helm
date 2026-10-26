# Browser for chats

Each chat has its own browser: a real Chromium window beside Helm on a
machine with a screen, hidden on the VM. Helm's panel is only a remote.
Design: [`docs/browser-use.md`](../browser-use.md).

## Open the browser panel
- **Reach:** the Browser button in the chat header, or Ctrl/⌘+Shift+B.
  The owner wants Git, Agents, Canvas and Browser always in the header, not
  in the ⋯ menu (2026-10-26). Computers only: a phone has no way in, on
  purpose (the owner does not watch the browser from the phone).
- **Prove (panel driven 2026-10-15, tabs not yet driven):**
  `$V click Browser; $V text` shows "No tabs yet. Agents on verify-<you>
  browse here…" (the phone-size browser is not a touch screen).
- **Traps:** do not open tabs from the private copy on the laptop: a tab may
  open a real Chromium window on the owner's screen. Start the copy with
  `env -u WAYLAND_DISPLAY -u DISPLAY $V up` to keep it hidden. On niri the
  window needs the `helm-browser` window rule.
- **Prove a real window without the owner's screen (driven 2026-10-25):**
  `Xvfb :77 -screen 0 1280x800x24 &`, then run a script that uses
  `BrowserManager` under `env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE
  DISPLAY=:77 XDG_CONFIG_HOME=<empty dir>` (the empty folder skips
  Omarchy's Wayland-only `chromium-flags.conf`). `import -window root` takes
  the picture: a slow page shows its address and "Loading…", never
  "about:blank".
- **Tests:** `test/agent-browser`, `browser-window`, `browser-smarts` (each
  also under `test/browser/`).

## Logins, Show me, saved flows
- **Prove Logins (driven 2026-10-25):** after `up`, write fake profiles into
  `/tmp/helm-verify-<you>/home/.config` with `fixture()` from
  `test/fixtures/browser-logins.mjs` (`net.imput.helium` for Helium), open
  a chat's browser, click the key. Proof: profiles grouped by browser, the
  system default browser first. `HOME=… HELM_DIR=… helm browser logins
  "work in helium" --session <chat>` names the profile it used.
- **Show me and saved flows: not yet driven.**
- **Tests:** `test/browser-logins`, `test/browser/browser-logins`,
  `test/agent-browser`, `browser-smarts`.
