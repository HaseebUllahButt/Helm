# Handoff

State of helm as of 2026-09-14, evening, for whoever picks this up next.

Read `README.md` first for what the thing is and how it connects. This file
is the part that is not obvious from the code: **what it is trying to be**,
what changed today and why, what was verified by running it, and what was
not.

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

## What changed today (2026-09-14)

### Drivers — `packages/connect/src/drivers/`

One driver per engine runs the CLI *you already have installed*, through the
profile helm discovered (so `CLAUDE_CONFIG_DIR` / `CODEX_HOME` multi-account
keeps working unchanged), and translates its protocol into one vocabulary:

```
turn.start · item.start/delta/update/done · permission.request/resolved ·
turn.done · status · limits · error
```

`item.kind` is `text`, `thinking`, `tool`, `command` or `edit`;
`permission.kind` is `tool`, `command`, `edit`, `question` (AskUserQuestion,
Codex requestUserInput) or `plan` (ExitPlanMode). Both drivers emit exactly
this, so the app has one renderer.

- **`claude.js`** — `claude -p --input-format stream-json --output-format
  stream-json --verbose --include-partial-messages --replay-user-messages
  --permission-prompt-tool stdio --permission-mode <mode> [--model] [--effort]
  --session-id=<uuid>` (or `--resume=<uuid>`). One process per session; stdin
  stays open for its life (closing it ends the session). `content_block_*`
  stream events become items and deltas; `user` messages with `tool_result`
  close tool items (rendered from `tool_use_result`, not the text);
  `can_use_tool` control requests become permission requests, answered with a
  `control_response`. Interrupt, `set_model` and `set_permission_mode` ride
  the control channel. **Fail-closed rule:** an unanswered `can_use_tool`
  blocks the CLI forever, so kill denies anything pending first, and a
  process exit cancels them in the log.
- **`codex.js`** — `codex app-server --stdio`, newline-delimited JSON-RPC.
  One server per account home (it hosts many threads), one driver per thread.
  `thread/start` / `thread/resume`, `turn/start` with per-turn `effort`,
  `turn/interrupt`. Notifications `item/*` and `turn/*` map to items; server
  requests `item/commandExecution/requestApproval`, `item/fileChange/
  requestApproval`, `item/permissions/requestApproval`, `item/tool/
  requestUserInput` become permission requests answered by id.
  `serverRequest/resolved` dismisses a prompt answered elsewhere.
- **`index.js`** — the base class, a 50 ms per-item delta coalescer (a model
  streams a few words at a time; a phone on a bad route does not want a
  frame per delta), the NDJSON reader, and a version check that warns loudly
  if the CLI is older than the one the driver was written against.
- **`modes.js`** — the four permission ideas in each CLI's own flags: Claude
  `manual` / `acceptEdits` / `plan` / `auto` / `bypassPermissions`; Codex
  `approvalPolicy` × `sandbox` (ask = on-request+workspace-write, edit =
  never+workspace-write, full = never+danger-full-access, readonly =
  untrusted+read-only).
- **`events.js`** — `EventLog`: per-session append-only log under
  `~/.helm/events/<id>.jsonl`, sequence numbers, last 2000 kept, pending
  prompts and the open turn derived from the log (right after a restart too).

### The daemon — `sessions.js`, `agent.js`, `protocol`

`Sessions.start` branches on the engine: claude/codex → driver, shell → herdr.
Driven records carry `driver`, `engineSessionId`, `mode`, `effort`. Events go
to the log and out as `session.event` batches, **gated by `session.watch`**
(60 s TTL, renewed by the viewer): the relay fans out per machine, so this is
what keeps a phone from receiving every session's text. A process that exits
leaves the session `idle` and resumable; an idle process is reaped after 30
minutes and the next message resumes the same conversation; only `kill`
removes the record and its log. On daemon start, prompts orphaned by the
previous process are cancelled in the log and an open turn is closed as
`interrupted`, so a phone never shows a question nobody can answer.

New RPCs: `session.events {since}`, `session.watch/unwatch`,
`session.answer {requestId, decision}`, `session.interrupt`, `session.mode`,
`session.model`. `model.list` now returns `modes` and Claude's `efforts`.

### The app — `apps/web/src/session/`

`useSessionLog` loads the log, renews the watch, applies pushes in sequence
order and refetches on a gap or reconnect. `Transcript` renders turns:
prose typed in with a caret (the visible length chases the real length a
few characters a frame, off under reduced motion), thinking as a folded
line with its duration, tools as one line that folds its output, commands as
a card with the live output tail and exit code, edits as per-file diffs with
+/− counts. `PermissionSheet` docks above the composer: command / diff / plan
/ JSON with the CLI's own options (Allow · Always allow… · Deny, deny-first
when the CLI says so); questions as option rows with an automatic "Other";
plans as markdown with Approve / Keep planning (+ an optional note that goes
back as the deny message). Stop sits beside Send while a turn runs. The
header's model is a tappable picker. The Start screen's
"act without asking" switch became the engine's mode list.

`ModeSheet` is where permissions live once a session is running: a chip in
the composer's foot saying the mode in one word (ask / edit / plan / auto /
yolo), tapped to dock the full list in the prompt's slot. shift+tab cycles,
skipping any mode marked `danger`; a danger mode arms on the first tap and
commits on the second, then colours the chip and the composer so the state
is never a surprise. The header's mode button opens the same sheet.

---

## Verified today, by running it

- `npm run check` green: types, production build, 35 node tests, and
  `test/network.sh`.
- **Recorded reality first.** `scripts/record-driver.mjs` ran one real turn
  per case through a helm profile (real account, real credential) and kept
  every stdout and stdin line under `test/fixtures/{claude,codex}/`. The
  drivers' tests replay those through `test/fake-cli.mjs`, which pairs
  requests and responses the way the real CLIs do. What the recordings
  settled, none of it guessed:
  - AskUserQuestion is answered through the permission response as
    `updatedInput: {...input, answers: {question: label}}` — narrowing the
    options fails schema validation (min 2). Confirmed: "You chose Spaces."
  - ExitPlanMode arrives as a `can_use_tool` with `input.plan` and
    `requires_user_interaction: true`; allow → "User has approved your plan".
  - A Write prompt carries `permission_suggestions: [{setMode acceptEdits,
    session}]`; echoing it back as `updatedPermissions` stops the next Write
    from prompting.
  - `echo` never prompts in default mode (built-in safe list). `--permission-
    prompt-tool stdio` is what routes prompts to us; `--verbose` is required.
  - The CLI echoes a `control_response` acknowledging our answer on stdout.
  - Codex approvals list `availableDecisions` (`accept`, `acceptWith
    ExecpolicyAmendment`, `cancel`); `decline` is accepted even when not
    listed. `thread/start` rejects `sessionStartSource: 'appServer'`.
- **End to end on this laptop**, sandboxed `helm up` (`HELM_DIR`,
  `HELM_NO_SERVICE=1`) with the real `claudea` and `codex` profiles, driven in
  headless Chromium at 390×844 over CDP:
  - pair from the link; machine → New session → folder → account, `haiku`,
    "Ask before acting" → Start;
  - a Write asks: the sheet shows the path and `+hi`, Allow unblocks, the
    turn closes with `4.8s · $0.02`;
  - AskUserQuestion renders "Indentation / Tabs or spaces?" with two option
    rows and Other; tap Spaces, Answer → "You chose **Spaces**.";
  - a prose-only turn streams with the caret; Stop lands as "stopped" with
    the partial text kept (226 chars when pressed, 289 at the end);
  - the mode picker → "Edit freely" → the next Write goes through with no
    prompt (`second.txt` on disk);
  - (second pass, the mode chip) in `ask` a Write prompts and Allow closes
    the turn at `3.5s · $0.09`; shift+tab → `edit` and the next Write goes
    straight through, no sheet, `two.txt` on disk. Codex, one thread: "write
    outside the workspace" → "it did not work - the filesystem is read-only
    outside the workspace"; chip → yolo; the same prompt → "Worked - the
    file was written and verified", the file on disk. That second half only
    works because `turn/start` now carries `sandboxPolicy` as well as
    `approvalPolicy` - before, a mode change stopped the questions but left
    the sandbox where `thread/start` had put it, and the UI was lying;
  - daemon killed and restarted → the transcript is still there, the next
    message resumes with `--resume` → "The file I created first was
    hello.txt.";
  - Codex in "Read only": `echo hello from codex` asks (Allow · Always allow
    echo · Deny), Allow runs it, the command card shows the output, `12s`.
- Two bugs found by that run and fixed: sending a message while a prompt is
  open flipped the status to `working` (the CLI queues it; it is still
  blocked); prompts orphaned by a daemon restart stayed on the phone.

## Not verified, in order of risk

1. **Nothing is deployed.** The Oracle VM (`130.210.33.163`) has no helm.
   `install.sh` + `helm setup` there, pair a phone, `helm link headless` a
   laptop. Watch node-pty's build deps and Caddy's certificate.
2. **A real phone.** Everything above was a 390×844 headless Chromium. Touch,
   the keyboard pushing the sheet, and a carrier-NAT WebRTC path are untested.
3. **Codex `item/permissions/requestApproval` deny** answers `{permissions: {},
   scope: 'turn'}` — from the bindings, never seen live. `requestUserInput`
   likewise never triggered.
4. **Claude on a non-default account was exercised (`claudea`); the default
   `~/.claude` login on this laptop is expired** — the first `plain`
   recording caught `authentication_failed`, which the driver surfaces as an
   `error` event. Expect that when a token lapses.
5. **Throughput on a slow link.** Deltas are coalesced at 50 ms and pushed
   per session; a 700-word essay was fine on loopback. Unmeasured over a hub
   on mobile data.
6. **Windows/macOS**: service install is Linux-only, as before. herdr is still
   required for `helm up` (it is started for terminals).

---

## Where things stand

The laptop's real `~/.helm` still runs the old service (`helm-serve.service`,
network of one); it was not touched. The e2e work used a scratch `HELM_DIR`.

Not yet pushed to GitHub (remote `git@github.com-me:HaseebUllahButt/helm.git`).

Branches: `main` is this. `t3-network` holds the 2026-09-13 experiment (T3 as
the UI, Host:port publishing through the hub, `tunnel-socket.js`); its
network bits could be cherry-picked, its UI direction is over.

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

- **Push notification when a session blocks.** Still the highest-value missing
  feature; `permission.request` is now a structured event to hang it on.
- **opencode driver** (`opencode serve` SSE or `opencode acp`).
- **The brain** (cross-machine summaries and dispatch) — v2.
- Images in messages; a file viewer over Claude's `read_file` control request.

---

## Testing

```
npm test          # node --test test/*.test.mjs && bash test/network.sh
npm run check     # + tsc and the production web build
```

Driver tests (`driver-claude.test.mjs`, `driver-codex.test.mjs`) replay the
recorded fixtures through `test/fake-cli.mjs`; `events.test.mjs` covers the
log; `session-driver.test.mjs` runs `Sessions` with a fake driver (start,
stream, watch TTL, prompt, mode/model, exit-and-resume, kill, restart).
To re-record after a CLI upgrade: `HELM_PROFILE=claudea node
scripts/record-driver.mjs claude` (and `codex`); scrub home paths and the
owner's email before committing (the script collapses `$HOME` to `~`).

**Seeing it work** is a sandboxed daemon plus headless Chromium over CDP:

```
HELM_DIR=<tmp>/helm HELM_SSH_DIR=<tmp>/ssh HELM_NO_SERVICE=1 \
  node packages/connect/bin/helm.js up --port 8790 --host 127.0.0.1 --name home
```

Copy the real `~/.helm/profiles.json` and `secrets.env` into that `HELM_DIR`
so real accounts are selectable; put scratch repos under `~` so the folder
browser reaches them; open `http://127.0.0.1:8790/#pair=<password>` in
`chromium --headless=new --remote-debugging-port=<port>` and drive it with the
`ws` package (`Page.navigate`, `Runtime.evaluate` for clicks and text,
`Page.captureScreenshot`; `Emulation.setDeviceMetricsOverride` for a phone).
The password expires in ten minutes; a paired browser profile stays paired
across daemon restarts. Kill the daemon **by PID** — `pgrep -f` on its
arguments matches your own shell and kills the session (it happened again
today).

---

## A note on the review

A second model (Fable) reviews after Opus writes. It has been wrong before in
ways only running the code caught, and right in ways that saved the project.
Worth consulting, worth verifying. The recordings in `test/fixtures` exist so
that the next review argues from what the CLIs actually said.
