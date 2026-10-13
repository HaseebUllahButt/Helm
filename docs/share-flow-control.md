# Share tunnel flow control

`openTcp(env, port, options)` keeps its existing signature. It offers `flow: 1`
in TUNNEL_OPEN and uses credit only if TUNNEL_READY echoes it. A daemon that
omits the field still gets the old wire behavior. An older hub originating a
tunnel without the field still gets an ordinary stream from a newer daemon.

With credit, each direction allows 512 KiB outstanding, split into at most
64 KiB frames. Download credit waits when the hub duplex readable buffer fills;
its next read releases credit. Uploads pass through a bounded PassThrough, whose
write callback holds the HTTP or WebSocket visitor upstream when credit runs
out. The daemon's existing receiver acknowledges only when its local TCP write
completes, and its sender pauses the local app socket while waiting for credit.

Both senders check the shared machine WebSocket's bufferedAmount before adding
data. At 256 KiB they wait, checking again after 5 ms. After two frames they
yield with setImmediate, including across successive source chunks. Chat,
heartbeat, RPC, and acknowledgement frames keep using their ordinary send path.
The data queue can exceed the threshold by one encoded frame (about 88 KiB);
this is a gate for bulk traffic, not a cap on unrelated control messages.

Ending an outgoing stream waits for its final bytes to be acknowledged before
sending CLOSE. Destroy, failed opens, machine disconnects, and hub shutdown
release tunnel mappings, transfer activity leases, sender timers, and local
sockets. Closing while uploads remain unacknowledged reports an error. A share
WebSocket visitor that leaves while the port is opening destroys the late stream.

## Loopback measurement

Measured on Laptop, Node v26.8.1, 2026-10-13. The same fixture uses a real HTTP
app, share route, hub WebSocket, daemon tunnel handlers, and visitor. Each run
transfers 50 MiB, initially pauses the visitor for 350 ms, then pauses for 3 ms
after each received chunk. The app produces repeated 64 KiB buffers rather than
allocating the entire response in advance. All Helm paths are temporary; no
production daemon, network, or chat is involved.

Before: untouched source at `9320c726f9a874058da460cbecb8dc1e10d6824d`.
After: the flow-controlled source on this branch.

| Version | Run | Time (ms) | Peak observed queued bytes | Peak download bytes without credit |
| --- | ---: | ---: | ---: | ---: |
| Before | 1 | 3295 | 68,822,370 | 52,428,929 |
| Before | 2 | 3434 | 68,558,068 | 52,428,929 |
| Before | 3 | 3373 | 64,740,578 | 52,428,929 |
| After | 1 | 3172 | 345,144 | 524,288 |
| After | 2 | 3083 | 357,944 | 524,288 |
| After | 3 | 3057 | 345,656 | 524,288 |

Median time: 3.373 s before, 3.083 s after. Maximum observed queues:
65.6 MiB before, 350 KiB after. The peak is the sum of both WebSockets'
bufferedAmount and the hub duplex readableLength/writableLength. It excludes
kernel TCP buffers, HTTP parser buffers, and the private flow adapters; their
outstanding bytes are separately bounded by credit. Sampling runs every 1 ms
and on tunnel frames, so this is an observed peak, not an allocation proof.

First-run peak process RSS growth was 223,293,440 bytes before and 46,927,872
bytes after. That includes all fixture roles and transient base64 allocations;
warmed runs reuse heap space, so RSS is not used as a test assertion.

Reproduce with:

```sh
helm run --heavy -- node test/share-flow-bench.mjs
HELM_FLOW_REPO=/absolute/path/to/untouched/source \
  helm run --heavy -- node test/share-flow-bench.mjs
```

The alternate source needs installed dependencies. HELM_FLOW_RUNS selects the
number of repetitions (default three). The benchmark checks every payload byte.

## Validation and limits

The new node:test suite covers slow download and upload readers, bounded
credit and observable queues, an RPC during a stalled download, aborts,
machine loss, hub shutdown, old-daemon fallback, timed-out/refused opens,
write tails, blocked write callbacks, large binary WebSockets, and a visitor
leaving during port opening. A sender test proves the two-frame yield and the
shared queue gate independently of TCP's buffering.

The broader check passed 82 tests across share flow, share links and expiry,
tunnel flow and ports, WebSocket errors, Link reconnect, NAS routing, transfers,
copy and copy transport, SSH proxy, gossip, mesh integration, and relay HTTP.
After fixing held write callbacks on abort, 44 focused tests passed again.
The final 32 share/tunnel tests also passed, including the new end-callback
cleanup check: 84 distinct tests in total. No web files changed.

Legacy fallback preserves compatibility and retains its old buffering limits.
The benchmark is local loopback, not a claim about internet or high-latency
throughput. This branch has not been pushed or deployed.
