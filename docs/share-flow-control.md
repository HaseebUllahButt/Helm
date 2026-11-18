# Share tunnel flow control

A spin's bytes share the one WebSocket between a machine and the hub with
chat, heartbeat and RPC traffic. Without flow control a slow visitor let the
hub queue a whole download (65.6 MiB queued for a 50 MiB file).

## Compatibility

`openTcp(env, port, options)` offers `flow: 1` in TUNNEL_OPEN and uses
credit only if TUNNEL_READY echoes it. A daemon or hub that omits the field
gets the old unbounded stream. Keep both directions of this fallback.

## Rules

- Each direction allows 512 KiB outstanding, in frames of at most 64 KiB.
  The daemon acknowledges only when its local TCP write completes, and
  pauses the local app socket while waiting for credit. Uploads hold the
  visitor through a bounded PassThrough's write callback.
- Both senders wait while the shared WebSocket's `bufferedAmount`, plus
  what its large lane holds back, is at 256 KiB (checking every 5 ms), and yield with `setImmediate` after two
  frames. Control frames keep their normal send path, so the queue can pass
  the gate by one encoded frame (about 88 KiB). This gates bulk data; it is
  not a cap on control messages.
- Ending a stream waits for its last bytes to be acknowledged before CLOSE.
  Destroy, failed opens, machine loss and hub shutdown free mappings,
  transfer leases, timers and sockets. A visitor that leaves while the port
  is opening destroys the late stream.

## Small frames first

Every frame on a machine-to-hub socket goes through that socket's
FrameLanes (frame-lanes.js), never `sock.send` directly. On the slow VM
link a 2 MB chat list held "create chat", "send message" and WebRTC
offers for minutes. Small frames now go out at once; a large frame leaves
in pieces, the next one only while the socket buffer is nearly empty. Frames
with one lane key (a tunnel, events, requests, signals) keep their order.

- Pieces go only to a peer that asked (`lanes=1` on the URL and `lanes: 1`
  in the hub's welcome, or the app's `chunks=1`). Older peers get whole
  frames, still small first. Keep both sides of this fallback.
- The large lane only holds frames back; it has no cap and drops nothing.
  The joiner refuses only what `ws` refuses: one frame over 100 MiB.
- The kernel's own send buffer is out of reach; on a lossy link a small
  frame can still wait behind what the kernel already holds.

## Benchmark

Loopback, Laptop, 2026-10-13, 50 MiB to a slow visitor: median 3.37 s before
and 3.08 s after; peak queue 65.6 MiB before and 350 KiB after. Not a claim
about internet speed.

```sh
helm run --heavy -- node test/share-flow-bench.mjs
HELM_FLOW_REPO=/absolute/path/to/untouched/source \
  helm run --heavy -- node test/share-flow-bench.mjs
```

The other source needs its dependencies installed; `HELM_FLOW_RUNS` sets
the repeat count. All Helm paths are temporary; no real daemon, network or
chat is touched.
