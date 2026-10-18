# Handoff

Open work only. What was done lives in `git log`; why Helm is built this way
lives in `docs/intent.md`. The old 3,000-line report is in git history
(`git show ca26d72:HANDOFF.md`).

Rules for this file: newest note on top, at most 8 lines each. When a note's
work is finished, delete the note. Never append a second account of the same
thing; rewrite it.

## Open

- **Feature guides not yet proven:** drive the steps in `docs/features/` marked
  "not yet driven", starting with rewind and Git.
- **Clone from GitHub, not driven:** "Try again" after a real restart (only
  unit-tested), a machine with two gh accounts, a machine with no gh.
- **macOS and Windows daemons do not update themselves:** nothing restarts
  them after an update.

## Known failing, environmental

- On the laptop, the four "native launch" tests in `native-cli.test.mjs` time
  out, before and after unrelated changes.
- A worktree without a built node-pty hangs in `proc-host.test.mjs`. Fix:
  `npx node-gyp rebuild` in the pty package.
- `test/browser-window.test.mjs`: 5 tests fail on `why` (2026-10-18), with or
  without recent changes. Not looked at yet.

## Machines

- **VM:** Codex's sandbox needs the two AppArmor profiles in
  `/etc/apparmor.d/bwrap` and `/etc/apparmor.d/codex-bwrap`. Codex uses its own
  bundled bwrap, so a profile for the system one is not enough.
- **VM, not Helm's:** a python "Agent Mailbox" on port 8765, published by a
  stray `cloudflared tunnel`. The owner knows. Do not stop it without asking.
