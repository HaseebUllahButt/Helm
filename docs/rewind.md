# Edit from here

**Edit from here** on a delivered message, in an idle Helm-driven Claude Code
or Codex chat, removes that message and the replies after it and puts its
words, images and chat references back in the composer. Rewind sends
nothing itself. Imported messages, other providers and sessions driven by
another client do not offer it.

## File restore limits

Conversation-only is the default. File restore needs an exclusive linked Git
worktree at its root. Refused: the main checkout, overlapping sessions (idle
owned ones included), active descendants, nested repos, submodules,
sparse/split indexes, a changed HEAD, index locks, symlink parents and
ignored-file collisions. Ignored files are not in the snapshot. Checkpoints
are capped at 50,000 files and 256 MiB; a failed file capture still leaves
conversation rewind.

## Decisions

- The checkpoint is taken just before delivery, not when a message is
  queued. File capture runs in its own worker (15 s deadline) that gets only
  the workspace and snapshot paths, never session, provider or network
  state. Snapshots use raw bytes and a separate Git index, so project
  clean/smudge filters never run.
- **The source provider conversation is never changed while preparing.**
  Helm stages a separate one, so a failed file restore cannot change the
  current provider. Claude forks with `--fork-session` and
  `--resume-session-at`, and its initialize reply must confirm the candidate.
  Codex forks a candidate thread before `thread/revert`; only an explicit
  unknown-method reply allows the older `thread/rollback`. A timeout never
  retries a mutation that may have completed.
- Discarded events, attachments, the old provider identity and pre-restore
  files live under `HELM_DIR/checkpoints/<recovery-id>`, owner only.
  Provider, files and history publish as one step guarded by a saved
  recovery journal; on failure the old state is put back, and if that
  cannot finish the session stays blocked for recovery. Startup rolls back
  an applying journal before reconnecting any provider.
- Clients get a history-reset event with a rising number, which drops old
  transcript and paging caches.

## Trap

Tests must set temporary Helm state and sockets before importing Helm
modules (`test/rewind.test.mjs` runs real driver processes and Git
worktrees).
