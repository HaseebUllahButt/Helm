# Rust chat log reader

Rust scans saved chat bytes and returns record positions. It also finds the
turn and approval records used at startup. JavaScript keeps chat rules,
approvals, paging, file access, and the recent text cache. This boundary avoids
creating JavaScript strings for old reply and tool output records.

Usage extraction keeps each message's identity and metadata. JavaScript still
chooses the latest message version, converts numbers, and formats totals. Raw
metadata preserves those rules without decoding large message bodies.

Search extraction keeps event identities and small search fields. Reply text
stays in the input buffer until the search reader needs it. Complete records
use blocks of about one MiB to reduce temporary memory. A larger record stays
whole. The final record keeps the existing partial-write recovery.
Large file reads and block boundaries let live chat work run between scans.
Search passes share their file offsets. Live search records wait for their
chat's saved records, so a reply keeps its saved prefix during a scan.

Transcript extraction selects Codex and Claude records before JavaScript
decodes them. JavaScript keeps message assembly, settings, usage, activity,
file-change checks, and live-read recovery. The selector keeps an uncertain
record for the original reader. Full reads keep readline's line endings;
bounded and live reads keep their existing newline rules.

Linux process discovery batches command-line reads. Folder discovery batches
entry details in Node's worker pool. JavaScript keeps folder selection, scan
limits, path rules, and error recovery. Other systems keep their process reader.

Incoming lines and terminal replay use JavaScript chunk queues. Persistent
Rust buffers lost to these queues in paired measurements. Keep the faster
queues and preserve JavaScript string positions, including lone surrogates.

Saved-log selectors borrow input buffers only during each call. They return
positions or the fields their caller needs. They must not retain input buffers
or open chat files. JavaScript keeps file access and partial-write recovery.
Unusual records go through the existing JSON reader. Keep that recovery path:
older logs can contain duplicate fields, bad bytes, or incomplete final records.

## Build and recovery

Run `node scripts/build-log-reader.mjs` after a Rust change. Install and machine
updates also run it. Cargo uses the committed lockfile. A missing Rust toolchain
keeps the JavaScript reader; a failed Rust build stops the update and restores
the previous release.

The binary name includes the platform, machine type, and a source checksum.
Changed source cannot load an old binary. Missing or incompatible binaries use
JavaScript. All native features share one loaded library. `env.info.logReader`
identifies the chat reader; `env.info.rustFeatures` lists its loaded functions.
Set `HELM_LOG_READER=javascript` before startup to select the JavaScript reader.

## Proof boundary

Run `node scripts/bench-log-reader.mjs` after building. It compares generated
private logs in separate processes. It checks identical output, scan time,
retained JavaScript memory, and peak process memory. These numbers do not prove
phone or network speed.

Measure peak memory separately from memory held after cleanup. Native result
arrays can wait for cleanup and raise the peak even when repeated reads do not
keep growing memory. Transcript selection and search currently have this cost.

`test/log-index-native.test.mjs` compares both readers with damaged JSON, Unicode,
older pages, approvals, and waiting messages. Startup scans also compare exact
turns and approvals. Usage checks compare latest message versions, dimensions,
and malformed-record recovery. Search and transcript checks compare saved and
live reads, damaged records, Unicode, block edges, and JavaScript recovery.
Discovery checks use private folders and process files. Private app checks follow
[the chat guide](features/chats.md).
