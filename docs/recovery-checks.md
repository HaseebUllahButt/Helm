# Recovery checks and support

Release checks run on private Helm data. Never change the owner's network,
fill the owner's disk, reboot a working machine, or use owner chats as test data.

`helm ship` checks the exact source and built app version in a private chat.
It checks before merging and again from the installed version after connected
machines update. The same approval must survive a private daemon restart and
complete once. The check always removes its private copy, including on timeout.
Version agreement alone does not pass this release check.

## Private failure checks

Use named files through `npm run test:smart -- <file>...`.

- Installation and recovery after killed publication: `test/install.test.mjs`.
- Failed builds, dependency replacement, owner edits, interrupted updates:
  `test/update-recovery.test.mjs` and `test/release.test.mjs`.
- Lost message replies and daemon replacement: `test/restart-delivery.test.mjs`
  and `test/input-delivery.test.mjs`.
- Blocked live links, lost approval replies, and browser reloads:
  `test/browser/client-actions.test.mjs` and `test/action-delivery.test.mjs`.
- Transfer interruption and completion receipts: `test/send-recovery.test.mjs`.
- Network-change and wake signals: `test/network-monitor.test.mjs`.
- Invalid web replies, stalled responses, and wrong homes: `test/doctor.test.mjs`.
- An expired trusted certificate on a real loopback web server:
  `test/doctor-errors.test.mjs`. Reports keep secure checks enabled and name
  certificate, name lookup, refused connection, and timeout failures separately.
- Full-disk errors use injected write failures, never a filled physical disk:
  `test/backup.test.mjs` and `test/action-delivery.test.mjs`.
- Encrypted offline recovery preserves removal records and completed receipts:
  `test/backup.test.mjs` and `test/restore-guard.test.mjs`.

A missing answer is not proof that an action failed. Keep its saved identity.
Read its result before retrying. An interrupted approval can stay unknown;
Helm must not repeat it just to remove the warning.

## Support by observed behavior

Linux is checked here with private installation, restart recovery, updates,
terminal software, a Chromium phone view, and fake first chats. Update rollout
checks the running and built versions on connected machines. Synthetic wake
signals do not prove a physical suspend or Wi-Fi change. Logout, reboot,
physical suspend, mobile networks, expired public certificates, and loss of a
real home still need physical checks.

macOS has background startup and managed update code. That code does not prove
logout, reboot, sleep, updates, terminals, or browser operation on a real Mac.
Keep macOS support provisional until each behavior passes there.

Native Windows and Linux through WSL are separate targets. Neither has runtime
proof from these Linux checks. Do not infer native Windows support from WSL.
The local assistant VM is a separate integration track, with its own acceptance
checks; a passing Helm home check does not prove that integration.

See `docs/ready-packages.md` for package limits and `docs/backups.md` for the
blocked offline restore. An old backup cannot prove what happened after it was
made. Safe activation requires current trusted removal and completion records.
