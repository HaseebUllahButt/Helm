# Edit from here

A delivered user message with a checkpoint offers **Edit from here** in an idle
Helm-driven Claude Code or Codex chat. It removes that message and subsequent
replies, returning the original words, image bytes, and thread references to the
composer. Sending the edited draft starts a new turn; rewind itself sends no
prompt. Imported messages and unsupported providers do not offer the action.
Native/shared provider sessions controlled by another client are excluded.

The confirmation defaults to conversation only. Optional file restore requires
an exclusive linked Git worktree at its root. The main checkout, overlapping
sessions (including idle owned sessions), active descendants, nested repositories,
submodules, sparse/split indexes, changed HEAD, Git index locks, symlink parents,
and ignored-file collisions are refused. Restore preserves checkpoint bytes,
permissions, symlinks, staged versus unstaged changes, and untracked files.
Ignored files remain outside the snapshot. Checkpoints are capped at 50,000 files
and 256 MiB; failure to capture files leaves conversation rewind available.

Checkpoint capture occurs immediately before delivery rather than when a message
is queued. File capture runs in a dedicated worker with a 15-second deadline; a
worker error or timeout keeps conversation rewind available. The worker receives
only workspace and private snapshot paths, and never imports session, provider, or
network state. Workspace membership and provider state are checked again after
awaiting capture; files and index fingerprints must remain stable while captured. File snapshots use raw bytes and a separate saved Git index, avoiding
project clean/smudge filters. Identical content shares private blob storage.

Claude prepares a new conversation using `--fork-session` and
`--resume-session-at`; its initialize response must confirm the candidate before
publication. Rewinding the first message creates an empty conversation. Codex
forks and resumes a candidate thread before `thread/revert`; an explicit
unknown-method response alone permits the older count-based `thread/rollback`.
A timeout never retries a possibly completed mutation. The source provider
conversation remains intact throughout preparation.

Discarded events, attachment bytes, the old provider identity, and pre-restore
files live under `HELM_DIR/checkpoints/<recovery-id>` with owner-only permissions.
The selected provider, files, and event history publish as one synchronous
transaction guarded by a persisted recovery journal. Failures restore the old
files, index, history, and provider identity. If compensation cannot complete,
the session and workspace remain blocked for recovery. Startup rolls back an
applying journal before reconnecting any provider, and marks recovery complete
only after persisting the original session index. Clients receive a monotonic
history-reset event, invalidating old transcript and pagination caches.

The implementation was compared with the October 13 T3 reference's
CheckpointStore, CheckpointRestoreSafety, CheckpointRollbackService, and provider
rollback adapters. Helm stages a separate provider conversation to avoid changing
the current provider when file restoration fails.

Validation lives in `test/rewind.test.mjs`, including real Claude/Codex driver
JSON-RPC/control-protocol processes, actual Git worktree restoration, injected
partial file and publication failures, recovery journals, workspace locks, and
stale client reducers. Tests configure temporary Helm state and sockets before
importing Helm modules.
