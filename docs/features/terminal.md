# Terminal

Helm's terminals are its own (a real pty), not screen copies. They survive a
Helm restart. Whoever typed last sets the size.

## Open, type, close
- **Prove (driven 2026-10-15):**
  ```sh
  $V click "verify-<you> idle"; $V click terminal; sleep 2
  $V eval "document.querySelector('.xterm textarea').focus()"
  $V type 'echo fmap-$((40+2))'; $V key Enter; sleep 1
  $V eval "document.querySelector('.xterm-rows').innerText"   # ends in fmap-42
  $V click more; $V click "Close terminal"; $V click Close    # back, no "Terminal 1"
  ```
- **Traps:** `text` shows only the prompt; read `.xterm-rows` or take a
  `shot`. Ctrl/⌘+Shift+S does not open Settings from a terminal. With no pty
  the button says "terminal (slow: no pty on this machine)". On Node 26 the
  pty part is built from source; without it `helm status` says "herdr panes
  (slow)".
- **Tests:** `test/terminal-browser`, `terminal-host`, `pty`,
  `shared-terminal`, `proc-host`, `pane-keys`.

## Local app links

- **Prove (private Linux, 2026-10-27):** A terminal running a small web
  server opens its printed local address in the chat Browser panel. The
  owner browser keeps one tab.
- **Reach:** Tap a localhost or 127.0.0.1 address with a port in terminal
  output. Helm opens a new tab in that chat's Browser panel.
- **Traps:** The app must still belong to this chat. A stopped or unrelated
  app shows a message in the terminal. Paths, queries and wrapped links work.
- **Tests:** `test/terminal-links`, `test/terminal-browser`, `test/browser-apps`.

## Opening over a slow link
A new terminal shows at once, saying "Opening a terminal on <machine>…",
and becomes the terminal when the machine answers. If it cannot open, the
reason and "Try again" show there. Its first screen comes back with the start
(`session.start` with `attach`), so the app does not ask again.
- **Tests:** `test/browser/global-keys` ("on screen at once"),
  `test/terminal-browser`, `test/session-driver` ("numbered by the machine").

## The owner's own terminal panes
- **Traps:** the private copy sees the owner's real herdr panes (`rpc
  session.list` ids like `pane:wD:p1`, marked `adopted`). Never open, type
  into or close them. A Helm upgrade does not restart the terminal host; a
  dead one can show nothing.
- **Tests:** `test/herdr`, `native-hosts`, `reattach`.

## "View in terminal" from a chat
- **Not yet driven;** the fake agent runs no commands.
- **Tests:** `test/native-cli-tray`; `test/browser/native-cli-tray`.
