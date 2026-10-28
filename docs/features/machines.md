# Machines, devices and moving work

Each private copy starts with one machine ("verify-<you>"). Pair two private
copies only with each other to test work between machines. For automatic task
returns, keep each private `HELM_DIR` inside its private `HOME`. The default
verify-helm folders are siblings, so a custom private daemon needs a containing
home. Return materialization refuses folders outside that home. Never use the
owner's home or network to bypass this check.

## Machines and devices
- **Prove (driven 2026-10-15):** `$V text` on Home shows "verify-<you>" and
  "idle"; `$V click "verify-<you> idle"` opens its screen. `$V key
  Control+Shift+s; $V click "Devices & pairing"; $V text` shows "Linux
  Chrome · this device · online now".
- **Traps:** never press "Make join command" or remove devices on the real
  network to test. Removing a device signs it out everywhere. Join links
  expire in minutes. Public machines need inbound UDP 44301–44332 in both
  cloud and host firewalls for direct links. Native peers share these ports;
  `config.json` can override them with `directPorts: {begin, end}`. The end
  must be greater than the beginning. Private tests must match their own
  firewall rules and never change the owner's network.
- **Tests:** `test/machine-kind`, `device-presence`, `roster-watch`,
  `gossip`, `lan-discovery`, `direct-mesh`, `auth`, `local-login`,
  `hub-authz`, `roster-trust`.

## Check installation and connections
- Open Settings and select **Check connection**. Each answering machine reports
  its paths to the others. A failed read identifies the device-to-machine step.
  A route proves a path is present, not that a chat or agent can run.
- Open **Recent connection changes** for observations from each machine. The
  last 100 changes survive restarts. Samples run every 15 seconds and on checks;
  short failures between samples may be absent. Last seen means a route was
  observed, not that a message was delivered.
- Select **Save support report** to download fixed fields with generated
  machine names. Reports omit addresses, keys, raw errors and chat data.
- Run `helm doctor` on the affected machine. Use `--json` for a support report.
  It reads status only. It never starts a service or changes settings.
- The live connection check stays on loopback. A healthy remote home must not
  hide a failed local service. A home health reply proves only its web response.
- Reports omit addresses, keys, account data, and raw errors. A route count
  does not prove a missing machine is asleep. Check that machine separately.
- **Tests:** `test/doctor`, `connection-history`, `help`;
  `test/browser/connection-check`.

## Send a project or a task to another machine
- **Prove (driven 2026-10-21):** use two private Helm copies, each with its
  own home and sockets, paired only with each other. Open the source machine,
  choose **Send a project**, choose a folder, then **Send to** the target.
  Slow the test sender to observe progress, choose **Cancel send**, then
  **Retry**. Check the received files after **Sent** appears.
- **Proof:** a 36 MB file resumed with the same job and destination. Its
  SHA-256 matched, an executable kept mode 0751, and its symlink survived.
  Interrupted-job and signed-receipt recovery are also covered by the tests.
- **Traps:** current Send streams files without the old snapshot size or
  file-count caps. It keeps source files. Sending again keeps files created
  on the target.
  Older targets show a compatibility message: their copy has no atomic
  publication or signed completion receipt. A lost start reply needs **Check
  status**, not another send. A stopped send's **Retry** uses its original
  destination. Git history travels with current Send; dependencies and caches
  stay behind. It does not use GitHub; a new agent rebuilds dependencies.
- **Tests:** `test/transfers`, `task-transfer`, `transfer-cli`,
  `transfer-check`, `transfer-activity`, `code-transfer`, `handoffs`,
  `send-engine`, `send-recovery`; `test/browser/transfers`, `send-v2`.

## `helm exec` and `helm copy`
- **Not yet driven** against the copy. `$V rpc exec.start
  '{"id":"t1","argv":["echo","hi"]}'` then `$V rpc exec.read
  '{"id":"t1","wait":true}'` should show "hi".
- **Traps:** if exec says the command may have started, never rerun it;
  read it with `exec-status`. Output keeps only the last 256 KB for an hour.
  `helm copy` needs rsync 3.2.3+ on both ends; a break resumes on rerun.
  With protected arguments, rsync receives its folder and options inside
  the byte stream. Check those before passing them to rsync, and bind the
  folder to the signed request. A Send must also match its approved stage.
  Plain copy still permits the sender to choose an absolute destination;
  this check is not a general file sandbox. Unsupported options fail with
  no retry, so a newer rsync needs a reviewed allowlist change.
- **Tests:** `test/execution`, `execution-rpc`, `copy`,
  `copy-transport`, `copy-arguments`, `copy-binary`, `bulk-transfer`.

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
