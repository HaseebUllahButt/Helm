# Handoff

State of helm as of 2026-09-13, for whoever picks this up next.

Read `README.md` first for what the thing is and how it connects. This file
is the part that is not obvious from the code: **what it is trying to be**,
what is broken, what was deliberately not built, and what I would not trust
without checking.

If you only read one section, read the next one. The rest is detail; that is
the bar the detail exists to hit.

---

## What this is for

**The problem.** Coding agents constantly need input. You give one a task, walk
away, and come back to find it asked a yes/no question four minutes in and has
been idle ever since. So you end up sitting at the desk babysitting, which
defeats the point of having an agent at all.

helm exists so that "waiting on the agent" stops meaning "waiting at the desk".
The owner's phone should be enough to see that something is blocked, read what
it asked, answer it, and move on.

This is inspired by T3 Code, and deliberately fixes what the owner found
wrong with it: it could show you sessions but could not get you *out of the
chair*.

**Who it is for.** The owner, and people willing to run an always-on VM. Each
person owns a completely separate Helm home; there is no shared Helm account
or hosted dependency. Single trusted owner per network, correctness over
completeness, no need to defend against an adversary who already owns the
owner's laptop.

### The shape of the thing

The hierarchy is **machine → directory → session**. You open the app, you see
your machines, you pick one, you pick a directory, you see the sessions in it
or start a new one.

A session belongs to a **profile** — a specific CLI on a specific account.
The owner runs codex, claude and opencode across several logins, and picks per
session which one to use, the way T3 Code does. Profiles come from their shell
aliases because that is where that knowledge already lives.

### The bar for "good" here

These are the things that make it feel right, in rough priority:

1. **Setup produces one private link.** `helm setup` makes the VM the Helm
   home; `helm link` prints a short-lived URL that opens the PWA or can be
   pasted into Helm Desktop. Pair once. A device is in until explicitly
   removed — not until a reboot, crash, update, or password expiry.

2. **Blocked sessions surface themselves.** The whole reason this exists. A
   session waiting on input should be impossible to miss and one tap from
   answered.

3. **It reads like a chat, not a terminal.** Agent output as conversation —
   messages, tool calls — the way T3 Code presents it. The raw terminal is
   available when you want it, but it is not the default way to read what an
   agent is doing on a phone.

4. **Low latency.** A remote session that lags on every keystroke is one you
   stop using. Measured 208ms round trip to a distant VM, which is why session
   data goes peer-to-peer and the hub only makes introductions.

5. **The VM is the stable home.** Laptops dial out to the owner's always-on VM.
   The VM makes setup and recovery understandable; no third-party tunnel or
   Helm-operated account is required.

6. **The phone is a control hub; machines are where work happens.** Nothing
   runs agents on the phone, and nothing should try. Phones drive, machines
   execute, and phones are never themselves controllable.

### Journeys that should feel effortless

- Add a machine. One command on it, one code from any existing machine.
- Add a device. One password, once.
- Start a session anywhere: pick machine, pick directory, pick which CLI and
  which account, go.
- Make a new directory from the app, without SSHing anywhere.
- Open a terminal on any machine from inside the app — SSH is already set up
  between machines as they join, and the app has a terminal view per machine.
- See agent usage and limits across accounts, so you know what you have left.

### Settled, and why — do not relitigate without a reason

- **No Tailscale.** Asked for directly at the start. Not an oversight.
- **VM-centric, not Helm-cloud-centric.** Every owner supplies their own VM.
  Helm's author does not host accounts, traffic, or keys for other users.
- **Profiles reference secrets, never copy them.** Environment variable names
  and paths only; values stay in the engine's own directory on that machine.
  Nothing sensitive crosses the network or reaches a database.
- **Passwords are bootstrap credentials, minutes long.** Devices are durable.
  Conflating the two caused the worst bug in the project's history.
- **herdr owns the terminals.** It already detects blocked/working/done per
  agent and maintains that detection per CLI. Reimplementing it means
  maintaining output scraping forever, and a missed `blocked` means the phone
  never buzzes — the one failure the whole project exists to prevent.

### Wanted, not built

- **The brain.** A cross-machine layer that knows what is happening
  everywhere, can summarise it, and can dispatch work to the right machine.
  Explicitly deferred to v2; session digests are already being collected and
  stored for it.
- **Push notification when a session blocks.** Implied by the whole premise,
  not yet built. Arguably the highest-value missing feature.

### Where better ideas are genuinely welcome

The owner is not attached to the implementation, only to the outcome. If you
see a simpler way to hit the bar above, say so — that has already happened
twice and both times the owner's or a reviewer's idea beat the plan on the
table:

- The design was heading toward an election protocol for sharing one tunnel
  between laptops. The owner pointed out each laptop could simply bring its
  own, which deletes the entire problem.
- A review found a live data-loss bug that the plan at the time would have
  masked rather than fixed.

Open questions worth better answers: push delivery when sessions block and
whether direct relay latency justifies TURN.

---

## Where things stand

The repo works. `install.sh` was run end to end from a clean `HOME` and
produced a working install.

**Nothing is deployed.** helm was removed from the Oracle VM
(`130.210.33.163`) at the owner's request — service, `/opt/helm`, `~/.helm`,
and the shim are gone, and its Caddyfile was replaced with a comment
(previous config saved at `/etc/caddy/Caddyfile.helm-backup`; Caddy itself is
still installed). The VM's t3 server and other node service were left alone.

The laptop still runs `helm-serve.service` as a user unit with a network of
one machine. `helm leave --yes` resets it if you want a clean first-run test.

Not yet pushed to GitHub. The remote is set to
`git@github.com-me:HaseebUllahButt/helm.git` and `install.sh` points at that
repo; both need to be real before the curl command works.

---

## The architecture, in one page

A **network** is a set of machines plus the devices allowed to drive them,
sharing one secret key.

The always-on VM is the **Helm home** and normal rendezvous point. It is not a
shared central server: each owner runs their own. A token is an HMAC claim
signed with the network key (`packages/protocol/identity.js`), so every joined
machine can still verify a paired device offline.

Nothing makes "the home" singular. A network can hold several public homes;
each advertises its own address, every machine dials all of them, and clients
race them and pick the one seeing the most machines (failover falls out of the
same machinery). `helm setup --join <code> --at <home>` stands up a second home
in one command — join the mesh, configure this VM's own HTTPS, advertise it,
install the service — and is re-runnable (it re-advertises rather than
re-founding). Digests, however, are stored per hub (`apps/relay/src/db.js`) and
not gossiped, so with multiple homes the future cross-machine "brain" would
need to read all of them.

Every machine runs both:

- a **hub** (`apps/relay/`) — HTTP + WebSocket, authenticates members,
  introduces peers, serves the PWA
- a **daemon** (`packages/connect/src/agent.js`) — opens a `Link` to its own
  loopback hub and to every *other* machine's advertised address, reconciling
  on a 15s tick

Clients (`apps/web/src/client.ts`) probe every address they know and attach to
the hub reporting the **most online machines**, latency only as a tie-break.
Session data then goes peer-to-peer over WebRTC; the hub is rendezvous and
fallback only.

The **roster** (machines, devices, revocations) is replicated to every machine,
last-writer-wins per record, revocations one-way.

### Two invariants you can break without noticing

1. **A machine is the only author of its own roster record.**
   `mergeRoster` skips `net.self`; the hub does not write other machines'
   records; a first-sight placeholder is stamped `updatedAt: 0`.
   Break this and a machine overwrites its own address list with someone
   else's stale view and becomes unreachable until restart. There is a
   reproduction in the git history for the commit "a machine is the only
   author of its own roster record".

2. **Never dial an address you hold *twice*.**
   A machine attaches to its own hub exactly once, over loopback, and that
   attach is what lets a phone reach the machine through the very hub it is
   running - without it a single-VM network shows the VM offline and can run
   nothing. The daemon marks that one link `role=self`; `server.js` accepts it
   and 409s any *other* self-attach. `#desiredLinks()` still excludes your
   advertised endpoints and `this.extra`, so the only self-address you dial is
   loopback. Break either half and a second env attachment for your own id
   supersedes the loopback one, the two knock each other down, and the machine
   flaps forever. (An over-broad 409 that refused the loopback attach too was
   the bug that made the phone unable to control its own VM.)

---

## Known limitations

**cloudflared quick tunnels are unreliable** — at least on the owner's
connection (Pakistan; `raw.githubusercontent.com` also returns 503 there).
Three attempts: one URL that never became reachable in 60s, two outright
failures (`failed to request quick Tunnel: context deadline exceeded`).
The error is surfaced now rather than hidden, but do not promise anyone that
`--temporary` is dependable. ngrok worked every time, in about two seconds.

---

## Deliberately not built

**The no-VM multi-laptop keeper.** The plan was: several laptops share one
reserved ngrok domain, whichever is up holds it. Designed in detail, then cut.

Two reasons. First, the owner has a free always-on VM, so the case is
hypothetical for them. Second, the owner's own suggestion is better: give each
laptop its **own** tunnel, and no laptop can take another down. That needs no
election code at all — the existing "advertise your addresses, dial everyone
else's, race them on the client" machinery already does it. The only cost is
one free ngrok account per laptop.

If you do build a keeper anyway, two things from the review are worth keeping:

- Do **not** poll the domain every 15s. ngrok's free plan meters HTTP
  requests (~20k/month); a 15s probe burns that in days. ngrok's own admission
  control is the free mutex — try to claim, and rejection means someone has it.
- Watching the child process is not a liveness test. The ngrok agent survives
  sleep and reconnects in the background, and does not exit when it loses the
  domain. The authoritative test is `GET https://<domain>/api/network` with
  your own machine token and comparing `self` to your id.

**Machine-to-machine WebRTC.** Only browser↔machine is direct today; machines
reach each other over WebSocket through a hub. `node-datachannel` is already a
dependency, so the pieces exist. Worth doing if tunnel bandwidth matters.

**Automatic HTTPS setup.** Plain `helm setup` detects the VM's public IPv4,
uses its free `sslip.io` hostname, adds an isolated Helm Caddy config, validates
it, and then starts the private loopback service. An explicit owned-domain URL
still expects its DNS and Caddy site to be configured first.

**npm publishing.** `npx helm` will not work: `helm` and `helm-cli` are taken
on npm. `helmcli` is free, or scope it (`@haseebullahbutt/helm`). The curl
installer sidesteps this for now.

---

## Things I would verify rather than trust

- **TURN.** ICE is STUN-only (`apps/web/src/client.ts`). A phone on mobile
  data is often behind carrier-grade NAT, where hole punching fails and
  everything relays through the hub. Nobody has measured this on a real
  carrier. The client emits a `transport` event with `{ direct: true|false }`
  — check that before deciding whether TURN is needed.
- **ngrok's browser interstitial.** Free ngrok shows a warning page on
  requests that look like browser navigations. `/api/*` and the WebSocket are
  unaffected. Whether it appears inside the *installed* PWA on a cold launch
  is untested; `apps/web/public/sw.js` is network-first for navigations, which
  is where it would show up.
- **Desktop distribution.** The Linux Tauri app builds locally and a tagged
  release workflow exists, but no release has run because the repository is
  not on GitHub yet.
- **Historical transcripts** (`inventory.js`) are opt-in and were explicitly
  descoped. They work; they are just not wired into the UI.

---

## Testing

There is a small Node regression suite plus a shell integration script that
exercises the things most likely to break:

```
npm test
```

It checks: a missing herdr binary is reported without crashing; a device
survives a hub restart; a machine that has never seen a device accepts its
token; a forged token is rejected; a revocation crosses the network. Run
`npm run check` for TypeScript, the production web build, and all tests.

Two habits that saved time and one that cost it:

- Measure instead of reasoning. The gossip traffic fix came from
  `ss -tni | grep bytes_sent` over 60s, not from reading code — 148 MB/month
  of "nothing changed", cut to 19 MB/month.
- Sandbox with `HELM_DIR` / `HELM_SSH_DIR` / `HELM_NO_SERVICE=1`. Note that
  overriding `HOME` breaks herdr, so sandbox `HELM_DIR` specifically.
- **Do not use `pkill -f` here.** The pattern matches the agent's own shell
  command line and kills the session. It happened four times. Capture the PID,
  or `ps -eo pid,args | grep -F ... | grep -v grep`.

---

## A note on the review

A second model (Fable) reviewed the architecture twice and both passes paid
for themselves — it found the self-record wipe, which was live and which my
own plan would have masked rather than fixed.

It was also wrong twice, in ways worth knowing about: it asserted a
`--web-addr` flag that ngrok v3 does not have (shipped unverified, ngrok
exited with `unknown flag`), and claimed terminal output was being broadcast
to every hub when the web terminal actually polls over RPC. Both were caught
by running the code.

Worth consulting, worth verifying.
