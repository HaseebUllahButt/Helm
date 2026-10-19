# Machines, devices and moving work

The private copy is a network of one machine ("verify-<you>"), so anything
between two machines cannot be driven with it. Use the tests, or the real
machines with care.

## Machines and devices
- **Prove (driven 2026-10-15):** `$V text` on Home shows "verify-<you>" and
  "idle"; `$V click "verify-<you> idle"` opens its screen. `$V key
  Control+Shift+s; $V click "Devices & pairing"; $V text` shows "Linux
  Chrome · this device · online now".
- **Traps:** never press "Make join command" or remove devices on the real
  network to test. Removing a device signs it out everywhere. Join links
  expire in minutes.
- **Tests:** `test/machine-kind`, `device-presence`, `roster-watch`,
  `gossip`, `lan-discovery`, `direct-mesh`, `auth`, `local-login`,
  `hub-authz`, `roster-trust`.

## Send a project or a task to another machine
- **Not yet driven;** needs two machines.
- **Traps:** both machines need this Helm version (update the VM first). A
  snapshot is capped at 32 MB, 16 MB a file, 20,000 files; use `helm copy`
  past that. It does not use GitHub; the new agent rebuilds dependencies.
- **Tests:** `test/transfers`, `task-transfer`, `transfer-cli`,
  `transfer-check`, `transfer-activity`, `code-transfer`, `handoffs`,
  `send-engine`; `test/browser/transfers`.

## `helm exec` and `helm copy`
- **Not yet driven** against the copy. `$V rpc exec.start
  '{"id":"t1","argv":["echo","hi"]}'` then `$V rpc exec.read
  '{"id":"t1","wait":true}'` should show "hi".
- **Traps:** if exec says the command may have started, never rerun it;
  read it with `exec-status`. Output keeps only the last 256 KB for an hour.
  `helm copy` needs rsync 3.2.3+ on both ends; a break resumes on rerun.
- **Tests:** `test/execution`, `execution-rpc`, `copy`,
  `copy-transport`, `bulk-transfer`.

## Saved CLI conversations and Take over
- **Rules:** a saved Claude, Codex, OpenCode or Pi conversation opens with
  its messages; opening alone starts no agent, and the next message resumes
  it. Take over waits for the current step. A terminal in the same folder
  must not hide the saved conversation. OpenCode 2's shared service reports
  busy chat IDs directly. Its saved tabs count as open only while a terminal
  in their folder is alive. Its process must never be stopped to take over
  one chat. Those chats can continue here after their current step finishes.
- **Prove:** `test/helpers/external-fixtures.mjs` puts outside histories in
  the copy's home and adds their profiles. Open each from the machine
  screen, check the answer and tray, reload and check again. Check that
  Load older chats reaches past the first page and search finds older rows.
  Taking over a live CLI still needs a real one.
- **Traps:** keep the fixture's working folder outside `/tmp` (histories
  there are hidden).
- **Tests:** `test/takeover`, `native-cli`, `native-launchers`,
  `native-claude-chat`, `external-open`; `test/browser/external-open`,
  `native-cli-tray`.
