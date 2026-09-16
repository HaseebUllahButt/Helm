# Handoff

State of helm as of 2026-09-17, for whoever picks this up next.

Read `README.md` first for what the thing is and how it connects. This file
is the part that is not obvious from the code: **what it is trying to be**,
what changed today and why, what was verified by running it, and what was
not.

If you only read three sections, read **"What this is for"** (the bar the
rest exists to hit), **"Start here"** (what is running right now), and **"The
network, and why it is the whole latency story"** — that last one is not
about helm's code at all, and it explains most of what anyone has ever
complained about feeling slow. Every latency number in this file was measured
on the day its section is dated; none are estimates unless they say so.

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

## Start here: the network is up and both machines are current

As of 2026-09-16 the network is running: `helm status` on the laptop reports
**2 machines, 8 controllers**, network `076f00e81990`, with the VM reachable
at `https://130-210-33-163.sslip.io`. (The paragraph that used to live here
said nothing was running - that was true on the evening of the 14th and has
not been true since.)

**Both machines are on `main`** and were upgraded several times through the
16th; at the end of that day both served the same bundle as a local build,
which is the check worth repeating - a deploy that restarts the service but
serves an old `dist` looks exactly like a working one. One thing outside the repo changed too: the laptop's Tailscale now
has `--exit-node-allow-lan-access` on (see "The network" below, and do not
undo it by accident — the flag clears the exit node if passed alone).

The loop, whenever you push:

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

---

## The network, and why it is the whole latency story

Read this before touching anything that feels slow. Nothing in helm's code
accounts for most of the latency anyone has complained about; the shape of
the network does, and that shape is not obvious from any one machine.

```
  phone  ──────────────────────────┐
  (Pakistan, wifi or cellular)     │
                                   ▼
                          VM / Helm home
                          Oracle, MUMBAI
                          130-210-33-163.sslip.io
                                   │
                                   ▼
                          exit node, NEW YORK
                          DigitalOcean 157.230.182.111
                          (100.72.183.111 on the tailnet)
                                   │
                                   ▼
                          laptop "haseeb"
                          (Pakistan, 192.168.10.35)
```

The laptop runs **Tailscale with a New York exit node**, so its traffic to
the Mumbai VM goes **Pakistan → New York → Mumbai** and back. Measured
2026-09-15:

| leg | measured |
|---|---|
| VM ↔ exit node | **195ms** |
| laptop → VM, through the tunnel | **450–970ms** to connect |
| an RPC relayed hub→laptop and back | **1.1s** |
| phone ↔ laptop, direct peer-to-peer | **3ms** |
| Mumbai → Pakistan (via Singapore, hop 10 PTCL) | **146ms** |
| laptop daemon answering a ping on loopback | **1.3ms** |

The daemon is not slow. The path is long, and it is long by choice.

### What was wrong, and what was changed

The laptop had `ExitNodeAllowLANAccess: False`, which meant **it could not
reach its own LAN**: `ip route get 192.168.10.1` came back `dev tailscale0`
and a ping to its own router got 100% loss. The interface still held
192.168.10.35, so helm advertised it and a phone on the same wifi sent
packets there — and the replies left through New York and never came back.
ICE lost its one good candidate pair and fell back to relaying through the
hub, which is the 1.1s. Nothing anywhere said why; it just felt like helm
being slow.

Fixed on 2026-09-15 with:

```bash
tailscale set --exit-node=100.72.183.111 --exit-node-allow-lan-access=true
```

Now `1.1.1.1` still routes `dev tailscale0` (internet still goes via New
York, which is the point of the exit node) while `192.168.10.1` routes
`dev wlp115s0` and pings in 3ms.

**Two traps, both hit for real:**

- `tailscale set --exit-node-allow-lan-access=true` **on its own clears the
  exit node.** It did, and the laptop spent a minute routing out its own ISP
  before it was noticed and restored. Always pass `--exit-node=` in the same
  command.
- `tailscale up` refuses unless every non-default flag is restated, and the
  one easy to forget here is `--operator=haseeb` — without it you lose
  passwordless `tailscale` control. `tailscale set` does not have this
  problem, which is why it is the command to use.

`helm status` now catches the underlying condition itself: it compares the
interface holding the advertised LAN address against the interface the
kernel would really send that subnet out of, and says so when they differ
(`net-addr.js`, `lanIsRoutable`).

### What is still slow, and what would fix it

**Same wifi: solved and confirmed on the owner's phone (2026-09-15).** The
machine header reads `direct, same network`, which means session traffic goes
phone↔laptop over wifi and touches neither Mumbai nor New York.

**Do not hardcode the laptop's LAN address.** It moved from `192.168.10.35`
to `192.168.1.9` inside one session, because the laptop changed wifi
networks. That cost an hour and produced a confidently wrong conclusion: a
test against the old address failed, and it was read as "the router has AP
isolation and blocks phone-to-laptop traffic" when the truth was that the
address had ceased to exist. `helm status` prints what is actually
advertised; start there, and check `ip -4 -o addr` before believing any
result about the LAN.

**Phone on cellular: not fixable while the exit node is on.** Every route to
the laptop ends at New York, so it is ~1.1s a round trip. Predictive echo
(below) makes typing feel normal; scrollback, a large paste and anything
bulk stay slow. Two things would change it, both declined by the owner on
2026-09-15 and recorded here so they are not re-proposed as if new:

- **The phone on the tailnet.** Tailnet peer traffic does not go through an
  exit node — an exit node only carries internet-bound traffic — so
  phone↔laptop would connect directly and never touch New York. The daemon
  already offers `100.80.16.79` as an ICE candidate, and WebRTC is not
  subject to the mixed-content rule that stops the phone loading the app
  from `http://100.80.16.79:8787`. The owner does not want the phone on the
  tailnet.
- **Toggling the exit node off** while working from the phone
  (`tailscale set --exit-node=`) would make the relay path Pakistan →
  Mumbai → Pakistan: **~400ms round trip instead of ~1100ms**, not the
  ~200ms first guessed. India and Pakistan do not peer directly - the path
  runs east through Singapore and back, measured at 146ms to PTCL - so
  geographic closeness is not network closeness here. Do not estimate
  latency from a map.
- **A split tunnel for the hub alone**, which keeps the exit node for
  everything else. Tailscale's catch-all rule sits at priority 5270, so a
  lower number wins:

  ```bash
  sudo ip rule add to 130.210.33.163 lookup main priority 5100
  systemctl --user restart helm-serve
  ```

  Same ~400ms, without giving up the exit node for anything but helm's own
  link to the VM. Undo with `ip rule del`; it does not survive a reboot.
  Note that binding a socket to the LAN interface does **not** work as a
  substitute - Tailscale's rules match regardless of source address
  (`ip route get <vm> from 192.168.1.9` still says `dev tailscale0`).

**The option that is closed, so nobody spends an hour on it:** serving the
app from the laptop itself at `https://haseeb.tail2f39a8.ts.net` would
remove the VM from the path entirely — no mixed content, no WebRTC needed.
MagicDNS is on, but `tailscale cert` answers *"your Tailscale account does
not support getting TLS certs"*: this is `reachraza1@gmail.com`'s tailnet
and the owner is a member, not the admin. It would take that admin enabling
HTTPS certificates in the console. Worth asking for; not something this
repo can do.

### The phone is real, and it is the instrument

`helm devices` shows an **Android Chrome paired since 2026-09-14**, and it
is what the owner drives sessions from. An earlier version of this file
claimed "a real phone has never opened this"; that was wrong for a day, and
the report that started the latency work came from that phone. **Check
`helm devices` before writing anything about what has or has not been
tried.**

## What changed on 2026-09-17

Archived threads got a place to be, searching them got a way in, the network
got a brain, voice prompting landed, T3 left the tree - and then four things
the owner found by using it on a phone, three of which were real bugs.

### The app, after a day of using it on a phone

Three things the owner asked for once the brain was real.

**The brain is one, and tapping it lands in it.** It was showing the account
picker instead, for a real reason: the app only knows a brain exists once
every machine has answered `session.list`, and on a cold open that is a second
or two where the honest answer to "is there a brain?" is "not yet". The device
now writes down where its brain is (`brainStore`), so the answer is immediate.
The remembered record is only a signpost - enough for the header to draw - and
the live record replaces it the moment the machine's list arrives.

**A gear inside the conversation** leads to what the brain is made of, which
is the only sensible place for it: the brain has no folder to go back to and
no siblings to compare it against. That screen is the picker and the settings
at once, because they are the same question asked at different times. Changing
the model is a live change to the running session. Changing which account the
brain *is* ends the thread and everything it has learned, so it is a separate
action that says so and asks first.

**Projects in the sidebar.** machine → directory → session is how work is
started; it is not how anyone thinks about it afterwards. You think "the helm
one", and that lives in a directory which may well exist on two machines. So
every thread is also grouped by folder, across machines, newest first - each a
fold with the machine on the row and amber on the header when something inside
is waiting on you.

*Built from `session.list` by choice, not by omission.* It therefore shows
live and helm-known threads, and not the full history All sessions digs out of
each engine's own store - that would mean an inventory fetch on every sidebar
render. The owner was asked and chose cheap. Do not "fix" this without asking
again.

**History folds, live work does not.** A machine that has been worked at is
mostly past - one here lists 182 threads, six of them helm's - and printing it
all pushed the running work off the top of a phone screen, which inverts what
the screen is for. Every group folds except `needs you`, `working` and `idle`.
A session waiting on a person is never behind a tap, and a closed fold still
shows its count and goes amber when it holds something that needs answering.

### Found by using it: the laptop said its own VM was offline

**Symptom.** "laptop helm isnt picking up vm". The phone was fine.

**Cause, and it is a good one.** `probeEndpoints` gave every hub 2500ms to
answer and then took the one that saw the most machines. The owner's laptop is
behind a Tailscale exit node in New York, so its own hub answers on loopback in
**1.8ms** while the VM's takes **2.8-6.7s** (measured five times). Every probe
of the VM aborted before it replied, so the only hub that ever answered was the
laptop's own - and that hub cannot see the VM, because machines dial *out* to
the home and the VM can never dial back into a private LAN address. The app
then reported the VM offline while it was happily serving the phone.

One deadline was doing two different jobs. They are now separate: `PROBE_MS`
(2.5s) is how long to wait before settling for the hubs that have answered, and
`PROBE_PATIENCE_MS` (9s) is how long a hub is still allowed to answer at all.
`connect` attaches to the best answer it has at the first deadline and upgrades
if a slower hub turns out to see strictly more of the network. The upgrade is
sticky - `preferred` - because without it the reconnect would settle on the
near hub again and flap between the two forever.

Driven against the real network with the two real hubs seeded: settles, then at
t=12s reports **2/2 online** on `130-210-33-163.sslip.io`, with both machines
listed. Before: 1/2, on loopback.

*Slow must never read as gone.* That is the rule this broke.

### External sessions can be picked up from the phone

**The ask.** "start a session with my laptop and the VM and then continue that
from my phone". Sessions started at a keyboard were listed and could not be
opened - the wrong half of the promise, since the thread you most want on your
phone is the one you were just working on.

`SESSION_RESUME` and `SESSION_ADOPT` had been in `packages/protocol/index.js`
since the beginning **with nothing behind them**: no dispatch case, no
implementation, no caller. `session.resume` is now real.

There is no process to attach to - the CLI exited. It starts a *new* driven
session carrying the old conversation's id, so the engine resumes its own
transcript exactly as `claude --resume` would, and helm owns it afterwards like
any other thread. Every driver already treated a supplied `engineSessionId` as
"resume this"; what was missing was anything that supplied one.

**The account is the subtle part.** `inventory()` dedupes by engine and home
and keeps whichever alias it saw first, so the account it records names a
*home*, not something that can necessarily run: here `claude-p` and `claudea`
are both `CLAUDE_CONFIG_DIR=~/.claude-personal` and only `claudea` carries
`CLAUDE_CODE_OAUTH_TOKEN`. Resuming under the first one starts a CLI that
cannot authenticate and answers nothing - which looks exactly like resume being
broken, and did, for one round. It now resolves the recorded account to its
home and takes the alias best able to run it: credentials first, then plainest.

Proven with a conversation helm never touched: `claude -p "Remember this word:
PELICAN"` in a terminal, then `session.resume` through the daemon, then asking
the resumed thread what the word was - **"PELICAN"**. Resuming the same
conversation twice returns the same thread rather than two agents fighting over
one transcript, and the row disappears from the list on the next refresh
because `dedupeDetected` already matches it by `engineSessionId`.

In the app every external row is now openable - All sessions, the machine
screen's "earlier", and inside the archived fold - and says `opening` while the
engine starts, because starting a CLI takes a second and a row that does
nothing looks broken.

### The phone kept the old green logo

The icon changed on 2026-09-16 (`2fce0b1`) from emerald `#34d399` to the muted
`#131317`/`#c2c6d4`, and the installed PWA never noticed. Chrome updates a
WebAPK when the *manifest* changes, and every icon `src` was byte-identical
text - `/icon-192.png` before and after - so as far as Chrome was concerned
nothing had.

The icon URLs now carry `?v=2`, which makes the manifest genuinely different.
`background_color` and `theme_color` were still `#0b0d10` from the old palette,
and `index.html` still had `<link rel="mask-icon" color="#6ee7b7">` - the last
of the green, sitting in the shell the whole time. All aligned to `#0a0a0b`.

**This needs a deploy, and possibly one reinstall.** Chrome checks for a WebAPK
update roughly daily; if the icon is still green a day after deploying, removing
and re-adding the app is the certain fix.

### The service worker could pin a dead shell forever

Two faults, found while working out how the old icon survived:

**`addAll` is all-or-nothing.** One shell URL that 404s and the whole install
rejects, the new worker never activates, and the device keeps running the old
one - old shell, old icon - with nothing anywhere saying why. The page needs
`/index.html`; the icons are niceties and are no longer worth failing over.

**The cached shell was frozen at install time.** Navigation was network-first
with a cached `/index.html` fallback, and nothing ever wrote that cache again
after `install`. Every later deploy left it pointing at hashed bundles that no
longer exist, so the first open on a bad connection loaded an index.html whose
scripts all 404 - a blank app, and a deploy that looks like it worked
everywhere except the phone. A successful navigation now replaces it. `CACHE`
is `helm-shell-v4`, so the old one is dropped on activate.

### Still open

**Terminals on the VM produce nothing.** Reproduced through the real hub:
`session.start` succeeds (pty, 1.5s), `session.attach` returns **0 characters
of scrollback**, and a shell command sent into it is never echoed. Not a
missing pty - `loadPty()` returns true there on the linux-arm prebuild - and
not herdr, which plain terminals do not use (it is absent on the VM regardless:
`HELM_HERDR_BIN` points at `~/.local/bin/herdr`, which does not exist). The
`helm-terminals.js` host process **is** running, so the next thing to look at
is that host: whether it is a stale one from an older build, and what happens
to the shell it spawns. Restarting `helm-serve` on the VM is the first thing to
try.

*(Two false alarms on the way, both from measuring rather than reasoning: the
VM appeared to serve a 0-byte `favicon-32.png` - a flaky read over a 4-second
link, it serves 1384 bytes correctly - and node-pty appeared missing because
the check looked in `build/Release` when the VM uses a prebuild.)*

### Archived is a fold, on the screen it was archived on

Archiving had put threads on All sessions **and nowhere else**, tagged inline
among everything live - so "where did that thread go" had a two-screen answer,
and the screen they landed on got longer for no gain.

`Fold` is a section header that opens what is under it and counts it on the
way. Archived threads are folded at the bottom of the machine they were
archived on *and* at the bottom of All sessions, and they are out of the folder
groups rather than tagged inside them. A search opens the fold: a thread you
are looking for by name should be found whether or not you remember filing it.

### The search that existed and nobody could reach

All sessions has had a search box since 2026-09-16 - two taps down and below
the fold on a phone, which is the same as not having one. The sidebar now has
**Search threads**, which opens that screen with the cursor already in the box.
The machine screen got its own box (`search <machine>`) over the same words:
title, folder, engine. It appears past five rows and stays once you have typed.

Found by driving it: searching `caddy` matched one archived thread and the
empty state underneath still read "nothing matches" - wrong, and directly below
the thing that matched. It is suppressed when the fold is holding the answer.

### T3 is out of the tree

719 lines for a direction settled on 2026-09-14 ("no T3 code, no T3 apps"),
all of it landed in `c352547` alongside work that was wanted. Three states,
none of them load-bearing:

- `t3.js` and `t3-instances.js` (407 lines) - imported by nothing but each other.
- `apps/relay/src/publish.js` - constructed at startup and consulted on every
  request and upgrade, and inert twice over: `resolve()` bails unless the Host
  matches `homeHosts(net)`, which reads `HELM_HOME_HOST`, which is set nowhere
  but in its own test; and no daemon has ever advertised `info.t3.port`, so the
  best it could answer was `503`. That second gate is the reason it was inert
  rather than a live bug - without `homeHosts` returning `[]`, a bare request
  to the VM would have resolved to `no-t3` and 503ed instead of serving the
  PWA, since only `/helm/*` bypassed the proxy.
- `tunnel-socket.js` (publish's only importer) and `test/publish.test.mjs`
  (publish's only test).

`homeHosts` and `publishedPorts` went with them. What is genuinely lost is the
per-machine publishing trick - deterministic ports from the roster, WebSockets
tunnelled as raw bytes through a machine's own link - which is worth
remembering if helm ever publishes its *own* per-machine surface at the home
address. `git show c352547`, and branch `t3-network`, have all of it.

---

### The brain

**An addition, not a replacement.** machine → directory → session is still how
helm is used: you pick a machine, pick a folder, start an agent there and drive
it yourself. That is the product, it is unchanged, and it is the right way to
work when you know which repo you mean. The brain sits beside it for the times
you do not - "what is waiting on me", "tell that session to try again", a job
you want done somewhere without deciding where first. Anything the brain can do
you can do yourself, from the app or from `helm digest`/`say`/`spawn` in a
terminal; it is a caller of the same RPCs, with no privilege the owner lacks.

**One agent for the whole network rather than one per folder.** That is the
only thing it adds: a thread that is not tied to a directory, so a question
about the network has somewhere to be asked.

**It is an ordinary driven session.** Same driver, same event stream, same
permission cards, same model picker, same cost line, same `--resume`. It is
marked `brain: true` on the record, started with `cwd: '~'` and titled *Brain*.
Everything the app already does for a session, it does for this one for free -
including "change its brain", which is the model chip in the composer.

**Its tools are the `helm` CLI, through its own shell.** This is the decision
the rest follows from. The alternative was MCP, which is four different stories
(a Claude flag, a Codex toml, ACP for the other two) and version-fragile in all
four. A CLI is one story, works identically on every engine helm drives, and
its guardrail is the permission card the owner already answers on their phone:
`Bash(helm say d5b56b "…")` is a card like any other, and the mode chip
(`ask`/`edit`/`auto`/`yolo`) is the brain's blast radius.

Five verbs, in `packages/connect/bin/helm.js`:

```
helm brain [--account <id>] [--on <machine>]   open it (start or resume)
helm digest [--json]                           every machine, folder, session
helm thread <id> [-n 40]                       one conversation, folded
helm say <id> <text...>                        prompt an existing session
helm spawn <machine> <folder> <account> <text> start one and prompt it
```

They reach every machine through `hubRpc`, which existed and had no callers.

### The context problem, and the three layers that answer it

A busy laptop here holds 182 threads. "Give the agent everything that is going
on" cannot mean pasting transcripts, so `packages/connect/src/brain.js` is
built in three layers and **only the first is context**:

1. **A digest**: one line per live session - machine, folder, engine, model,
   status, cost, age, and what it last did. Archived and finished threads are
   left out. A hundred threads is a couple of thousand tokens.
2. **Depth on request**: `helm thread <id>` folds a conversation back into
   prose and tool calls; `helm digest --json` gives it structurally. The brain
   pulls what the digest made it curious about.
3. **Its hands**: `helm say`, `helm spawn`.

**Nothing is summarised by a model.** `lastLine` derives each line from the
tail of the event log a session already writes, ordered by what the owner would
want first: an unanswered permission beats a running tool beats the last thing
said. A digest costs one cheap RPC per machine and no tokens.

**What gets prepended is one line, not the digest.** `summaryLine` - `[helm
2026-09-16 18:00 · 2 machines, 1 offline · 1 waiting on you]` - goes in front
of every message the owner sends the brain, and that is all: a screenful of
machine state in front of every message would be a running cost on every turn,
in the transcript as well as the context. The line tells the brain whether the
picture is worth fetching. A test asserts it stays under 120 characters with
40 machines and 800 sessions.

It is really sent, so the app really shows it - but it is helm talking, not the
owner, so `Transcript.tsx` splits it back off and renders it as a quiet
monospace line above the bubble rather than inside it. The regex there and the
format here are pinned together by a test.

**Offline machines stay in the digest.** `snapshot.json` keeps what each
machine last said, and `mergeSnapshot` writes only what answered - so a
sleeping laptop appears dated ("last seen 3h ago") instead of vanishing. This
was the backlog item "offline machines are silently missing from every thread",
and for the brain it stops being cosmetic: a brain that omits a sleeping
machine does not have a gap in its knowledge, it has a wrong answer. Whether a
machine is "online" is derived from the snapshot's own timestamps, so the two
halves of a digest line cannot disagree.

The refresh is fire-and-forget on the send path (a message must not wait on
every machine answering) and on a 45s timer **only while a brain session
exists**, so a network without one pays nothing.

### Three bugs that only running it found

**The digest line was always blank.** `localDigest` read
`events.since(id, 0).events` - `since` returns the array itself - inside a
`catch` that said nothing, so every line came out empty, which looks exactly
like "nothing has happened in that session". The test had encoded the same
wrong assumption with a stand-in whose `since` returned `{ events: [] }`. It
now uses a real `EventLog` against a temp dir, which is the only version of
that test that could have failed.

**Events are flat, not `{ type, payload }`.** The first `lastLine` and the
first `helm thread` both read `e.payload.*` and printed `null` and
`[undefined]` against a real session. Events are `{ seq, at, type, ...fields }`
and incremental: a tool's arguments arrive as `item.delta` and land as
`item.update`, and a whole sentence from the model is nothing but deltas. Both
readers now `fold()` the log into items first and then look, which is also why
`helm thread` prints one line for a sentence instead of forty.

**The brain called the wrong `helm`.** Driven for real, `helm digest` came back
`unknown command "digest"` - the `helm` on PATH is the *installed* one, which
is behind the daemon whenever a deploy has not happened yet, and the brain then
tried to work around it with `helm status`. The brain's abilities are whatever
`helm` it can reach supports, so it gets its own: `ensureShim()` writes a
one-line `~/.helm/bin/helm` that runs *this daemon's* CLI with *this daemon's*
node, and a brain session's PATH starts with it. It cannot be out of step with
the code that wrote it.

Also: on a phone, tapping **Brain** rendered the screen behind the sidebar and
looked like nothing happened - `showMain` listed `threads` as the view with no
machine selected and did not know about `brain`.

### Verified by running it

Sandboxed daemon, real `claudea`/`claude-p` profiles, headless Chromium at
390×844 over CDP.

- `helm digest` end to end: CLI → `hubRpc` → daemon → `sessions.digest()` →
  `localDigest` → `render`.
- `helm spawn vm ~/dev/me/github/helm claudea "…"` started a real Claude
  session and prompted it; its derived line then read *"It's the user-facing
  guide to Helm…"* in the next digest.
- `helm brain` with no account listed the accounts and exited 1; with
  `--account claudea` it started, and the brain's **first act was to run
  `helm digest`** and block on the permission card - which is the design.
- Approved it: the brain read the network correctly, distinguishing helm's own
  sessions from adopted terminal panes, for $0.04.
- **The brain drove another agent**: told to ask `d5b56b` for PONG, it ran
  `helm say d5b56b "Reply with just the word PONG."`, and that thread replied
  `PONG`.
- In the app: the **Brain** row in the sidebar with its machine and engine; the
  thread with three `[helm …]` notes rendered as quiet monospace lines above
  the owner's bubbles; the start screen at phone width; and starting the brain
  by tapping an account, landing in the session with `brain: true`.
- Archived fold and search: both screens, unarchive from inside the fold,
  opening an archived thread from it, and search across machines.

`test/brain.test.mjs` is 15 tests: the derived line's ordering, folding deltas
back into sentences, the offline machine surviving a refresh, the prepended
line's size, and the pin between `summaryLine`'s format and the web's regex.

**A trap worth writing down**: Chromium served a cached `index.html` pointing
at a bundle from before the last build, and `Network.setCacheDisabled` did not
shift it - a cache-busting `?v=<epoch>` did. Two separate "the fix is not
working" dead ends came from that. Check which bundle the page actually loaded
(`performance.getEntriesByType('resource')`) before believing a UI check.

### Left for next time

- **The brain hits a permission card for every `helm` call**, including
  read-only ones. Correct by default, and tedious: either start it in `auto`,
  or teach the driver that `helm digest`/`helm thread` are reads. The card
  offers "always" and Claude remembers it, so this is smaller than it looks.
- **Only the machine running the brain has a shell for it.** Anything on
  another machine goes through `helm spawn`/`helm say`. That is the right
  default; a `helm run <machine> <cmd>` is the obvious next verb.
- `helm brain` puts the brain on the roster's `vm` if there is one, else this
  machine. There is no way to move one, and no second one is prevented across
  *different* machines - `brainSession()` is per machine.
- The machine screen's search and All sessions' search are two boxes over the
  same words. One of them should probably win.

---

## What changed on 2026-09-15

A short pass: make image attachments actually work everywhere they can.

**First, a trap worth knowing about.** This clone was eight commits behind
`origin/main` and its working tree still held the *pre-merge* version of the
terminal/pty work - the same changes, older. `git status` looked like a pile
of unpushed work; it was a pile of already-landed work. The tell is
`git fetch` followed by `git diff origin/main --numstat`: every file was
net-negative. If you meet that again, fetch before you believe the diff. The
old tree is kept in the stash (`pre-sync worktree snapshot 2026-09-15`) and
can be dropped.

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

### Latency: what was real, what was my own instrument

The owner's complaint was that phone-to-laptop terminal latency was "ass".
Measured before changing anything, which was the right call, because half of
what looked wrong was not.

**What is real.** A TCP connect from this laptop to the VM is **450-970ms**,
and an RPC relayed through that hub and back is **1.1 seconds**. The laptop
egresses through a VPN - its server-reflexive address is a datacentre IP -
so anything that leaves the machine pays that twice. Nothing helm computes
is the problem; the path is.

**What was not real.** The app said `direct connection · 947ms` on a link
that actually measures **3ms**. The samples were fine; the statistic was
not. A smoothed average seeded during page load folds in every source of
error - a busy main thread, WebRTC still settling, a daemon reading a file -
and each of those only ever adds, then the smoothing spread it over the next
minute. It reports the **minimum of the last eight samples** now, which is
the honest floor of what a path costs and recovers the instant one clean
sample lands. If you are about to conclude something from a latency number
in this app, check it has had ten seconds first.

**What was fixed.**

- **The terminal draws keystrokes before they have been anywhere**
  (`Terminal.tsx`), which is mosh's trick. A printable character is drawn at
  once and remembered as owed; the echo arrives and almost always begins
  with exactly what was drawn, so that prefix is dropped. A wrong guess is
  erased and the machine's bytes stand - the machine is always the
  authority. Timid on purpose: nothing until this program has been *seen*
  echoing, only printable characters, never on the alternate screen, never
  near the right edge where taking a guess back would cross a line break,
  and **never below 60ms**, where there is nothing to win. Verified by
  forcing it on: `echo aaa-bbb` came out once, not twice, and a `read -s`
  password prompt showed nothing on screen while all seven characters
  reached the shell.
- **The pty stopped batching echo.** 16ms frames are right for `cat`-ing a
  file and wrong for one keystroke, so the first chunk after a pause goes
  out immediately and only a real stream is coalesced.
- **`session.list` went from 103ms to 0.6ms.** All of it was
  `runtime.listLive`, which asked herdr two questions in series - and herdr
  answers one request per connection and then hangs up, so that is two
  connections built and torn down on every refresh of a machine you are
  looking at. Both at once now, and the answer is held for a second.
- **The machine header says which kind of direct it got**: "direct, same
  network" against "direct, out and back (srflx/srflx)", with the measured
  round trip beside it, amber past 250ms.

**Measured after:** direct same-network round trip **3ms**, keystroke to
pixels in a real terminal **~50ms** with prediction off (it is below the
threshold at that speed, and 50ms is three animation frames, most of it
xterm's own rendering).

**Worth knowing:** a browser hides its own host candidates behind mDNS
`.local` names, so the daemon cannot pair with them. It does not matter -
the *daemon's* LAN candidate is not hidden and ICE only needs one working
pair - but it is why reading a candidate list is confusing the first time.

### Notifications, slash commands, engine marks

- **Push (`packages/protocol/push.js`).** RFC 8291 payload encryption and
  RFC 8292 VAPID with node's own crypto, no dependency. `push.test.mjs`
  replays the RFC's own worked example and checks the body matches byte for
  byte - a wrong HKDF info string fails for every subscription while looking
  exactly like a delivery problem. Fires on `permission.request` and nothing
  else, because a phone that buzzes for every finished turn has its
  notifications switched off within a day. A 410 forgets that subscription.
  Tapping lands on the session that asked. Delivery happens on each hub,
  because the public VM owns the phone subscription even when the session
  runs on the laptop; the old machine-local lookup could never find that
  subscription. `notification-route.test.mjs` proves the remote-machine →
  subscription-owning-hub path. **Never delivered to a real phone** -
  everything up to the POST is verified against a stub service, but no Apple
  or Google endpoint has seen one, and headless Chromium cannot subscribe.
- **A `/` palette**, of things that actually run: helm's own actions, plus
  the owner's own command files where each CLI reads them. Deliberately not
  the CLI built-ins - `/help` through `claude -p` returns `ok` in 95ms having
  printed nothing.
- **Engine marks** are the vendors' real single-colour SVG shapes now:
  Claude, OpenAI, opencode and Devin. They stay inline and inherit the badge
  tint, so the PWA makes no logo request and needs no light/dark duplicate.

### The bug that made a whole driver dead code

`ENGINES` is one object literal that two people edited at once, and it
declared **`devin` twice**. The second had no `driver`, so it silently won:
every Devin session went to a herdr pane instead of the ACP driver written
for it - raw key strip where the model chips belong, no permission cards, no
clip. Nothing failed. A duplicate key is invisible in JavaScript, so
`engines-shape.test.mjs` reads them back out of the source.

### Two more found only by using the real app

- **The CSP was eating every attached image.** `img-src` was `'self' data:`,
  so `URL.createObjectURL` in the composer's decoder produced a `blob:` URL
  the page was not allowed to load, and every photo failed with "the browser
  could not decode it". Both fixed: `blob:` is allowed, and the decoder uses
  `createImageBitmap`, which needs no URL at all and applies EXIF
  orientation. Found by attaching a picture in the app rather than posting
  bytes over RPC, which is what every earlier check had done.
- **The image gate asked before the agent had started.** An ACP agent only
  says whether it takes images in its reply to `initialize`, and the driver
  starts lazily - so the gate read the initial `false` and turned the
  picture into `[image: dot.jpg]`, for Devin, which answers `image: true`.

### The UI: a revamp for weight and for hierarchy

Two complaints in one pass - the app was heavy to load, and the chrome
outshouted the things it was showing.

**Weight.** Everything shipped in a single 206KB gzipped chunk, so signing in
waited on a terminal emulator and a syntax highlighter that most sessions
never touch. xterm now loads when a terminal is opened; marked, DOMPurify and
highlight.js moved to `apps/web/src/md.ts` and are fetched on idle, so a
conversation still opens instantly and a cold start does not pay for them.
React is its own chunk so it survives a deploy in the browser's cache. First
paint went **206KB -> 87KB gzipped**. Until the markdown chunk lands, prose
renders as plain text rather than as a blank space.

**Cost while streaming, which was the bigger one.** The typewriter in
`Transcript.tsx` stepped once per animation frame, and every step re-parsed
the *whole* message through marked, DOMPurify and the highlighter - measured
at 1.5ms for a 3.5KB reply on the laptop, several times that on a phone, sixty
times a second - while a dependency-less effect in the same file read
`scrollHeight` and forced layout at the same rate. Agents emit tokens about
fifteen times a second, so the reveal now steps at about twenty: smoother
than the source it is smoothing, at a third of the work.

**Do not memoise turns to fix the rest of it.** The obvious next step is
`memo()` on `TurnView`, and it is a trap: `apply()` in `session/types.ts`
mutates turns and items in place and `publish()` hands back the same `turns`
array, so a memoised turn compares equal to itself and renders stale text
while the agent is still writing. It needs a version counter on the turn
first.

**Hierarchy.** Machines and sessions were quiet text rows while the setup
actions - things you do exactly once - were full-width slabs, and "New
session" was a saturated indigo billboard louder than the amber that means
*a session needs you*. That inverts the app's own rule about rationed colour.
Machines are cards now, setup is a footer of plain rows under "this device",
and the screen's action is tonal, so amber is the loudest colour again. One
type scale in `:root` replaced sixteen ad-hoc font sizes between 10px and
16px, rows and radii are tighter, and keyboard focus is visible at last -
tabbing through the app used to light nothing at all.

Found only by looking at it, once it was on screen: the session header
printed the machine name twice, the engine mark sat flush against the
subtitle it overlapped, the composer was translucent enough to read the
transcript through it, "open its own address" on the login screen rendered in
the browser's default blue-violet, a disabled button still looked pressable,
and the one emoji in the chrome is now a drawn paperclip.

### Also

`test/publish.test.mjs` and `test/gossip.test.mjs` both bound port 18991, and
the runner runs files in parallel, so `npm test` failed with `EADDRINUSE`
perhaps half the time. publish moved to 18961.

---

## What changed on 2026-09-16

A long day, in four movements: the session list became worth reading, a review
pass took the new code apart, three caches turned out to be broken or missing,
and the desktop app and the palette got the pass they had been owed. Each
section below is one push; each was driven against the real machines before it
was believed, and both machines were upgraded as it went.

The first three, all about the session list.

**Sessions name themselves, after two prompts.** ACP agents already report
the title they chose (`session_info_update`); the driver ignored it. It is
now a `title` event, and `Sessions` adopts a generated name only once the
session has two user prompts behind it - named on the first alone, a real
fraction of sessions would be called "hi". The agent's own name is kept on
the record as `generatedTitle` and outranks the fallback, which is the first
informative line of the first two prompts (greetings skipped). For engines
that never report a name - claude, codex - the prompt-derived one is all they
get. A `title` passed to `session.start` marks the record `titleBy: 'user'`
and is never overwritten. `session.resume`d sessions keep their count and
pending name in sessions.json, so the rule survives restarts.

**All sessions, one screen.** A "sessions" section in the sidebar opens a
view listing every session on every machine, grouped by folder - the place to
answer "what was running where". Rows have the same actions as the machine
screen (open, archive/unarchive, delete). *(External panes were tagged and not
manageable when this shipped; that changed the same day - see "Everything in
the list is the owner's to get rid of" below.)*

**Archived left the machine screen.** It used to list them under their own
section; now they only appear in All sessions, where they can be unarchived
or deleted. The empty state on a machine that holds only archived threads
says where they went. Archived terminals also stopped listing under
"terminals".

### The review pass on all of it

Six things, all found reading the three pushes above and all reproduced
before they were believed.

*The naming gate could shut for good.* It opened *at* the second prompt and
only then - `s.prompts !== TITLE_AFTER` - so a session that opened "hi",
"hello" spent its second prompt on nothing and was never offered a name
again, however much real work followed. The gate now opens at two and stays
open, and only prompts that say something are sampled. Driven for real: two
greetings to Claude left the folder name standing, and the third prompt
("what is 2+2?") named the session.

*A greeting could take a name that was already earned.* An ACP agent keeps
reporting a title and early ones are a copy of the prompt, so "thanks" three
prompts in outranked a real name (agent beats auto). Greetings are now
refused whoever says them, not only when they arrive through the prompts.

*The prompt sample went out on the wire.* Up to 400 characters of what was
typed, per session, in every `session.list` - which every paired device polls
every 15 seconds. It is helm's own note for naming the session; it stays on
the machine now.

*"Start me on Opus" was unreachable.* The daemon has always stored a default
with an empty approved list, and `applyModelPrefs` keeps the default in the
picker whether or not it was approved - but the settings screen disabled the
selector until something was checked, so the one setting most people want
could not be made. It can now, and the account row says the default even
when there is no short list.

*Model prefs took whatever a phone sent.* `approved` was written to
config.json unfiltered, and the daemon reads it back on every session start.
Names only now, trimmed and deduped.

*"no sessions yet" was a lie for the first few seconds.* All sessions asks
every machine on the way in, and that round trip is long enough to read. It
says what it is doing while it waits.

### Then three things on top, and the hole one of them uncovered

**Threads can be renamed.** There was no `session.title` RPC at all, and the
web never passed a `title` to `session.start` - so `titleBy: 'user'`, the top
of the ranking the naming work had just built, was unreachable from the phone.
It is in the ⋯ menu of a row and of a session, agents and terminals alike
("Terminal 1" is as much a guess as a name taken from two prompts). A name
typed here outranks anything generated and is never overwritten - proven by
renaming a live session and then sending it another prompt.

**All sessions has a search.** The screen was honest about what a worked-on
machine contains and that was the problem: six of eight rows were terminal
panes helm did not start. One box searches titles *and* folders ("the helm one
on the VM" is a path, not a title), and one pill hides what helm did not start.

**A thread says what it cost.** Every turn has always printed `4.8s · $0.02`
and nothing added them up. `turn.done` now accumulates onto the session record
- not summed from the log, which is trimmed, so a long thread would start
forgetting its early turns - and the total reads in the session header and in
every list row. A real three-turn Claude session: `$0.31`.

**The hole: the app waited 15 seconds to ask a 3ms question.** Measured while
checking the new screen - 12.5s from opening All sessions to seeing a row,
twice, on loopback. The socket trace says why: the machine list arrives over
HTTP, the session lists go over the socket, and the effect that lists them
ran before the socket was connected. Every `session.list` in it was rejected
as "not connected" and swallowed by `loadSessions`' own `.catch(() => {})`,
and nothing asked again until the 15-second poll tick. `conn.online` is now a
dependency of that effect. **12,578ms → 4ms**, and it was never specific to
the new screen: it was every cold open of the app, including the machine
screen, on every device.

### The chat cache had never once worked

`logCache.ts` has claimed since it was written that opening a chat "paints
instantly" from IndexedDB. It never did, for two reasons, each of which is
enough on its own and both of which land in a `catch` that says nothing.

**Two modules opened the same database at version 1.** `store.ts` (the
pairing, store `kv`) and `logCache.ts` (the chat cache, store `session-logs`)
each called `indexedDB.open('helm', 1)` and each created only its own store in
`onupgradeneeded`. Whichever ran first created the database; the second opened
the same version, so its upgrade never fired and **its store never existed**.
Every read and write from the loser threw `NotFoundError`. Which one lost
depended on the launch: a device pairing for the first time wrote `kv` first
and cached no chat ever after, while a device launching with its pairing
already in localStorage opened a chat first - and then the durable copy of the
pairing, the thing that exists to survive a browser evicting localStorage,
silently could not be written. Seen directly in a sandbox: `v1 stores=kv`,
with a two-turn chat open on screen.

**And every write would have thrown anyway.** The store is created with
out-of-line keys and `saveCached` called `put(record)` with no key beside it,
which is a `DataError`. So even on the launches where the store existed,
nothing was ever stored.

Now: one opener in `apps/web/src/idb.ts` that declares every store, at version
2 so databases already out there get the missing one built without losing what
they hold (watched it go `v1 stores=kv` → `v2 stores=kv,session-logs` with the
device still paired). Every put passes its key.

**What was also wrong, once it worked at all:** the log was written back only
when the view unmounted. A phone does not unmount views - it is swiped away,
or the tab is evicted in the background - so everything that streamed in since
the chat was opened was cached nowhere. It now saves two seconds after the
stream goes quiet, and again the moment the page is hidden. The herdr-pane
chats cache their read-back messages too, under their own key; they had no
cache at all and opened blank every time.

Measured after the fix, on a real Claude session: the record is there (23
events) while the chat is still open and nothing has unmounted, and reopening
the chat painted the transcript **4ms after the tap**, before the network was
asked at all.

Both chat views were driven, which for the herdr one meant building the
situation it needs: `workspace.create` + `agent.start` put a real `claude` TUI
in a pane helm had not started, answered its trust prompt with `Down`/`Enter`,
and prompted it - then the app adopted it as an external session. First open
wrote `msg:<env>:pane:w12:p1` with two messages; reopening rendered the reply
**4ms after the tap** with no assistant turn on screen beforehand. The pane was
closed afterwards by its workspace id; the other six in that herdr are the
owner's.

---

### Everything in the list is the owner's to get rid of

A machine that has been worked at is mostly rows helm did not start: a real
one here listed **182 threads**, of which six were helm's. The rest are the
terminal panes herdr holds and every session each CLI has ever recorded on
this machine - which is the point of reading those histories, but they arrived
with no menu at all. `managed` was `!adopted`, so the only threads that could
be archived or deleted were the ones helm ran.

Now every row has the menu, and the three kinds say what they actually do:

- **A thread helm ran** - rename, archive, *Delete thread* (ends the agent,
  removes the thread), as before.
- **A pane helm did not start** - archive, or *Close this pane*, which is
  honest about ending a program helm did not start. `session.kill` already
  closed the pane; the app simply never offered it.
- **A session found in a CLI's own history** - archive, or *Remove from helm*,
  which stops helm listing it and touches nothing else. **helm does not delete
  a CLI's transcript.** That conversation is the owner's data, not helm's
  record, and a menu item that quietly erased a year of Codex history would be
  the wrong kind of surprise.

There is no record of helm's to write on for either external kind, so the
answer is a mark kept beside the sessions in `sessions.json` (`external: {
"found:codex:<id>": "removed" }`). `list()` applies marks to panes and
`session.inventory` applies them to the histories, so the machine remembers
and every paired device agrees - archive one from a phone and the laptop shows
it archived too.

Driven on the real machine's herdr and CLI histories: 182 rows, every one with
a menu; archiving a found row tagged it `archived` in All sessions and took it
off the machine screen; removing one dropped the list to 181 and it was still
gone after a reload.

### The desktop window: the titlebar experiment is out

`display_override: ["window-controls-overlay"]` landed this morning and the
result on the owner's desktop was three stacked bars - the app's own titlebar,
Chrome's `127.0.0.1:8787` origin strip, and helm's top bar under it. Reverted,
along with its `@media (display-mode: window-controls-overlay)` block: a plain
`standalone` window again.

### The desktop app opened onto a form, with the answer as a link under it

The owner's desktop app is installed from the VM's address, so it lands on the
*pairing* screen: a code box, a "pair this device" button, and underneath, a
sentence ending in **"open its own address"** - which is the thing they
actually wanted, and had to click, every time.

It goes there itself now. When the page is not on loopback and a daemon on
this computer answers `/api/health`, the login screen replaces itself with
that address instead of drawing a form nobody should fill in. A link carrying
a pairing code, or a key from `helm open`, still wins - those are a deliberate
instruction to pair *here*. There is no loop: the local page takes the
`isLocal` branch and signs itself in.

Driven from `http://192.168.1.9:8795` (a non-loopback origin, standing in for
the VM's): within a second and a half the browser was at `127.0.0.1:8787`,
signed in, showing `2/2 online`.

**What this does not fix, and cannot from inside the page:** an installed PWA
has one origin in its scope. Sending it to `127.0.0.1` is out of scope, so
Chrome draws the grey origin strip at the top - which is where that strip in
the first screenshot came from. The way to be rid of it is to install the
desktop app *from this machine's own address* rather than the VM's ("Install
Helm app" in the sidebar, once it has landed there); then it is in scope, with
no redirect and nothing to click. The VM-hosted install remains the right one
for a phone, which has no daemon of its own.

### `helm app`, and the icon that was somebody else's

The desktop app is a command now: `helm app` writes a desktop entry pointed at
`http://127.0.0.1:<port>`, opened through a chromium-family browser with
`--app=` so it gets a bare window - no tab strip, no origin bar - and the local
key signs it in with nothing to type. `helm app --remove` takes it and its
icons away again. Linux only, like `helm service`; elsewhere it says so.

**The icon must not be called `helm`.** Icon lookup goes through the user's
theme before it falls back to hicolor, and Papirus - which this machine runs -
ships an unrelated `helm.svg`. Installing ours as `helm` at eight sizes
changed nothing: the launcher kept drawing Papirus's blue circle, because the
active theme is searched first and it had a `helm`. The name is `helm-app`,
which nobody else claims, and `Gtk.IconTheme.lookup_icon` confirms it resolves
to ours at 32, 48 and 128.

Icons come from `apps/web/public`: the shipped 192 and 512 PNGs and the SVG go
in as they are, and the smaller sizes are generated when the machine has
ImageMagick and skipped when it does not - a 512 scaled down by the launcher
is soft, but soft beats a hard dependency.

Also worth knowing, since it is the reason the command exists: **installing the
PWA from the browser is not the same thing.** A phone installs it from the VM's
public address, which is right. A computer that runs a daemon of its own then
has an app whose scope is the VM's origin, so it opens on a pairing screen, and
going where it should means leaving that scope - which Chrome marks with the
grey origin bar the owner asked to be rid of.

### "reconnecting", with a working hub on the other end of the socket

Found while checking the desktop app actually worked, by looking at its
sockets rather than its screen: `ss` showed chromium in `SYN-SENT` to
`192.168.10.35:8787` and `10.7.171.6:8787`, and **nothing established to
`127.0.0.1:8787`** - the address that had just served it the page. The first
of those is the LAN address this laptop stopped having days ago (see "Do not
hardcode the laptop's LAN address" above).

`learn()` folds every address a machine advertises into the device's list,
newest first, capped at twelve so a laptop that travels does not probe every
cafe it ever visited. Two machines advertising a LAN address, a tailnet
address, a public one and whatever they had last week is already more than
twelve - so **the origin the app was served from was being pushed off the end
of the list**, and `connect()` would then probe twelve addresses none of which
this browser could reach.

The origin serving the page answers by definition. It now leads the list, in
the constructor and in every `learn()`. Measured against the real daemon by
overwriting a signed-in device's stored endpoints with three dead addresses:
the old build sat on `offline` / "no machines yet" for as long as it was
watched; the new one reloads to the machine list.

**And the dead ones are dropped now, which they never were.** `learn()` was
additive: an address only ever left by being pushed off the end of the cap, so
a device carried every address it had ever been told about and probed them all
on every connect. Pruning happens only after a *successful* connect, holding a
freshly advertised list from a hub that answered, and only for an address that
is no longer advertised **and** was just tried **and** did not answer. Nothing
is dropped while it works; nothing a sleeping machine still advertises is
dropped; and a failure cannot be blamed on the address when the device itself
was offline, because then there would have been no successful connect to prune
from. Both halves driven against the real daemon: three dead addresses gone on
the first reload, while `http://localhost:8787` - the same daemon under a name
the network does not advertise - was kept, because it answered.

A note on why the page cannot just sign itself in where it stands: the daemon
refuses `/api/auth/local` to a cross-site fetch on purpose (`sec-fetch-site`),
because Caddy makes every internet request arrive from loopback. Navigating is
the honest route, not a CORS hole.
### The model catalogue: the slowest read in the app, remembered

"Do you cache this stuff?" - pointed at the Models screen. Half: the daemon
held a catalogue for sixty seconds in memory (`models.js`), and the app held
nothing at all. So opening the screen twice in an afternoon spawned the CLI
twice, and for opencode that is a process enumerating three dozen models while
a phone waits on the other end of a relay. It is why that RPC carries a 45
second timeout and the screen has an "asking the CLI for its models…" state.

Now: the device remembers what it last heard (`modelCache.ts`, in the `kv`
store beside the pairing) and paints it immediately, with the machine's answer
replacing it when it lands - the same shape as the chat cache. The daemon's
own hold went from one minute to ten, because a catalogue changes when a CLI
is upgraded or its config is edited and neither is urgent to notice.

Measured on the real daemon, opencode's 36 models: **4,973ms to a list on
screen with nothing remembered, 107ms with.** Both pickers use it - the
session's model sheet as well as the settings editor - so the model chip in a
session header stops reading "default" until a CLI has been spawned.

### A quieter palette, and a wheel that reads at 20px

The owner's words were "the UI still looks vibecoded, mute the green neon".
Screenshotting the two main screens at 390x844 said what that meant:

- **Three neon dots on the first screen.** `--emerald` at full chroma was the
  brightest thing on a near-black page, and it was spent on *online* - the
  state a machine is in almost always. Now `oklch(0.74 0.068 165)`, a sage
  that says "alive" without being the first thing you see. Amber, which means
  "a session is waiting for you", is the loudest colour again, which is what
  the sheet's own comment says it should be.
- **The settings button was a full-colour cyan gear.** `⚙` is U+2699 and most
  systems render it from the emoji font, so the quietest button on the bar
  came out brighter than anything else. It is an inline SVG now.
- **Nine engine marks in nine saturated vendor colours** read as a bag of
  sweets. Each is at about two thirds its shipped chroma and the tiles behind
  them went from 14-16% to 10-11%: still recognisable at 26px, no longer a
  competition.
- **Every row was an outlined card.** Nine bordered rectangles down a screen
  compete with their own contents; the fill alone says "row" and the hairline
  comes back on hover.
- **"New session" was a full-width tinted banner** above the list it belongs
  to. It is now a row: the same height, the same left edge, and a `+` where
  each row keeps its engine mark, so its label starts on the same line as
  every title underneath it.
- **`external` was the first thing an ellipsis ate.** The tag lived inside the
  truncating title, so on a long name the one word saying what the row was
  disappeared. The title truncates; the tags beside it do not.
- **opencode rows showed a wall of JSON** where the model goes - it stores
  `model` as `{"id":…,"providerID":…,"variant":…}` and the inventory reader
  passed it through whole.

**The logo.** The old mark was a neon gradient wheel with eight spokes and
eight handles: at 32px it was a green asterisk, and at 20px in the sidebar it
was mush. Four shapes were drawn and rendered at 20/32/48/128 to look at
rather than to imagine - ring-and-nubs read as a sun, ring-and-dots as a
camera aperture, four spokes as a crosshair. Six spokes with six handles is
the one that reads as a ship's wheel at every size. One muted colour
(`#c2c6d4`), no gradient, on a `#131317` tile with a hairline. Every asset was
regenerated from it, including a maskable icon whose mark is pulled in to 78%
so a circular mask cannot clip the handles.

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

**2. Three commands printed a link; now each is named for what it adds.**
`helm add controller | pc | vm`, and bare `helm add` lists the three rather
than guessing. Only `controller` prints a link to **open**; `pc` and `vm` print
a code to **type**, and the far machine always runs the same `helm join <code>
<url>` - the invite carries its role (`invites.role` in the hub db), so a vm
additionally claims its address, configures Caddy and serves, with no second
command to remember. The serve banner no longer prints a password on every
start, only when the network has no controllers yet or on `--link`; that was
what made `setup`, `join` and a plain restart all look like they were handing
you a link.

**3. `helm open` signs the app in on the machine itself**, which is what makes
the laptop a controller for the VM. **The trap here nearly shipped:** Caddy
terminates HTTPS and proxies to the hub over loopback, so *every request from
the internet arrives at the hub from 127.0.0.1* - a bare loopback check would
have handed a device token to anyone who could reach the public URL. It
requires loopback **and** the local key from `~/.helm/local.key` (0600, minted
on demand), compared in constant time. `test/local-login.test.mjs` encodes
that: the key works, and no-key, wrong-key and wrong-length all get 401 from
the same loopback address.

**4. Moving networks re-probes.** The client already raced every known address
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

### 2026-09-16

- `npm run check` green at every push: types, production build, **117** node
  tests (90 the day before), `network.sh`.
- **Session naming driven against a real Claude session** in a sandbox daemon:
  two greetings left the folder name standing, the third prompt named the
  thread, a rename held through another prompt, and `sessions.json` showed
  `titleBy: user` with the prompt sample kept on the machine.
- **The herdr-pane chat driven by building the situation it needs** -
  `workspace.create` + `agent.start` put a real `claude` TUI in a pane helm had
  not started, its trust prompt answered with `Down`/`Enter`. The app adopted
  it, cached its messages, and reopening painted the reply **4ms after the
  tap**. The pane was closed afterwards by its workspace id.
- **Caches proved by breaking them.** The chat cache: `v1 stores=kv` with a
  two-turn chat open on screen, then `v2 stores=kv,session-logs` with the
  device still paired. Endpoints: a signed-in device's stored addresses
  overwritten with three dead ones - the old build sat on `offline`, the new
  one reloaded to the machine list and had dropped all three, while
  `http://localhost:8787`, which answers but is not advertised, was kept.
- **Numbers, all measured on this laptop, not estimated:**
  cold open of All sessions **12,578ms → 4ms**; a chat painting from the
  device **4ms** after the tap; the model catalogue **4,973ms → 107ms**;
  `session.list` answered by the daemon in **3ms** while the app was taking 15
  seconds to ask for it.
- **The desktop app driven from a non-loopback origin** (`192.168.1.9:8795`,
  standing in for the VM's): a second and a half later the browser was at
  `127.0.0.1:8787`, signed in, `2/2 online`. `helm app` then verified through
  `desktop-file-validate`, `Gtk.IconTheme.lookup_icon` and `gtk-launch`.
- **The look judged from screenshots, not from the CSS**: both main screens
  captured at 390x844 before and after, and four logo candidates rendered at
  20/32/48/128 to be looked at.
- **Deployed to both machines after every push**, each time checking that the
  public HTTPS address and the laptop served the same bundle hash as the local
  build - and, for the caching work, that the fix was actually in the shipped
  JavaScript.

### 2026-09-15

- `npm run check` green: types, production build, **90** node tests,
  `network.sh`.
- A remote-machine notification reached a stub push service through the hub
  that owned the phone subscription, stayed encrypted, and a repeated frame
  with the same permission-request tag did not send twice.
- The revamped UI driven in headless Chromium at 390x844 and 1280x800 against
  a sandbox daemon: login, machine list, machine screen, transcript, the `/`
  palette, and a real pty through the lazily-loaded terminal chunk - which
  confirms the code split does not break the mount. Production build measured
  before and after.
- **Deployed to both machines and driven against the public HTTPS address**,
  not loopback: paired a browser, opened the laptop *through the VM's hub*,
  started a Devin session, attached a picture through the real file input and
  watched it compress, preview and send.
- **Latency, measured:** direct same-network round trip 3ms; `session.list`
  0.6ms (was 103ms); keystroke to pixels in a real terminal ~50ms. The
  relayed path is 1.1s a round trip and always will be - that is the VPN and
  the distance, which is what predictive echo exists for.
- **Predictive echo, forced on to test it:** `echo aaa-bbb` appeared once,
  and a `read -s` prompt showed nothing while all seven characters reached
  the shell.
- **The terminals are fast again on this laptop.** node 26 is ABI 147 and
  node-pty ships binaries up to 131, so there was nothing to load and helm
  had quietly been on the slow herdr-pane path since the last upgrade;
  `install.sh` builds the addon now instead of only reporting it missing.
- **The laptop can reach its own LAN again**, which is the thing that should
  make the phone fast on home wifi: `ping 192.168.10.1` went from 100% loss
  to 3/3 at 3ms, `ip route get 192.168.10.1` from `dev tailscale0` to
  `dev wlp115s0`, and the internet route stayed on `dev tailscale0` with the
  public address still 157.230.182.111. Verified from the laptop only — **the
  phone has not been checked since**, which is item 2 of the backlog.
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
  session shows **one** user bubble carrying the red square (two before the
  reducer fix), zero broken images, and the clip in place.
  Screenshots taken at each step.

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

1. **Push has never reached a real device.** The encryption is checked
   against RFC 8291's own worked example, and the normal laptop → VM hub →
   subscribed phone topology is covered against a stub push service, but no
   Apple or Google endpoint has been handed one. This is thirty seconds to
   settle: open the app on the phone, "notify this device" in the sidebar,
   then let a session ask for permission.
2. **The touch-facing work has only been driven in headless Chromium** at
   390×844 — the `/` palette against a software keyboard, and predictive
   echo, which above 60ms is exactly what a phone on cellular runs.

   *(An earlier version of this list said "a real phone has never opened
   this". That was wrong and had been wrong for a day: `helm devices` shows
   an Android Chrome paired since 2026-09-14, and the complaint that started
   the latency work — "mobile to laptop terminal latency is ass" — came from
   it. Check `helm devices` before repeating anything in this section.)*
3. **Devin got the image and named the colour wrong.** It answered
   "Turquoise circle" to a red square with a white circle - shape right,
   colour wrong, and it read no files that turn. helm's side is clean: the
   JPEG on disk is 64×64 with corner `(254,0,0)`, and those are the exact
   bytes handed to the driver. Worth one more look with a different picture
   before deciding whose problem it is.
4. **opencode has no credit** ("Insufficient balance"), so its image path is
   verified only as far as the agent accepting the content block.
5. Codex `item/permissions/requestApproval` deny and `requestUserInput` are
   coded from the bindings and have never been seen live.
6. **herdr's own answer is ~100ms** for a pane listing, which is now cached
   rather than fixed. If adopted panes ever start feeling stale, that cache
   (`LIVE_TTL_MS`) is why.
7. **An installed PWA cannot be sent to another origin without the grey bar.**
   The app installed from the VM's address now redirects itself to the helm on
   this computer, which is out of its scope, so Chrome draws its origin strip
   over the top. Nothing in the page can prevent that; installing the desktop
   app from the machine's own address (`helm app`) is the way round it, and
   the VM-hosted install stays right for a phone.
8. **An installed app keeps yesterday's icon and CSS until it is reopened.**
   The service worker holds the shell, so a deploy that changes the look does
   not show until the window is closed and opened again - which made "the logo
   did not change" look like a failed deploy twice on 2026-09-16. Check what
   the machine *serves* (`curl -s <addr>/icon.svg`) before believing the
   screen.
9. **The brain asks permission for every `helm` call**, reads included.
   Correct by default and tedious in practice: start it in `auto`, or answer
   "always" once on `helm digest`. See "The brain" under 2026-09-17.
10. **The model catalogue can be ten minutes stale**, by choice - `models.js`
   holds it that long and the device paints its own copy first. Upgrade a CLI
   or edit its config and the new model will not appear immediately. There is
   no "refresh" in the app yet; reopening after the hold expires is all there
   is.

## The machines themselves

Both run Linux with helm in `~/.helm-src`. Kept across the wash:
`profiles.json` on both, `secrets.env` on the laptop, and the ssh keys.

- **The laptop is on Tailscale behind a New York exit node**, which is the
  single biggest thing shaping how helm feels — see "The network, and why it
  is the whole latency story". `--exit-node-allow-lan-access` is **on** as of
  2026-09-15; it was off, and that was why a phone on the same wifi relayed
  everything through Mumbai. Do not change exit-node settings with
  `tailscale set` without passing `--exit-node=` in the same command: alone,
  the LAN-access flag clears the exit node.
- **node 26 on the laptop has no prebuilt `node-pty`** (ABI 147; the package
  ships up to 131), so it is compiled from source. `install.sh` does that
  now. If terminals ever feel like they are polling again, `helm status` says
  `own pty` or `herdr panes (slow)` and which.

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
have since been built (`opencode acp`, and images across all four engines),
and so, on 2026-09-16, have renaming a thread, searching All sessions, a
per-thread cost, and a desktop entry (`helm app`).

Of the four things proposed that day and not built, two were done on the
17th: **the brain** (which was ranked last, as v2) and, because the brain
could not be honest without it, **offline machines in the network-wide
picture** — though only in the brain's digest, via `snapshot.json`. The web's
All sessions screen still loads lists for online machines only, so that screen
still under-reports a sleeping laptop. It could now read the same snapshot.

Still wanted:

1. **Machine-side defaults for mode and effort, not just the model.** `Start`
   says it out loud: the model default lives on the machine where every device
   agrees, while the permission mode, thinking effort and auto flag live in
   *this phone's* localStorage. The same argument the model-prefs work made,
   applied to the other three.
2. **All sessions should show offline machines too**, from the snapshot the
   brain already keeps, dimmed with "last seen 3h ago".
3. A **file viewer** over Claude's `read_file` control request.
4. **`helm run <machine> <cmd>`** — the brain reaches other machines only by
   spawning or talking to a session on them, which is the right default and
   sometimes the long way round.

---

## Testing

```
npm test          # node --test test/*.test.mjs && bash test/network.sh
npm run check     # + tsc and the production web build
```

Driver tests replay the recorded fixtures through `test/fake-cli.mjs`;
`events.test.mjs` covers the log; `session-driver.test.mjs` runs `Sessions`
with a fake driver (naming, renaming, cost, and what may be done to rows helm
does not own); `session-stale.test.mjs` covers the dead-pane status;
`emit-once.test.mjs` encodes the duplicate-push guard; `modes.test.mjs` keeps
the two codex sandbox spellings agreeing; `model-prefs.test.mjs` covers the
per-account picker and refuses anything that is not a model name;
`inventory.test.mjs` reads each CLI's own history, including opencode storing
its model as JSON; `desktop-entry.test.mjs` writes `helm app`'s launcher into
a temp `XDG_DATA_HOME`, so running the suite never touches a real desktop;
`brain.test.mjs` covers the digest — the derived line's ordering, folding
deltas back into sentences, an offline machine surviving a refresh, the size
of the line prepended to every brain message, and the pin between that line's
format and the regex the web splits it off with.

**The web has no test runner**, which is why so much of this file is
measurements taken from a browser instead. Anything that only shows up on
screen - a cache that never worked, an endpoint list that had evicted the
address serving the page - was found by driving the real app, not by a test.

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
