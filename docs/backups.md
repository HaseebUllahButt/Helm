# Offline encrypted backups

The backup library saves a complete offline data folder in one encrypted file.
It preserves file bytes, removal records, and completed-action receipts. It does
not select only active chats. A restore never overlays existing state. This
preserves the snapshot's removals without bringing back files absent from it.

Stop all writers before making a backup. Use a stopped copy of the data folder.
The library requires `offline: true` and checks the source twice for changes.
That check cannot prove that a live database is consistent. Do not back up a
running Helm folder. Links, sockets, and other special files cause a refusal;
the library never silently omits them. It does not stop any services.

The parent command interface can call these exports from
`packages/connect/src/backup.js`:

- `createBackup({ source, destination, password, offline: true })`
- `restoreBackup({ archive, destination, password })`

Pass `password` as a Buffer with at least 12 bytes. Read it through a protected
prompt or a private file. Do not put it in command arguments, logs, or chat.
The caller owns clearing its password Buffer after use. Keep a separate safe
copy of the secret. Helm cannot recover a lost secret.

The file uses AES-256-GCM encryption with a random salt and nonce. Scrypt derives
the encryption key. Wrong secrets and changed encrypted data fail before the
restore creates a folder. The tool writes a private temporary archive, then publishes the complete file
without replacing an existing backup. Failed writes remove that temporary file.
New backup files have owner-only read and write
access. The library currently holds the snapshot and encrypted data in memory;
large data folders need enough free memory. It does not copy project folders
outside the selected data folder, or follow links to provider histories.

## Restore for review

Restore only to a new folder outside production Helm. The selected folder must
not exist. The library creates `data/` for the saved files. Both the selected
folder and `data/` contain `.helm-restore-review.json`. A damaged marker still
blocks normal Helm startup and standalone agent construction.

The restore does not start Helm, connect to another machine, or submit any work.
It preserves queued work as evidence for review. It does not execute it.
Restored files have private permissions; executable modes are not restored.

There is no activation command. Do not remove the review markers or move the
saved files into a live Helm folder. An old backup cannot know about device
removals or completed work recorded after it was made. It can contain old
machine keys and pending work that has already run elsewhere.

Safe activation needs current trusted state and an explicit review of removals,
schedules, saved sends, transfers, queued handoffs, and completed receipts.
When no current trusted state exists, keep the restore offline for inspection.
This tool does not claim safe automatic recovery from an arbitrary old backup.

## Evidence

Named tests prove encrypted round trips, byte preservation, removal and receipt
preservation, wrong-secret refusal, changed-file refusal, refusal to overwrite,
link refusal, and startup blocking before state files are created. Tests use
private folders. The private Helm check also tests the guard during restart.
No production backup or restore runs during these checks.

Tests: `test/backup.test.mjs`, `test/restore-guard.test.mjs`.
