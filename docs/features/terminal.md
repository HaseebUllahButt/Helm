# Terminal

Helm's terminals are its own (a real pty), not screen copies. They survive a
Helm restart. Whoever typed last sets the size.

## Open, type, close
- **Prove (driven 2026-10-15):**
  ```sh
  $V click "Search anything"; $V type verify-<you>; $V key Enter
  $V click terminal; sleep 2
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
  server opens its printed local address on the chat machine.
  The chat browser uses the external Chromium window.
- **Reach:** Tap a localhost or 127.0.0.1 address with a port in terminal
  output. Helm opens a tab in that chat's external Chromium window.
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

## One memory group each (Linux with systemd)
Each terminal, agent process and Codex daemon runs in its own systemd scope
(`cgroup-scope.js`). When memory runs out, systemd-oomd stops only the
biggest one. On 2026-11-11 one host unit held everything, and oomd stopped
3440 processes and three Codex helpers at once.
- **Decisions:** only grouping, no memory limits. The daemon asks for the
  scope, not the host: the terminal and process hosts keep their old code
  across updates. CLI terminal hosts are versioned and make it themselves
  (`pty.js`). Codex starts its shared daemon itself, so Helm's daemon moves
  it into a scope every 20 s. A memory stop shows as "The computer ran out
  of memory…" in the chat, the terminal and `agent-stops.jsonl`.
- **Traps:** scope names carry the HELM_DIR tag; Helm's own `.service`
  units are only searched by the process that is that unit's main process,
  because an agent's test copy runs inside them. `test:smart` turns scopes
  off (`HELM_NO_SCOPES`); `verify-helm` turns them on (`HELM_SCOPES=1`).
  Read a group with `cat /proc/<pid>/cgroup`.
- **Tests:** `test/cgroup-scope`, `agent-stops`.
