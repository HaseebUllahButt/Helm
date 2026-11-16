# Previous release recovery

Helm builds an update in a separate folder before changing the installed files.
It saves the source commit, app, dependencies, and compiled chat reader before publication.
It saves only the files that the update replaces.

An update reuses work when it is safe:

- Same package files and `node_modules/.package-lock.json` matches the lock file, and the terminal engine loads: `node_modules` stays in place. It is not saved, installed again or replaced.
- No change in `apps/web`, `packages/protocol`, `packages/usage` or the root package files since the commit in `dist/build.json`: the app is copied, and `build.json` gets the new commit and `sameAs`, the commit of the real build.
- The chat reader file name holds a hash of its source. A file with the same name is copied, not built.
- Any doubt runs the full install and build.

A machine that runs a newer version sends `env.newer` to older machines once per version. They check at once. Older Helm refuses the call and keeps its two-minute check.
Each update step writes its time to the service log.
A saved record lets the next update recover after an interruption.
The standalone installer reads its recovery record before it fetches or builds.

After successful startup, Helm keeps one previous release.
A private Git reference keeps its source commit reachable.
A newer successful release replaces that checkpoint.
Failed preparation and failed startup keep the existing checkpoint.

`rollbackPreviousRelease(dir = ROOT, { restart = true } = {})` restores the checkpoint.
It refuses later owner edits, commits, branch changes, hidden index changes, and unfinished source changes.
Rollback saves the current installed files before changing anything.
Failed rollback keeps its recovery record and leaves the checkpoint intact.
A second attempt recovers before it tries again.
If file restoration finished but restart failed, another rollback request retries that restart.
Edits made before publication remain untouched when the final source check refuses rollback.
Running agent and terminal hosts remain alive during daemon replacement.

After rollback succeeds, peer sync keeps the restored release.
It refuses the exact commit that the owner removed.
A newer saved commit can install and clears this hold.
An explicit normal self-update can also install the removed commit again.
Rollback does not add a timer or wait for running chats.

The rollback result uses the normal update fields:

- `updated: false, reason`: no safe rollback is available.
- `updated: true, restarting, failed`: files were restored and service replacement was requested.
- With `restart: false`, success returns `updated: true, restarting: []`.
- Unsafe or damaged saved files raise an error and remain available for recovery.

Private checks:

- `test/rollback-previous-release.test.mjs`: retained source and files, owner changes, failed copies, SIGKILL, peer hold, and agent survival.
- `test/install.test.mjs`: installer publication, repeated recovery, owner changes, and installer checkpoint import.
- `test/update-recovery.test.mjs`: interrupted updates, compiled reader recovery, and kept packages and app.
- `test/version-sync.test.mjs`: the `env.newer` notice.
- `test/release.test.mjs`: prepared files and startup confirmation.
