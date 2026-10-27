# Browser for chats

Each chat has its own browser: a real Chromium window beside Helm on a
machine with a screen, hidden on the VM. Helm's panel is only a remote.
Design: [`docs/browser-use.md`](../browser-use.md).

## Open the browser panel
- **Reach:** the Browser button in the chat header, or Ctrl/⌘+Shift+B.
  The owner wants Git, Agents, Canvas and Browser always in the header, not
  in the ⋯ menu (2026-10-26). Computers only: a phone has no way in, on
  purpose (the owner does not watch the browser from the phone).
- **Prove (panel, tabs and reading driven 2026-10-27):** Open a fake chat
  with `$V open --desktop`. Click Browser, type `https://www.google.com/`
  in Browser address and press Enter. The tab says Google; Read page shows
  its text. Title and load events update the panel without its list timer.
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
  also under `test/browser/`), and `test/browser-identity`.
- **Robot checks (2026-10-27):** Sannysoft's browser identity checks passed
  in private hidden Chromium and a window under Xvfb. Its software graphics
  result stayed red in the hidden browser. DeviceAndBrowserInfo reported
  every check false, including control in pages and workers. Console reading
  was not active; see the design note before using it.

## Running apps

- **Reach:** Open Browser. With no tabs, Running apps shows its cards. With
  tabs, use the small Running apps button beside New tab.
- **Prove (private Linux, 2026-10-27):** Start a local web server inside a
  fake chat's project folder. Open Browser, tap its card, and read the page.
  Stop the server: its card goes away on the next scan. Close Browser: no
  discovery timer remains. The browser opens localhost on the chat's machine.
- **Traps:** Discovery reads sockets without requests. It lists TCP apps,
  so a process that serves a binary protocol can have a card too. Project
  ownership excludes the home folder and chats without a project. macOS
  needs `lsof`. Shared Codex app-server children need project ownership.
- **Tests:** `test/browser-apps`, `test/browser/browser-apps`,
  `test/terminal-links`, `test/terminal-browser`, `test/terminal-host`.

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
