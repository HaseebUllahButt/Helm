# Handoff

State of helm as of 2026-09-15, evening, for whoever picks this up next.

Read `README.md` first for what the thing is and how it connects. This file
is the part that is not obvious from the code: **what it is trying to be**,
what changed today and why, what was verified by running it, and what was
not.

If you only read two sections, read **"What this is for"** (the bar the rest
exists to hit) and **"Start here: nothing is running"** (the network was
deliberately torn down; you will need to rebuild it before anything works).

---

## What this is for

**The problem.** Coding agents constantly need input. You give one a task, walk
away, and come back to find it asked a yes/no question four minutes in and has
been idle ever since. So you end up sitting at the desk babysitting, which
defeats the point of having an agent at all.

helm exists so that "waiting on the agent" stops meaning "waiting at the desk".
The owner's phone should be enough to see that something is blocked, read what
it asked, answer it, and move on.

This is inspired by T3 Code. The owner likes T3's app (per-provider options,
model picker, permission modes, the feel of watching an agent work) and
deliberately does **not** want T3's code or apps in the loop: they are slow,
and depending on them would tie helm's product to someone else's repo and
license. **helm's own UI, T3's ideas.** The one-day experiment of consuming
T3 as the UI is parked on branch `t3-network`, not merged.

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
session which one to use. Profiles come from their shell aliases because that
is where that knowledge already lives.

### The bar for "good" here

1. **Setup produces one private link.** `helm setup` makes the VM the Helm
   home; `helm link` prints a short-lived URL. Pair once; a device is in until
   explicitly removed.
2. **Blocked sessions surface themselves.** A session waiting on input should
   be impossible to miss and one tap from answered.
3. **It reads like a chat, and it is alive.** Text appears as the model writes
   it, tool calls show up the moment they start and fill in as they finish, a
   permission prompt is a card with the real choices. Not a blank screen and
   then a paragraph.
4. **Low latency.** Session data goes peer-to-peer; the hub only introduces.
5. **The VM is the stable home.** Laptops dial out to it.
6. **The phone is a control hub; machines are where work happens.**

### Settled, and why — do not relitigate without a reason

- **No Tailscale.** Asked for directly at the start.
- **VM-centric, not Helm-cloud-centric.**
- **Profiles reference secrets, never copy them.**
- **Passwords are bootstrap credentials, minutes long. Devices are durable.**
- **No T3 code. No T3 apps.** Design inspiration only (2026-09-14).
- **Agents run headless through their own protocols; herdr owns terminals.**
  Until today helm launched each agent's TUI in a herdr pane and spied on it:
  the chat re-read the transcript file the CLI writes to disk (finished
  messages only, polled), and a permission prompt was only visible as herdr's
  `blocked` flag, answered by firing `y`/`n` keystrokes blind. That is why the
  screen was dead while the agent worked. The fix is structural, not
  cosmetic: helm now speaks each CLI's programmatic interface (below) and gets
  a typed event stream, which is exactly what T3 does. herdr still owns plain
  terminals and read-only "external" agents started at the keyboard.

---

## Start here: the network is up, both machines need upgrading

As of 2026-09-15 the network is rebuilt and running: `helm status` on the
laptop reports **2 machines, 3 controllers**, network `076f00e81990`, with the
VM reachable at `https://130-210-33-163.sslip.io`. (The paragraph that used to
live here said nothing was running - that was true on the evening of the 14th
and is not true now.)

**What is stale is the deployed code.** The laptop's `~/.helm-src` sat at
`adced97` while `origin/main` had moved to `34a3438`; the VM was at `34a3438`
already, because that work was committed and pushed *from the VM*. After
pushing today's commit, run the upgrade on both:

```bash
cd ~/.helm-src && ./install.sh && systemctl --user restart helm-serve
```

If the network ever needs rebuilding from nothing, that is:

```bash
sshvm                 # or: ssh -i ~/Downloads/misc/.vpn/"ssh-key-2026-08-27 (1).key" ubuntu@130.210.33.163
helm setup            # mints the key, takes the HTTPS address, installs the service
helm add              # prints a join code
# then on the laptop:
helm join <CODE> https://130-210-33-163.sslip.io
helm link             # a URL to open on a phone or browser
```

**`helm join` on the laptop is the step that matters.** Pasting a `helm link`
URL into a browser makes that browser a *device*; it does not make the laptop
a *machine*, and sessions can only run on machines. The owner lost an hour to
exactly this confusion: the app showed "two" (one machine + one device) and
read as if the laptop had joined. `helm machines` is the authority.

### Reaching the VM

`~/.helm/id_ed25519` is **helm's** key and is regenerated by `helm setup`, so
an ssh route that worked before a re-setup will stop working. The durable one
is the owner's shell function:

```bash
sshvm() { cd "$HOME/Downloads/misc/.vpn" && ssh -i "ssh-key-2026-08-27 (1).key" ubuntu@130.210.33.163; }
```

Non-interactively, pass that key with `-i` from that directory. The user is
`ubuntu`; `sudo` is passwordless. The helm service there is a **user** unit,
so over ssh it needs `export XDG_RUNTIME_DIR=/run/user/$(id -u)` before any
`systemctl --user`.

### Deploying

Both machines install from GitHub `main` into `~/.helm-src`. Upgrading either
is idempotent — `install.sh` does `fetch` + `reset --hard origin/main` +
`npm install` + web build — then `systemctl --user restart helm-serve`. So the
loop is: commit, **push**, re-run install on each machine, restart. `reset
--hard` leaves untracked files, which is why dead `t3.js` / `tunnel-socket.js`
from the parked experiment still sit in both install dirs; nothing on `main`
imports them.

---

## What changed today (2026-09-15)

A short pass: find out why the usage panel never loaded, and make image
attachments actually work everywhere they can.

**First, a trap worth knowing about.** This clone was eight commits behind
`origin/main` and its working tree still held the *pre-merge* version of the
terminal/pty work - the same changes, older. `git status` looked like a pile
of unpushed work; it was a pile of already-landed work. The tell is
`git fetch` followed by `git diff origin/main --numstat`: every file was
net-negative. If you meet that again, fetch before you believe the diff. The
old tree is kept in the stash (`pre-sync worktree snapshot 2026-09-15`) and
can be dropped.

### The usage panel: four separate reasons for one blank space

1. **`env.info.usage` was a snapshot.** The daemon probes for the dashboard
   once, in `Link.#open()`, when it attaches to its hub. cc-usage-dashboard is
   a *separate service* and is normally started after the daemon, so the app
   was told "no dashboard here" for the life of the process. The panel now
   re-asks the machine itself (`env.info`) whenever the roster says no, and
   again each minute, so a dashboard that appears later is picked up.
   `usage.available()` helps by caching a "yes" for five minutes and a "no"
   for thirty seconds - a no is the answer that goes stale.
2. **The VM genuinely has no dashboard**, and said so by rendering nothing.
   There is now an explicit `absent` state: *"no usage dashboard on vpn-arm"*,
   with a note saying where the numbers come from. `off` (not online) and
   `absent` (asked, hasn't got one) are different things now.
3. **`· NaNd ago`.** The dashboard reports `fetchedAt` as an ISO string;
   `ago()` took a `number` and subtracted it from `Date.now()`. TypeScript
   missed it because the value arrives through an `any`. `ago()` now takes
   either and returns `''` for anything it cannot parse.
4. **Six rows all reading "default".** The dashboard labels most accounts
   `default`; the row rendered `label` and dropped `provider`, which is the
   only field that tells them apart. Rows now read `codex`, `grok`,
   `claude · personal`, `opencode · 2`.

### Images: they were being thrown away, quietly

**`supportsImages()` was a lie.** Its comment said it asked each provider's
own metadata; its body was `engine === 'claude' || engine === 'codex'`,
ignoring the `model` argument entirely. Meanwhile the composer decided
whether to show the clip from `imagesByModel`, built from models.dev. So on
an opencode or Devin session the clip appeared, the owner attached a
screenshot, and the daemon turned it into the text `[image: shot.png]` on the
way to the agent. No error, no sign, just an agent that could not see what it
had been shown.

Both of those agents can take images - **verified by asking them**:
`initialize` returns `promptCapabilities.image: true` for opencode 1.18.26
and for devin 3000.10.21. The ACP driver was discarding that whole response.
It now keeps it, exposes `acceptsImages()`, and implements
`sendWithAttachments` with real ACP `{type:'image', mimeType, data}` blocks.

The gate is now one predicate, `driverTakesImages(d)` in `sessions.js`, used
both to decide what to send and (through `model.list`) to decide whether the
app offers a clip at all - so the two can no longer disagree. A live driver's
answer beats the catalogue's guess. When an agent really cannot take images,
the placeholder says so *and* an `error` event lands in the transcript.

**Images now survive a restart.** The optimistic echo - the turn helm posts
the moment you hit send, so the picture appears immediately - was writing
`data.slice(0, 80) + '…'` into the event log and then patching the full bytes
onto the in-memory object afterwards. Memory was right; the file was not. So
a reopened session (or any daemon restart) drew the owner's own photo as a
broken thumbnail, permanently. Image bytes now go to a content-addressed
blob store, `events/<id>.att/<sha>.bin`, and the event keeps `{filename,
mime, bytes, ref}`; `since()` puts the bytes back before they reach a client,
so nothing upstream changed. Blobs are swept when the log's tail moves past
them, and a blob that is gone renders as a named tile, not a broken image.
**The base64 the log hands back is byte-identical to what was sent.**

**A message with an image showed up twice.** helm's optimistic turn and the
agent's own `turn.start` are the same turn under two ids, and the reducer
pushed both - one bubble with the picture, one with the reply. The app now
adopts a `local-` turn when the agent announces the same text. The texts are
compared **trimmed**: helm strips the trailing newline it sends, the CLI
echoes it back with the newline still on. That one character is why the first
attempt at this fix did nothing.

**Everything that could refuse silently now speaks.** Picking a fifth image
returned early with no message at all; files past the limit were dropped
without a word; a photo whose `File.type` was empty (Android, some
drag-and-drop) or `image/heic` (every iPhone) was told to "use a JPG, PNG,
WebP, or GIF image" while being exactly that. The gate is now "does this look
like an image", the picker accepts `image/*`, the browser is left to say what
it cannot decode, and HEIC gets a message naming the actual problem. Paste
and drag-and-drop share one path, and both say something when the agent
cannot take images. `session.input` also enforces the limits itself now
(8 images, 8 MB each, 24 MB a message, base64 validated) - the browser's cap
is a courtesy, and that RPC is reachable by anything holding a device token.

### Also

`test/publish.test.mjs` and `test/gossip.test.mjs` both bound port 18991, and
the runner runs files in parallel, so `npm test` failed with `EADDRINUSE`
perhaps half the time. publish moved to 18961.

---

## What changed on 2026-09-14

Two pushes. The morning built the headless drivers; the afternoon was the
owner using it and finding it wanting.

### Morning: agents run headless, the app streams them

`packages/connect/src/drivers/` — `claude.js` (`claude -p` stream-json) and
`codex.js` (`codex app-server --stdio`), both translated into one event
vocabulary (`turn.start`, `item.start/delta/update/done`,
`permission.request/resolved`, `turn.done`, `status`, `limits`, `error`), with
a 50 ms per-item delta coalescer and a version check. `events.js` keeps a
per-session append-only log under `~/.helm/events/<id>.jsonl` with sequence
numbers, so a phone that was asleep asks for "everything after 412" and a
daemon restart loses nothing. The app renders that stream: prose typed in with
a caret, folded thinking, tool and command cards, per-file diffs, and a
permission sheet carrying the CLI's own options.

The protocol details that recordings settled (not guessed) are in
`test/fixtures/` and the tests that replay them. Re-record after a CLI upgrade
with `HELM_PROFILE=claudea node scripts/record-driver.mjs claude|codex`.

### Afternoon: the session became the place you are

The owner's complaint: every knob was chosen once on a start screen and then
frozen, the UI was cramped, and the terminal typed everything twice.

- **Runtime controls.** A row above the keyboard — `◆ model  ◇ thinking
  ⦿ permissions  ⚡ speed` — each opening a sheet, each changing
  mid-conversation (`apps/web/src/session/Controls.tsx`). `session.effort` and
  `session.speed` joined mode and model. codex takes effort and `serviceTier`
  per turn so they land on the next message; Claude's `--effort` is argv, so
  the child is ended and comes back on `--resume`, losing the process and not
  the conversation. Speed is codex's service tier — what its TUI calls
  `/fast` — and appears only for models whose catalogue entry has one.
- **codex offered one model on the VM.** helm read
  `~/.codex/model_catalog.json`, which only the TUI writes, so a machine that
  had only ever run headless had no such file and the list collapsed to the
  default in `config.toml`. It now asks `codex debug models`, which answers
  anywhere, and keeps the file as a fallback. Five models with display names
  on that VM instead of one.
- **The start screen is one decision**: which account. Folder → agent → you
  are in the session.
- **Sessions can be ended from the list**; the power icon is gone from the
  header (unpair moved to the sidebar foot, behind a confirm); type is up
  about 1.5pt everywhere.
- **The Tauri desktop app is deleted** — repo and the owner's disk. It was a
  second window around the same interface that had to be built and kept in
  step. The PWA installs to a dock and is the app.
- **A session whose herdr pane is gone now reads `exited`** rather than
  whatever it was last doing, so a dead session cannot sit at the top of the
  list under "needs you" forever (`sessions.js` `list()`).

### Later: the terminal, the flicker, and the three links

Six complaints from using it, which came down to four causes. This pass shared
a working copy with another agent's opencode/devin/acp driver work; both
landed together in the merge that brought them to main.

**1. helm owns the terminal now (`packages/connect/src/pty.js`).** The old one
was a herdr pane that helm *screen-scraped*: `attach()` polled `pane.read` for
400 rendered lines every 120ms, diffed the text, and pushed either an append
or - whenever the new screen was not a prefix of the old, which is every
full-screen program - the **entire screen** with `reset: true`. Each keystroke
was its own RPC into herdr, which "answers one request per connection and then
hangs up", so every character opened a fresh unix socket. Echo had to wait for
the next poll.

It is now a pty helm spawns, raw bytes both ways, coalesced into ~16ms frames,
with a 256KB scrollback ring for reconnects. `session.resize` was declared in
the protocol and implemented nowhere; it works now, so the program renders for
the phone's width instead of being reflowed into it. **Measured: 18ms echo,
steady, against 120ms of polling latency alone before.**

This also explains the junk at the prompt. There were **two emulators in
series** - herdr rendered the pty into a screen, helm re-serialised that screen
as ANSI, and xterm rendered it again *and answered control queries inside it*
(device attributes, cursor position), sending those answers back as keystrokes.
One pty, one emulator, no phantom input.

`node-pty` was already a dependency and imported nowhere. It is a compiled
addon: the VM's Node 22 has a prebuilt binary, this laptop's Node 26 does not
and built from source (gcc/make/python3, all present). **If it will not load,
helm falls back to the old herdr path rather than refusing to run** - so a
machine without build tools still works, slowly.

The `❯_` button used to reuse *any* shell session it found, including herdr
panes helm merely adopted - during testing it dropped me into the owner's real
shell in `~/dev/me/aitink` and typed into it. It now reuses only helm's own
terminals.

**Terminals outlive the daemon** (`bin/helm-terminals.js`,
`src/terminals.js`). A pty belongs to whoever opened it, so holding them in the
daemon meant an upgrade killed your build. A small host process owns them
instead; the daemon talks to it over a unix socket and reconnects after a
restart, scrollback and all. Three things that make it work, each of which
looked optional and was not:

- **It must escape the daemon's cgroup.** The service unit sets no
  `KillMode`, so systemd's default `control-group` kills everything the
  service started - a plain detached child included. The host is started with
  `systemd-run --user` (a detached child is the fallback where there is no
  systemd).
- **The socket cannot live in `HELM_DIR`.** A unix socket path is capped near
  107 bytes and a deep helm directory exceeds it: `listen` fails `EINVAL` and
  terminals fall back to the slow path with no sign of why. It is
  `$XDG_RUNTIME_DIR/helm-terminals-<hash of HELM_DIR>.sock` - short, per-user,
  and per-directory so a sandboxed daemon never reaches the real one's
  terminals.
- **A host that fails says so.** Its output goes to `~/.helm/terminals.log`,
  not `/dev/null`, which is how the EINVAL above stayed hidden for an hour.

The host exits once it holds nothing and nobody is attached, and immediately if
its socket has been removed underneath it - a host nobody can reach should not
sit on the machine holding shells nobody can see.

**Proven by doing it:** a terminal running `for i in $(seq 1 120); do echo
tick-$i; sleep 1; done`, daemon killed, new daemon started - the session came
back `alive=true pty=true`, replayed 29 ticks of scrollback, and went on to
print tick-30, 31, 32.

**When there is no pty at all**, helm still runs and still falls back to herdr
panes - but it is no longer silent about it. `install.sh` checks and prints the
package to install, `helm status` says `terminals: own pty` or `herdr panes
(slow)` with the reason, and the app's terminal button reads `❯!` with a
tooltip saying why.

**2. The usage panel flashed and vanished** because `App.tsx` passed
`reload={() => loadSessions(env.id)}` - a new function on every render - to
`EnvView`, whose effect listed `reload` as a dependency and opened with
`setUsage(null)`. Every parent render blanked the panel, re-subscribed and
re-listed sessions, which re-rendered the parent. A `useCallback` ends the
loop; the panel now says loading / unavailable / how old the numbers are
instead of rendering nothing in every unhappy case, and refreshes each minute.
`usageApi.available()`'s 15s probe is cached for five minutes rather than
running inside every `describe()`.

**3. Three commands printed a link; now each is named for what it adds.**
`helm add controller | pc | vm`, and bare `helm add` lists the three rather
than guessing. Only `controller` prints a link to **open**; `pc` and `vm` print
a code to **type**, and the far machine always runs the same `helm join <code>
<url>` - the invite carries its role (`invites.role` in the hub db), so a vm
additionally claims its address, configures Caddy and serves, with no second
command to remember. The serve banner no longer prints a password on every
start, only when the network has no controllers yet or on `--link`; that was
what made `setup`, `join` and a plain restart all look like they were handing
you a link.

**4. `helm open` signs the app in on the machine itself**, which is what makes
the laptop a controller for the VM. **The trap here nearly shipped:** Caddy
terminates HTTPS and proxies to the hub over loopback, so *every request from
the internet arrives at the hub from 127.0.0.1* - a bare loopback check would
have handed a device token to anyone who could reach the public URL. It
requires loopback **and** the local key from `~/.helm/local.key` (0600, minted
on demand), compared in constant time. `test/local-login.test.mjs` encodes
that: the key works, and no-key, wrong-key and wrong-length all get 401 from
the same loopback address.

**5. Moving networks re-probes.** The client already raced every known address
on connect; it now also does so on the browser's `online` event, dropping a
socket that looks open but reaches nothing. `reachableFromHere` still skips
`http://` LAN addresses from an HTTPS page - that is the browser's
mixed-content rule, not helm's, and `helm open` sidesteps it on loopback.

Verified by running it, not by reading: sandboxed daemon, real shell, the PWA
in headless Chromium at 390x844. Signed in from `#local=` with no pairing
screen; `❯_` opened a clean prompt with nothing pre-typed; `echo
typed-in-browser` appeared exactly once and ran. 43 tests green (4 new pty
tests against a real shell, including `tput cols` reporting 132 after a
resize).

### Two things the owner caught in a screenshot, now fixed

The same sentence printed twice: an `error` event puts an item in the
transcript where it happened, and `turn.done` then carried the identical
message into the turn's footer. The footer now omits an error the turn
already shows and says only that the turn failed.

The model chip said "model". Neither CLI is given a model unless one is
chosen, but both announce what they started with in their init message and
helm was dropping it. The daemon keeps it as `engineModel`/`engineEffort` -
reported, not chosen, so it never becomes an argument on the next launch -
and the session view now listens for `session.update`, which it never did,
so a record changing underneath it (the CLI reporting its model, another
device changing a setting) actually reaches the chips. Verified: the chip
went from `◆ default` to `◆ opus-5` when the CLI said so.

### The bug worth remembering: every push arrived twice

Typing one letter in the terminal put two on screen. The daemon was innocent —
one `session.input` RPC moves exactly one character, and the pane really held
what was typed. `#emit` was sending every push down both paths at once:

```js
this.broadcastFrame(T.EVENT, { kind, payload });   // every hub
// Clients on a direct connection are not listening to any hub.
this.peers?.broadcast(kind, payload);              // every direct peer
```

That comment was wrong. A client prefers the direct WebRTC channel for
*sending* but stays attached to its hub, so once WebRTC came up it received
everything twice. Driven sessions were spared only because they apply events
by sequence number and a repeat is a no-op — which is why this hid for so
long, and why a "harmless" duplicate can be anything but.

Every event now carries an id (the daemon's boot tag plus a counter); the
client delivers the first copy and drops the rest from a bounded set. **If you
add a third delivery path, it must carry the same id.**

---

## Verified by running it

### 2026-09-15

- `npm run check` green: types, production build, **66** node tests,
  `network.sh`.
- **A real image reached a real model.** Sandboxed daemon, `claudea` profile,
  a 64px PNG of a white circle on red, sent through `session.input` with the
  prompt "reply with exactly two words: the background colour, then the shape
  in the middle". Claude answered **"Red circle"**, turn closed `3.7s · $0.07`.
- **The bytes are intact on the way back out.** The JSONL holds
  `{"filename":"dot.png","mime":"image/png","bytes":235,"ref":"06ad6aa3…"}`,
  the blob is 235 bytes on disk, and the base64 `session.events` hands a client
  is byte-identical to what was sent.
- **The ACP path is real.** `initialize` against opencode 1.18.26 and devin
  3000.10.21 both return `promptCapabilities.image: true`. An image sent
  through the opencode driver was accepted as a prompt content block and
  failed downstream on the account's billing ("Insufficient balance"), not on
  the protocol - so the block was well-formed, but *no ACP agent has yet
  described an image back*. That is the one thing left to prove here.
- **The PWA, headless Chromium at 390×844**, signed in from `#local=`: the
  usage panel renders seven accounts named by provider with `· just now`
  provenance; the session shows **one** user bubble carrying the red square
  (two before the reducer fix), zero broken images, and the clip in place.
  Screenshots taken at each step.
- The "no dashboard" path: `available()` against a dead port answers `false`
  in 11 ms, so the app's re-check costs nothing on a machine like the VM.

### 2026-09-14

- `npm run check` green: types, production build, 37 node tests, `network.sh`.
- Deployed to both machines and driven in headless Chromium against the public
  HTTPS address, not loopback: paired in 2.0s, a Claude session started on the
  **laptop through the VM's hub**, first text on screen 2.6s after Send, turn
  closed at `4.0s · $0.08`.
- The controls: models listed with real names, thinking narrowed to the levels
  that model supports, `high` and `Fast` picked and the chips updated.
- The terminal: one `a` produced one `a` after the fix (`aa` before).
- Codex sandbox on the VM: same thread, same prompt — "read-only outside the
  workspace", then after switching to the no-sandbox mode, "Worked — the file
  was written", with the file on disk.

## Known bad, and not yet fixed

0. **Today's commit is not deployed.** Both machines still run what was on
   `main` before it. See the top of this file for the upgrade.
1. **No ACP agent has actually described an image back.** The wire format is
   verified and the capability is read from the agent itself, but opencode
   stopped on billing and Devin was not spent on. Send a picture through one
   and see.
2. **Slash commands are not built.** Worth knowing before designing them:
   `/help` and `/status` through `claude -p` return `ok` in ~95 ms with **no
   output** — the built-ins are TUI-local and do nothing headless. Custom
   commands and skills *do* run. So a palette of built-ins would be a lie; a
   palette of the project's own commands plus protocol-level actions would not.
3. **No vendor logos** — engine marks are the letters `C` / `X` / `O`.
4. **A real phone has never opened this.** Every run was headless Chromium at
   390×844. Touch, the keyboard pushing the permission sheet, and a carrier-NAT
   WebRTC path are all unproven. This is the biggest gap.
5. **Push notification when a session blocks** is still the highest-value
   missing feature; `permission.request` is a structured event to hang it on.
6. Codex `item/permissions/requestApproval` deny and `requestUserInput` are
   coded from the bindings and have never been seen live.

## The machines themselves

Both run Linux with helm in `~/.helm-src`. Kept across the wash:
`profiles.json` on both, `secrets.env` on the laptop, and the ssh keys.

- **The owner's default `~/.claude` login is expired** — "OAuth session expired
  and could not be refreshed". Everything today ran on the `claudea` profile.
  The driver surfaces it as an `error` event rather than hanging, which is
  correct, but it means the default Claude account cannot start a session.
- **The VM needed three fixes before its Codex sandbox worked at all**: codex
  was 0.153.4 (below the 0.154.0 the driver requires), `bubblewrap` was not
  installed, and Ubuntu 24.04's
  `kernel.apparmor_restrict_unprivileged_userns=1` blocked bwrap from making a
  user namespace. Fixed with two narrow AppArmor profiles rather than
  disabling the sysctl machine-wide: `/etc/apparmor.d/bwrap` and
  `/etc/apparmor.d/codex-bwrap` for
  `/usr/lib/node_modules/@openai/codex/**/bwrap` — **codex prefers its own
  bundled bwrap**, so profiling the system binary alone is not enough.
- The VM's `~/.bashrc` had been mangled (every blank line and most `fi`/`esac`
  stripped); rebuilt from `/etc/skel/.bashrc` with the owner's tail preserved.
  Original at `~/.bashrc.before-fix`.
- **Not helm's, left running deliberately:** a python3 "Agent Mailbox" on
  `0.0.0.0:8765` with an unauthenticated `POST /inbound`, published to the
  internet by a stray `cloudflared tunnel` since 2026-09-13. The owner has been
  told twice. Do not kill it without asking.

---

## The architecture, in one page

A **network** is a set of machines plus the devices allowed to drive them,
sharing one secret key. The always-on VM is the **Helm home**; several homes
can coexist. A token is an HMAC claim signed with the network key
(`packages/protocol/identity.js`), so every joined machine can verify a paired
device offline.

Every machine runs both a **hub** (`apps/relay/`: HTTP + WebSocket,
authenticates members, introduces peers, serves the PWA) and a **daemon**
(`packages/connect/src/agent.js`: a `Link` to its own loopback hub and to every
other machine's advertised address). Clients probe every address they know and
attach to the hub reporting the most online machines. Session data goes
peer-to-peer over WebRTC when it can; the hub is rendezvous and fallback.

The **roster** is replicated to every machine, last-writer-wins per record,
revocations one-way.

### Two invariants you can break without noticing

1. **A machine is the only author of its own roster record.** `mergeRoster`
   skips `net.self`; the hub does not write other machines' records.
2. **A machine attaches to its own hub exactly once, over loopback, as
   `role=self`.** `server.js` 409s any other self-attach. Break either half and
   the machine flaps forever.

### Wanted, not built

See "Known bad, and not yet fixed" above — that list is the backlog, in the
order the owner will notice it. The opencode driver and images in messages
have since been built (`opencode acp`, and images across all four engines).
Beyond the backlog: a file viewer over Claude's `read_file` control request,
and "the brain" (cross-machine summaries and dispatch) as v2.

---

## Testing

```
npm test          # node --test test/*.test.mjs && bash test/network.sh
npm run check     # + tsc and the production web build
```

Driver tests replay the recorded fixtures through `test/fake-cli.mjs`;
`events.test.mjs` covers the log; `session-driver.test.mjs` runs `Sessions`
with a fake driver; `session-stale.test.mjs` covers the dead-pane status;
`emit-once.test.mjs` encodes the duplicate-push guard; `modes.test.mjs` keeps
the two codex sandbox spellings agreeing.

**Seeing it work** needs a running network (see the top of this file) plus
headless Chromium over CDP. For work that should not touch the real network,
run a sandboxed daemon instead:

```
HELM_DIR=<tmp>/helm HELM_SSH_DIR=<tmp>/ssh HELM_NO_SERVICE=1 \
  node packages/connect/bin/helm.js up --port 8790 --host 127.0.0.1 --name home
```

Copy the real `~/.helm/profiles.json` and `secrets.env` into that `HELM_DIR`
so real accounts are selectable, and put scratch repos under `~` so the folder
browser reaches them.

Three things that repeatedly saved time:

- **A scriptable client beats a browser** for asking "is the daemon wrong, or
  the UI?". `POST /api/auth/login` with a `helm link`/`helm login` password
  returns a bearer token; RPCs then go over `ws://<hub>/ws` with subprotocol
  `['helm', token]`, as `{t:'rpc', id, env, method, params}`. That is how the
  double-typing was bisected: send **one** `session.input`, read the pane back
  with `session.attach`, and see that the pane gained one character while the
  browser drew two. There is no HTTP RPC endpoint; it is all over the socket.
- **Read the live screen, not the scrollback.** A herdr pane's `read` returns
  history too, and an old warning in it reads as current. This produced a
  false "still broken" three times in a row on the VM.
- **Kill daemons by PID.** `pgrep -f` / `pkill -f` on their arguments matches
  the agent's own shell and kills the session. It has happened three times.

---

## A note on the review

A second model (Fable) reviews after Opus writes. It has been wrong before in
ways only running the code caught, and right in ways that saved the project.
Worth consulting, worth verifying. The recordings in `test/fixtures` exist so
that the next review argues from what the CLIs actually said.
