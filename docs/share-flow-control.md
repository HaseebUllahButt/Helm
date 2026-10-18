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
- Both senders wait while the shared WebSocket's `bufferedAmount` is at
  256 KiB (checking every 5 ms), and yield with `setImmediate` after two
  frames. Control frames keep their normal send path, so the queue can pass
  the gate by one encoded frame (about 88 KiB). This gates bulk data; it is
  not a cap on control messages.
- Ending a stream waits for its last bytes to be acknowledged before CLOSE.
  Destroy, failed opens, machine loss and hub shutdown free mappings,
  transfer leases, timers and sockets. A visitor that leaves while the port
  is opening destroys the late stream.

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
