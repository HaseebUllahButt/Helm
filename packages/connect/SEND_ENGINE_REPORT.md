# Helm Send v2 engine report

Built on branch `helm/you-are-the-engine-builder-for-helm-sen`. No push, merge, deployment, production daemon restart, network membership change, or real account chat was performed.

The source daemon now owns durable `send.plan/start/status/list/cancel/retry` jobs and coalesced `send.update` events. Jobs persist before acknowledgement, recover as interrupted after a source restart, and resume the same receiver stage. Receiver reservations prevent concurrent writes to one destination; independent jobs multiplex the authenticated copy connection. First publication uses a sibling stage and rename. Re-sends use rsync deltas, unique partial directories and delayed updates. A signed commit receipt binds the original intent, target path, source identity and job ID; lost receipts can be recovered without sending the files again.

The send path has no byte or file-count cap. Planning enumerates metadata without hashing contents. Git sends include tracked and nonignored untracked files plus `.git`, with ignored environment files included by default. Non-Git sends exclude the existing bulk cache directories. `--no-env` excludes environment files. Single files, modes, symlinks and empty directories are supported. An older receiver uses the uncapped copy adapter with an explicit warning about reduced publication guarantees; unsupported compatibility cases fail clearly.

Changed files:

- `packages/connect/src/send-{engine,journal,plan,proxy,receiver}.js`: source jobs, metadata selection, private daemon bridge, durable reservations and publication.
- `packages/connect/src/{copy,copy-proxy,copy-transport}.js`: reusable authenticated sockets/routes, per-stream encryption keys, receiver confirmation, cancellation and rsync filters. SSH remote-shell quoting now distinguishes rsync's argument parser from OpenSSH's ProxyCommand shell.
- `packages/connect/src/{agent,task-transfer,handoffs}.js`: source RPC/event integration and task code delivery through the shared engine; the task marker is committed with the code before session adoption.
- `packages/protocol/{index,network}.js`: method/event names and the advertised v2 capability.
- `packages/connect/bin/helm.js`: engine-backed send CLI, live bytes/files/rate/ETA, cancellation, and local dry-run planning.
- `test/{send-engine,copy,task-transfer,transfer-cli}.test.mjs`: encrypted loopback lifecycle coverage, real rsync/OpenSSH quoting regression, task returns and CLI compatibility.

`transfers.js` stays unchanged. Existing `transfer.*`, `task.*`, `helm copy`, and explicit grant-based CLI sends remain available. The app builder should replace the plain project `transfer.*` calls with the new source-side `send.*` calls; the legacy grant flow retains its existing limits.

With a source daemon running this revision:

```sh
helm send VM /absolute/path/to/project
helm send VM /absolute/path/to/project --to '~/chosen-folder' --no-env
helm send VM /absolute/path/to/project --dry-run
```

Run the same command again to update the remembered destination. Ctrl-C requests cancellation. Resume an interrupted/cancelled/failed job through `send.retry {jobId}` on its source daemon. This branch has not been installed into the owner's running daemon.

The isolated lifecycle and timing harnesses are reproducible from this worktree:

```sh
helm run --heavy -- node --test test/send-engine.test.mjs
helm run --heavy -- env HELM_SEND_BENCH=1 node --test --test-name-pattern='timing harness' test/send-engine.test.mjs
```

The harness sets temporary HELM_DIR, HELM_DB, HELM_SSH_DIR and process sockets before importing Helm. It uses test keys, a loopback WebSocket copy receiver, actual rsync subprocesses and fake task sessions. Tests cover 33 MiB, 20,001 files, single-file rename/re-send, symlinks/modes, ignored and excluded environment files, Git history and dirty/untracked files, unchanged and changed re-sends, cancellation, actual source SIGKILL/restart/resume, two concurrent jobs, destination conflicts, old targets, task adoption/automatic small returns, cached presence and forged recovery receipts. The SSH test executes real rsync and OpenSSH with spaces/apostrophes in executable and checkout paths, and observes the exact proxy argv before any SSH server connection.

`npm test` was run through `helm run --heavy --`, with temporary state and socket paths installed in the subprocess environment before any Helm import. Node 22.23.3 was used for the repository's available native PTY binary. Final result: 1,286 Node tests passed, zero failures/cancellations, followed by all isolated `test/network.sh` checks passing.

The audit's 1 MiB / 50-file real send took 17.122 s on the previous VPN-exit route. That historical route was changed by the owner before these measurements, so an exact attribution of those 17 seconds cannot be reconstructed safely. Instrumentation now separates local preparation, credential HTTP exchange, socket setup, signed receiver readiness, rsync/receiver completion and local closure. It makes no OS routing changes.

Local loopback harness: approximately 1 MiB of random data in 50 files; artificial 500 ms RTT on credential acquisition, socket establishment and bidirectional tunnel frames. Times are milliseconds, single samples, including ordinary scheduling variation. The legacy adapter baseline uses the same isolated receiver and delay. V2 rows include its atomic publication and signed receipt.

| Mode / operation | Local preparation | HTTP credential | Socket setup | Signed ready | rsync + receiver exit | Local finish | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy first | 47 | 501 | 509 | 513 | 3576 | 21 | 5167 |
| Legacy unchanged | 65 | 501 | 503 | 513 | 3021 | 24 | 4627 |
| V2 unpooled first | 58 | 500 | 504 | 518 | 3598 | 19 | 5196 |
| V2 unpooled unchanged | 47 | 501 | 503 | 519 | 3552 | 16 | 5138 |
| V2 pooled first, cold socket | 47 | 500 | 502 | 551 | 3918 | 41 | 5559 |
| V2 pooled unchanged | 50 | 0 | 0 | 518 | 3551 | 41 | 4160 |
| V2 pooled one-file delta | 47 | 0 | 0 | 514 | 3548 | 19 | 4128 |

The reusable connection eliminates two setup exchanges: approximately 1 second at this simulated RTT. Warm unchanged v2 is 19% faster than unpooled v2 and 10% faster than the legacy unchanged adapter, with stronger publication guarantees. Cold first-send setup remains about 1.5 s; the remaining approximately 3.5 s comprises rsync's own exchanges and receiver completion. No claim of a cold first-send speedup is made. Scanning and capability discovery overlap; advertised v2 capability avoids an extra RPC. There is no duplicate preview/hash and no separate task-marker copy on v2. The small remote-shell shim avoids a second Helm runtime/key/route initialization. Rsync explicitly selects xxh128 and level-1 zstd, skips already compressed extensions, avoids per-file fsync, and needs delayed updates only for re-sends because a first send already has a private sibling stage.

A safe real Laptop -> VM scratch transport test was also completed through the existing encrypted copy receiver, without installing v2 remotely. Source credentials/roster were copied read-only into temporary state before Helm imports. Fifty random files totaling 1,048,576 bytes landed under `~/helm-send-tests/engine-v2-1791903108667/`. The remote path/size/content SHA256 manifest matched, and the scratch folder and temporary source state were removed. The OS route was via `192.168.1.1` on `wlp115s0` to VM's public IP, bypassing `tailscale0`; this was the owner's route change.

| Real transport operation | Local shim | HTTP credential | Socket setup | Signed ready | rsync + receiver exit | Local finish | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold first | 56 ms | 1218 ms | 1018 ms | 260 ms | 3586 ms | 31 ms | 6169 ms |
| Warm unchanged | 105 ms | reused | reused | 764 ms | 1453 ms | 25 ms | 2347 ms |

The warm real send transferred zero regular files. This validates the pooled tunnel against the installed legacy VM receiver, not v2 publication on a deployed VM. The 17.122 -> 6.169 s difference includes the owner's routing change and cannot be attributed entirely to this branch. Raw measurement logs are `/tmp/helm-send-bench-publish.log` and `/tmp/helm-send-real-results.log` on Laptop.

Remaining limits: linked Git worktrees and submodules are explicitly refused because copying their `.git` pointers could produce an unusable target; standalone repositories are covered. Large task automatic returns retain the bounded legacy return format and emit a warning; the outgoing task code has no cap. Destination and individual-file names still have the underlying copy/rsync/filesystem validity constraints. Power-loss durability of all payload data, arbitrary filesystem corruption, and cross-machine v2 daemon crash recovery were not established by these tests. No app UI changes or rollout were performed, per engine ownership and the explicit no-deployment instruction.
