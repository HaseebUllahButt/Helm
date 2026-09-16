# Handoff

State of helm as of 2026-09-15, evening, for whoever picks this up next.

Read `README.md` first for what the thing is and how it connects. This file
is the part that is not obvious from the code: **what it is trying to be**,
what changed today and why, what was verified by running it, and what was
not.

If you only read three sections, read **"What this is for"** (the bar the
rest exists to hit), **"Start here"** (what is running right now), and **"The
network, and why it is the whole latency story"** — that last one is not
about helm's code at all, and it explains most of what anyone has ever
complained about feeling slow. Every latency number in this file was
measured on 2026-09-15; none of them are estimates unless they say so.

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

As of 2026-09-15 the network is rebuilt and running: `helm status` on the
laptop reports **2 machines, 3 controllers**, network `076f00e81990`, with the
VM reachable at `https://130-210-33-163.sslip.io`. (The paragraph that used to
live here said nothing was running - that was true on the evening of the 14th
and is not true now.)

**Both machines were upgraded through the day** and are on the same commit
as `main`. One thing outside the repo changed too: the laptop's Tailscale now
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

## What changed today (2026-09-15)

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

Three things, all about the session list being worth reading.

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
screen (open, archive/unarchive, delete); external panes are tagged, not
manageable.

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

The other half of that report - "if there is a link, just auto open that
network" - is already the behaviour and was re-checked: a fresh browser at
`http://127.0.0.1:8787` signs itself in through `/api/auth/local` and lands on
the machine list (`2/2 online`), no link screen. That path is loopback-only on
purpose; see the loopback trap above.

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
