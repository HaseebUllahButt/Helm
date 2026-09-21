# NAS media streaming

## Goal

Let any Helm machine—laptop, VM, desktop, or dedicated box—be designated as
a NAS and used as a lightweight personal media source. A user should be able
to open the Helm app, tap a small NAS/media icon, browse media already stored
on that machine, and stream it immediately.

NAS is a role and media-serving capability, not a storage product. Helm must
not copy, synchronize, upload, deduplicate, or otherwise manage the media
library.

## Product behavior

- Any online Helm machine can be designated as a NAS.
- A NAS serves files from explicitly selected local media folders.
- No media folders are shared by default; the whole filesystem must never be
  exposed accidentally.
- The machine may be a laptop, even if it is in another room, as long as it is
  awake and connected to Helm.
- The app shows a small NAS/media affordance on NAS-capable machine rows.
- Tapping it opens a minimal media interface: folders, media items, and a
  focused player.
- The first target is streaming existing video and audio, not library
  administration.

## Streaming requirements

- Prefer a direct LAN path when available.
- Fall back to a Helm-routed remote path when the client cannot reach the NAS
  directly.
- Use a real byte-stream/HTTP media path, not JSON or base64 RPC frames.
- Support HTTP range requests so seeking, pause/resume, and partial reads work.
- Stream the original file without transcoding or preloading by default.
- Return correct MIME types, file sizes, cache headers, and range responses.
- Keep the server lightweight: on-demand directory reads and a small cached
  index are preferable to a heavyweight media database.
- Unsupported browser codecs should be reported clearly rather than silently
  triggering expensive transcoding.

## Security boundaries

- Only authenticated Helm devices may browse or stream.
- Each NAS has an explicit allowlist of shared roots.
- Resolve and validate paths beneath those roots; reject traversal, symlink
  escapes, hidden/private paths, and arbitrary filesystem access.
- Stream URLs or requests must be scoped to the target NAS and authorized
  device, and should not expose the network key.
- A NAS designation must not grant broader shell or filesystem access than the
  existing Helm permissions already provide.

## Non-goals

- No NAS-owned storage layer.
- No file upload or download workflow as part of the media view.
- No backup, replication, snapshots, quotas, RAID, or drive management.
- No mandatory NFS, SMB, or CIFS integration.
- No mandatory transcoding pipeline.
- No attempt to make an asleep or disconnected laptop reachable.

## Acceptance criteria

1. Designate an existing Helm machine as `nas` without changing its machine
   identity or requiring a special operating system.
2. Select one or more local media roots on that machine.
3. From an authenticated phone/browser, open the NAS icon and browse those
   roots without seeing anything outside them.
4. Play a browser-compatible video or audio file from the NAS.
5. Seek through a large file and resume playback without downloading the
   entire file first.
6. Verify playback over the local network and through the Helm remote path.
7. Verify that an unauthorized device, invalid path, traversal path, and
   symlink outside a shared root are rejected.
8. Verify that designation, browsing, and streaming add no storage copy or
   synchronization side effects.

## Existing foundation

The repository already has the `nas` machine kind, invite/join support,
redesignation, roster propagation, and a basic NAS selector in the web UI.
The missing work is the media-root configuration, protected media catalog,
byte-stream transport, player interface, and end-to-end tests.
