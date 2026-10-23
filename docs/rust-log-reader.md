# Rust chat log reader

Rust scans saved chat bytes and returns record positions. JavaScript keeps chat
rules, approvals, paging, file access, and the recent text cache. This boundary
avoids creating JavaScript strings for old reply and tool output records.

The scanner borrows one input buffer during a synchronous call. Its output owns
only positions and small numbers. It must not retain chat text or open files.
Unusual records go through the existing JSON reader. Keep that recovery path:
older logs can contain duplicate fields, bad bytes, or incomplete final records.

## Build and recovery

Run `node scripts/build-log-reader.mjs` after a Rust change. Install and machine
updates also run it. Cargo uses the committed lockfile. A missing Rust toolchain
keeps the JavaScript reader; a failed Rust build stops the update and restores
the previous release.

The binary name includes the platform, machine type, and a source checksum.
Changed source cannot load an old binary. Missing or incompatible binaries use
JavaScript. `env.info.logReader` identifies the reader in the running daemon.
Set `HELM_LOG_READER=javascript` before startup to select the JavaScript reader.

## Proof boundary

Run `node scripts/bench-log-reader.mjs` after building. It compares generated
private logs in separate processes. It checks identical output, scan time,
retained JavaScript memory, and peak process memory. These numbers do not prove
phone or network speed.

`test/log-index-native.test.mjs` compares both readers with damaged JSON, Unicode,
older pages, approvals, and waiting messages. Private app checks follow
[the chat guide](features/chats.md).
