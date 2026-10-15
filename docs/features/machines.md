# Machines, devices and moving work

The private copy is a network of one machine ("verify-<you>"), so anything
between two machines cannot be driven with it. Use the tests, or the real
machines with care.

## Machines list
- **Sees:** Home → **Machines** shelf, a row per machine with a green dot and
  "idle" / "N working". The machine screen shows how it is reached
  ("direct · 27ms", "via home").
- **CLI:** `helm machines`, `helm status`, `helm digest`,
  `helm redesignate [machine] pc|vm|nas`.
- **Prove (driven 2026-10-15):** `$V text` on Home shows "verify-<you>" and
  "idle"; `$V click "verify-<you> idle"` opens its screen.
- **Tests:** `test/machine-kind`, `device-presence`, `roster-watch`,
  `gossip`, `lan-discovery`, `direct-mesh`.

## Devices and pairing
- **Sees:** Settings → **Devices & pairing**: "Pair another device", "Add a
  computer" (Laptop or desktop, Always-on VM, NAS, "Make join command"),
  and "PAIRED" devices with "online now · paired 4m ago". Removing a device
  signs it out everywhere.
- **CLI:** `helm add controller|pc|vm|nas`, `helm join`, `helm login`,
  `helm devices`, `helm remove <id>`, `helm leave`.
- **Prove (driven):** `$V key Control+Shift+s; $V click "Devices & pairing";
  $V text` shows "Linux Chrome · this device · online now".
- **Traps:** never press "Make join command" or remove devices on the real
  network to test. Join links expire in minutes.
- **Tests:** `test/auth`, `local-login`, `hub-authz`, `roster-trust`.

## Send a project or a task to another machine
- **Sees:** machine screen → **Send a project**; folder chat ⋯ menu → **Send
  folder** / **Send to another machine** ("Send task"). Progress shows on
  Home; when done: "Task sent" or "Project sent". Returned edits that clash
  show "Returned changes need review".
- **CLI:** `helm send-task <machine> --account <id> [text]`, `helm dispatch`,
  `helm dispatch-status <id>`, `helm handoff <machine>`, `helm receive`,
  `helm send <machine> --grant <token>`, `helm verify <folder>`.
- **Prove:** steps not yet driven; needs two machines.
- **Traps:** both machines need this Helm version (update the VM first). A
  snapshot is capped at 32 MB, 16 MB a file, 20,000 files; use `helm copy`
  past that. It does not use GitHub; the new agent rebuilds dependencies.
- **Tests:** `test/transfers`, `task-transfer`, `transfer-cli`,
  `transfer-check`, `transfer-activity`, `code-transfer`, `handoffs`,
  `send-engine`; `test/browser/transfers`.

## `helm exec` and `helm copy`
- **Sees:** nothing in the app; terminal only.
- **CLI:** `helm exec <machine> [--cwd <path>] [--env N=v] -- <cmd>`, then
  `helm exec-status <machine> <id> --wait` or `helm exec-cancel`.
  `helm copy <machine> <path> [--target-folder] [--exclude] [--dry-run]`.
- **Prove:** steps not yet driven against the private copy.
  `$V rpc exec.start '{"id":"t1","argv":["echo","hi"]}'` then
  `$V rpc exec.read '{"id":"t1","wait":true}'` should show "hi".
- **Traps:** if exec says the command may have started, never rerun it;
  read it with `exec-status`. Output keeps only the last 256 KB for an hour.
  `helm copy` needs rsync 3.2.3+ on both ends; a break resumes on rerun.
- **Tests:** `test/execution`, `execution-rpc`, `copy`,
  `copy-transport`, `bulk-transfer`.

## Take over a CLI that was open before Helm
- **Sees:** a notice in that chat with **Take over**; mid-task it waits for
  the current step.
- **CLI:** `helm integrate [--remove]` makes normal `claude` / `codex`
  commands run under Helm.
- **Prove:** steps not yet driven; needs a real CLI.
- **Tests:** `test/takeover`, `native-cli`, `native-launchers`,
  `native-claude-chat`.
