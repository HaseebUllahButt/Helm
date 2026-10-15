# Terminal

Helm's terminals are its own (a real pty), not screen copies. They survive a
Helm restart. Whoever typed last sets the size.

## Open a terminal
- **Sees:** machine screen → **terminal** button opens "Terminal 1" in your
  home folder with a prompt. On a phone a key row sits under it: esc, ctrl,
  alt, tab, paste, clear, arrows, `~ | / -`. The button reopens the terminal
  you left (with whatever runs in it); **+** ("New terminal") opens another,
  and tabs switch between them.
- **Prove (driven 2026-10-15):**
  ```sh
  $V click "verify-<you> idle"; $V click terminal; sleep 2
  $V eval "document.querySelector('.xterm textarea').focus()"
  $V type 'echo fmap-$((40+2))'; $V key Enter; sleep 1
  $V eval "document.querySelector('.xterm-rows').innerText"
  ```
- **Proof:** the rows read `echo fmap-$((40+2))` then `fmap-42` (the shell
  ran it). `shot` shows the same.
- **Traps:** `text` shows only the prompt, not the output; read
  `.xterm-rows` or take a `shot`. If the machine has no pty the button says
  "terminal (slow: no pty on this machine)". On Node 26 the pty part is built
  from source; without it terminals go slow (`helm status` says "herdr panes
  (slow)").
- **Tests:** `test/terminal-browser`, `terminal-host`, `pty`,
  `shared-terminal`, `proc-host`, `pane-keys`.

## Rename, close, send folder
- **Sees:** terminal ⋯ menu ("more"): **Rename terminal**, **Send folder**,
  **Close terminal**. Close asks "Close "Terminal 1"? Anything still running
  in it stops." with **Cancel** / **Close**.
- **Prove (close driven):**
  ```sh
  $V click more; $V click "Close terminal"; $V click Close
  ```
- **Proof:** back on the machine screen, no "Terminal 1".
- **Tests:** `test/terminal-host`.

## The owner's own terminal panes
- **Sees:** shells the owner runs at the keyboard (herdr panes) can show in
  Helm and be adopted.
- **Traps:** the private copy sees the owner's real panes (`rpc
  session.list` returns ids like `pane:wD:p1`, marked `adopted`). Never open,
  type into or close them. A Helm upgrade does not restart the terminal
  host; a dead one can show nothing.
- **Tests:** `test/herdr`, `native-hosts`, `reattach`.

## "View in terminal" from a chat
- **Sees:** a link on a command's output in a chat that shows its full
  output or panel.
- **Prove:** steps not yet driven; the fake agent runs no commands.
- **Tests:** `test/native-cli-tray`; `test/browser/native-cli-tray`.
