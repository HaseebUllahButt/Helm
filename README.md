# helm

Control the coding agents on all your computers from one app on your
phone.

Every Helm network belongs to its owner. You run it on your own always-on VM;
there is no Helm cloud account and no dependency on the person who made Helm.

```bash
curl -fsSL https://raw.githubusercontent.com/HaseebUllahButt/helm/main/install.sh | bash
helm setup
```

`helm setup` detects the VM's public IP, gives it a free address such as
`https://203-0-113-42.sslip.io`, configures Caddy HTTPS, installs Helm as a
background process, and prints one private pairing link. No website, domain
purchase, or DNS account is needed.

> The repository is not public yet, so the curl command will work after the
> first push. For the VM and HTTPS steps, follow [SETUP.md](SETUP.md).

## The idea

Coding agents often stop to ask a question. Helm lets you see the question and
answer it without returning to the computer running the agent.

The hierarchy is simple:

```text
computer → directory → session
```

Sessions show which computer, directory, CLI, and account they use. A blocked
session moves to the top.

## How it connects

Your VM is the **Helm home**. It has one stable HTTPS address and stays online.
Every other computer connects outward to it, so home routers need no port
forwarding.

```text
phone or browser ──▶ your VM ◀── laptop
                         ▲          laptop dialled out
                         └──────── another machine
```

The VM introduces a device to the computer it wants. Session traffic tries a
direct WebRTC connection first and falls back through the VM when direct
connection is unavailable.

The VM belongs to the user. Different users run different Helm homes and never
share a database, key, or account.

A network can have **more than one** always-on VM. Each advertises its own
HTTPS address; every computer dials all of them, and each device attaches to
whichever home currently reaches the most machines, failing over to another if
one goes down. Add a second home with `helm setup --join` (below).

## Adding things

`helm setup` makes this VM the home. After that, every command is named for
what you are adding:

```bash
helm add controller    a phone or browser: controls machines, runs nothing
helm add pc            a laptop or desktop: runs agents, and controls others
helm add vm            another always-on machine, dialled by the rest
```

Add a phone, browser, or computer from **Settings** on any paired device.
Computer invites contain one private join link with the secret already in it.
The terminal commands above produce the same invites. On the new computer:

```bash
helm join
# Paste: https://helm.example.com/#join=ABCD-1234
```

The code remembers which kind you asked for. A pc dials out to the home and
needs no address of its own; a vm additionally claims a free HTTPS address,
configures Caddy and starts serving, so the rest of the network can dial it
too. Controllers already paired need no new link; they simply gain a second
home to fall back on.

If you already own a domain, run `helm setup https://helm.your-domain.com`
after pointing it at the VM and configuring Caddy.

### The app on a machine

A computer that has joined does not need a pairing link to open the app — it
already holds the network key:

```bash
helm open
```

The curl installer starts Helm immediately. Joining replaces its temporary
local network and keeps Helm running in the background. The Linux application
launcher is installed automatically; opening it or `127.0.0.1:8787` signs in
without a pairing link. macOS runs Helm as a LaunchAgent at login.

Opening the network's website on the joined computer also inherits its local
membership and saves it at that website's origin, so installing the web app
keeps the sign-in. The browser may request local network access; allow it so
the website can talk to Helm on this computer. If access is blocked, `helm open`
opens the local app signed in.

The older `helm up`, `helm invite`, `helm link` and `helm login` commands
remain available for scripts and existing setups.

### Pair a phone

Run this anywhere that can reach the Helm home:

```bash
helm add controller
```

It prints a QR code and one private link such as:

```text
https://helm.example.com/#pair=abc123
```

Scan the code with the phone's camera, or open the link on the device you want
to use. **Settings → Devices → Pair another device** shows the same QR code in
the app, and the **Getting started** card on Home links straight to it. The link expires after ten minutes; the
paired device stays connected until removed.

### Add another computer

Create a computer invite from Settings on any paired phone, browser or app,
or run `helm add pc` on an existing computer. Install Helm on the new computer,
then run:

```bash
helm join
# Paste the private join link when prompted.
# Or: helm join 'https://helm.example.com/#join=ABCD-1234'
```

The join code is single-use and expires after ten minutes. `helm join` installs
Helm as a background service on that computer, so it stays in the network
after the terminal closes; pass `--foreground` to run it in the terminal instead.
There is no separate `helm up`, `helm leave`, or browser pairing step for a
fresh install. The old `helm join CODE https://home.example` format still works.

## Mobile PWA

Recently opened chats and their machine/thread lists are saved on the device.
Reopening paints that saved view before refreshing it; a disconnected view is
labelled as saved and catches up when the app resumes or a route recovers.
The device retains up to 25 event-log chats and 50 imported transcripts, with
a bounded in-memory cache for quick switching. Older uncached chats still
need a reachable machine, and browser storage eviction can remove saved data.

An installed PWA updates without reinstalling or clearing its pairing. Choose
Reload in the update notice to request the fresh app shell, even on a slow
network. Saved lists retain imported-chat metadata; the Done section identifies
saved lists until they can reconcile with the machines, so an offline count is
not presented as a fresh network-wide total.

Slow or stuck sockets reconnect automatically. Read-only chat snapshots can
also use authenticated HTTP when WebSockets are blocked, trying another known
hub when necessary. Prompts, approvals, and other actions require a live
transport and are never automatically replayed over the fallback.

Opening the app races a socket to the page's hub against HTTP discovery;
reconnecting races the last working hub instead. A slow discovery response
does not hold up a working socket, and an unreachable remembered hub does not
block alternatives. Hub upgrades open the replacement before retiring the
working connection; in-flight replies can finish on the old socket without
resending actions.

Idle recovery does not depend on receiving a browser online/close event: a
watchdog restarts abandoned attempts, and returning from sleep checks the
connection immediately. Project lists use the same safe read fallback as chat
snapshots; reconnecting refreshes the list and clears obsolete timeout errors.

Local hubs reuse their daemon's existing outbound links to reach machines
attached to another hub. Machine presence, session lists, chat reads, actions,
and subscribed events follow that route without making the browser open a new
connection to the public hub. Forwarding is one hop to a directly attached
machine, preserves the original caller, and never replays an uncertain action.
Disconnected links withdraw their routes; reconnecting restores routes and
subscriptions automatically. WebRTC introductions also cross this route, so
peers can still establish fast direct connections on the same Wi-Fi instead
of carrying terminal traffic through the public hub. Hub WebSockets compress
larger messages without shared compression history to reduce slow-link traffic.
Older hubs continue to work through direct attachments until updated.

While open, the browser also rechecks reachability every fifteen seconds and
moves to a hub that can reach more machines. A local hub saying a machine is
offline does not prevent safe chat reads from trying another hub. Direct
connections rebuild failed negotiations and discard stale signalling when
retrying after sleep or a network change.

On Android/Chrome: open the pairing link, pair, then choose **Install Helm
app**. The installed app keeps the pairing.

On iPhone or iPad the order matters, because the installed app gets its own
storage and does not inherit a pairing made in Safari: open the Helm address,
use **Share → Add to Home Screen** first, then open the installed app and
paste the pairing link (or type the code) there.

Installed to the home screen, the PWA is the app: same interface everywhere,
and a device stays paired until you remove it.

## The app

Open the app on any machine in the network and add it to your home screen or
dock; it installs as a PWA and stays paired until you remove the device. There
is no separate desktop build to keep in step - one app, one interface.

## How a session runs

Claude Code and Codex sessions run **headless**: helm starts the CLI in its
streaming mode (`claude -p` with stream-json, `codex app-server`) and turns
what it says into one stream of events - text as it is written, each tool
call and its result, every permission prompt with the choices the CLI
offered. OpenCode, OpenCode 2 and Devin use their ACP interfaces. The app
renders the same structured conversation for all five CLIs, including streamed
text, tool calls, permission prompts, models, modes, images and slash commands.
Stop interrupts the turn.

**How much the agent may do without asking** is a chip in the composer, next
to Send: `ask` · `edit` · `auto` · `yolo` for Claude Code, `ask` ·
`edit` · `yolo` · `read` for Codex. Tap it for the list with what each one
means. New sessions default to YOLO unless the account is configured otherwise;
plan mode is not supported. Shift+tab cycles the restricted modes from the
keyboard. Switching to a mode that removes
the guardrails takes two taps and then colours the chip and the box you type
in, so it is never a surprise. Changing it mid-conversation is real, not
cosmetic: Claude gets `set_permission_mode`, and every Codex turn carries the
approval policy *and* the sandbox.

Closing helm does not end a conversation: sessions resume on the next message
(`claude --resume`, `codex thread/resume`) under the same account.

Plain terminals, and agents you started at the keyboard, still run in
[herdr](https://herdr.dev) panes and show as a terminal.

### Conversations started outside Helm

Helm discovers saved conversations in the CLI accounts configured on each
connected machine. Live external CLIs appear in **Running**, including ones
waiting at their prompt, labelled **idle**. Opening a conversation reads its
live transcript without launching another agent or stopping the original.
Claude's local session registry identifies each terminal by its native session
ID, process ID and process start time, even when several terminals share a
folder and their transcripts are closed between writes. Codex uses its writer
lock or an open rollout file. Process ownership is checked on Linux (/proc)
and macOS (ps and lsof); other systems may only expose saved history.

A CLI that was already open before Helm shows **Open in a terminal** with a
**Take over** button. Taking over never cuts work off: at the prompt (or at a
permission question) it moves at once; mid-task it waits until the current
step - a command, an edit - has landed in the conversation. Helm then closes
that process, reopens the same conversation with the same command, settings,
account and folder in a terminal both sides share, and sends "continue" if it
was working. The app follows to the new thread, and the old window says
`claude -c` (or `codex resume --last`) there joins the same live terminal.

### One live session from terminal and app

Keep using `claude`, `codex`, and aliases such as `claudea` or `codexx`.
Recent Codex versions already use a shared local app-server daemon. Helm joins
its loaded local threads directly, preserving the same conversation, running
turn and pending approvals. Prompts and approval/question answers work in
Helm's chat interface and in Codex's terminal. Local desktop threads are covered
when that app uses the same reachable daemon and exposes direct input.

For Claude Code and the other supported terminal CLIs (Pi, OMP, Devin,
OpenCode 1/2, Grok, Cursor, Rovo, Antigravity CLI, Gemini, Kimi and Muse),
Helm puts a small launcher for each installed command in `~/.helm/bin` and
adds that folder to the front of PATH in your shell's startup file (bash, zsh
or fish). Nothing of the CLI's own is replaced: each launcher finds the real
command after itself on every run, so provider self-updates and reinstalls
need no repair. Open a new terminal after the first start. Interactive launches run the **unmodified
provider CLI** inside a persistent terminal, with the arguments, account
environment and working folder supplied by your shell. No provider login is added.

Sessions appear automatically in Helm. Only actively working sessions appear
in **Running**; idle sessions remain available in the recent list and on their
machine. Open one on any paired
device to type, choose options, answer questions and grant or deny permissions
through the same native CLI interface. The laptop and app are clients of one
process. Closing either view leaves it running; **End session** stops that
process, and one nobody is watching that has sat at its prompt for 30 minutes
ends on its own (its conversation stays in the CLI's history). The host
computer must stay awake and reachable. Whoever typed last sets the terminal's
size, so looking from a phone never shrinks the laptop's. An update to Helm's
terminal code starts a new terminal host for new CLIs; running ones stay in
the old host until they end.

These CLI paths use a native terminal, rather than Helm's structured chat forms.
Claude Desktop, cloud sessions, `claude --bg`, and CLIs called
by an explicit binary path outside the integrated command are not covered.
Noninteractive scripts, login/update commands, and Helm's own headless drivers
retain their provider path. `HELM_NATIVE_BYPASS=1` bypasses integration for one
command. `helm integrate --remove` removes the launchers and the PATH line and
keeps it off; `helm integrate` turns it back on. Commands replaced in place by
earlier Helm versions are restored automatically.

For Helm's structured chat interface, the optional managed terminal client
also remains available:

```bash
helm chat claude
helm chat codex --mode ask -- "Work on this project"
helm chat --attach <Helm-session-ID>
helm chat claude --resume <native-session-ID>
```

Use the exact account ID when you have several logins. Login stays in the
provider CLI; Helm adds no provider sign-in. `--resume` requires the original
CLI to be closed. The terminal client and paired web/mobile apps control one
backend process and the same native conversation, including messages, tool
permissions, structured questions and interruptions. Idle sessions leave
**Running** but remain available to continue. Ctrl+C or `/detach` disconnects this frontend without
stopping the agent; reconnect with the printed session ID. `/stop` interrupts
the turn. `/end` stops the agent and deletes its Helm thread.

At a permission prompt use `/allow`, `/always` (only when offered), or `/deny`,
optionally followed by the request ID. For questions use
`/answer <question number> <choice number or text>`; include the request ID
first if several requests are pending. Answer all questions in a request before
it is submitted. A response in the app resolves the same request in the terminal.

The headless adapters follow [T3 Code's managed provider design](https://github.com/pingdotgg/t3code):
its Codex adapter owns an app-server connection; its Claude adapter maintains a
streaming query and pending tool/question callbacks. Helm uses its existing
Codex app-server and unmodified Claude Code stream-json drivers for the same
control flow. It does not import T3's SDK, dependencies or authentication flow.
See [CodexAdapterV2](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)
and [ClaudeAdapterV2](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts).

The T3 comparison above describes this optional managed provider path. T3's
code is not evidence of universal attachment to arbitrary terminal or desktop
processes; the normal-command integration keeps the live terminal instead.

## Updates

Helm is yours to change: tell your agent to change it, and it does. Helm never
pulls from GitHub by itself. Every couple of minutes each machine checks:

- a new version **saved** (committed) in its own Helm checkout is built and
  started;
- a newer saved version on another of your machines is copied over your own
  Helm network and started.

Unsaved edits never spread, and a machine only ever moves forward from what it
has: if two machines both have their own changes, neither is overwritten, and
**Settings → Updates** says so. Open apps reload by themselves at a quiet
moment when a new version lands.

GitHub's version is a choice in **Settings → Updates**:

- **Let my agent update it** starts an agent on your newest machine that
  merges GitHub's version into yours, keeps your changes, runs the tests and
  saves the result. Your other machines follow.
- **Replace with GitHub's version** overrides your changes on every machine.
  They are kept on a `helm-backup-…` branch (and a stash, if unsaved).

`helm update --replace` is the same replacement from a terminal.

## CLI subagents

Open **Thread details → Agents** (or **Subagents** in the thread menu) to choose a CLI account, model,
permissions, and a bounded task. Tasks stay attached to that orchestrator
and do not appear as separate recent chats, search results, or provider-history
rows. Inspect replies, stop work, send follow-up messages, and answer any
explicitly configured approval prompts in the parent task panel.

The inline **Team** panel shows nested tasks, model, status, elapsed time,
and a short result. Child approvals and failures also surface on the parent
in the sidebar. Finished child tasks return a bounded result to their parent;
only tasks created with automatic result delivery enabled participate. Older
task history is not replayed into conversations when the daemon restarts.
**Stop all** stops descendants and clears pending messages. Late results from
stopped children do not restart the parent. Archiving hides a task without
stopping its process.

Helm-managed agents receive a short introduction to these tools on their next
ordinary message. Any local CLI with shell access can also use them directly
on a joined machine with the Helm daemon running:

```bash
helm agents --json
helm delegate claudea --model opus --wait --json -- "Review the security changes"
helm delegate-result <child-id> --wait --json
```

`helm agents` reports discovered accounts, sign-in status, and model IDs
without publishing credentials or launcher environments. Use `--refresh`
after logging in or installing a CLI. Unknown sign-in state is shown as
unverified; a signed-out account cannot be delegated to. Use an exact account
ID when more than one profile uses the same CLI.

It also reports potential credential sources: file locations, environment
variable names, and available account/expiry metadata, never token values.
These diagnostics honor profile overrides, saved secret references, and
explicit unsets. An expired access token may still be refreshable; the CLI's
sign-in status remains authoritative. Wrapper-managed credential files and
OS keychains are not inspected.

Inside a Helm session, `helm delegate` automatically links the task to that
session and uses its folder. From an ordinary terminal or native Codex CLI,
it uses the current folder; `--cwd <folder>` chooses another. `--model` selects
the child's model through its own CLI, so Codex can ask Claude Opus for work
using an existing Claude login. The supplied task is the child's context;
the parent conversation is not copied automatically. Children share the
folder, so assign distinct work when delegating edits.

Helm adds a short, stable delegation instruction, not an account roster or a
copy of its manual. Accounts and models are discovered with `helm agents --json`
only when needed. Codex and Claude receive it as standing instructions; other
adapters introduce it once, not on every message. Helm-managed Codex threads
disable `features.multi_agent` and `features.multi_agent_v2`; Claude launches
deny the native `Agent` and legacy `Task` tools. These use the provider's
[Codex feature configuration](https://developers.openai.com/codex/config-reference)
and [Claude tool restrictions](https://code.claude.com/docs/en/cli-reference).
Other adapters currently rely on the instruction, not a verified tool block.
Existing processes preserved across an update keep their prior configuration
until a fresh provider launch or Codex thread resume; Helm does not interrupt
active work to apply this policy. Externally monitored sessions are not
reconfigured. This routes ordinary delegation, not a security boundary against
an agent launching a separate CLI through its shell.

Children default to YOLO execution; `--mode` and
`--effort` select supported settings. A read-only parent requires a read-only
child; account defaults and explicit permission choices remain configurable.
Plan mode is not offered: dispatch tasks directly instead of waiting for plan
approval. Up to four children
can run at once, with at most three levels of nesting.
CLIs without a permission picker use their own configured permission policy.

`--wait` returns the reply when finished, or returns immediately when the
child needs approval. Read it again after answering in Helm. The default
wait limit is five minutes; `--timeout <milliseconds>` changes it. Timing
out stops waiting while the child continues. Exit codes are 0 for success,
1 for failure or interruption, 2 for a pending approval, and 3 for a wait
timeout. JSON includes the full child ID and its status; replies are bounded
to the last 32,000 characters. Open the thread for the full conversation.

### Thread controls

**Thread details** groups machine, folder, account, model, permissions, Git
changes, agents, schedules, and task transfer in one panel. It opens as a
side panel on desktop and a bottom sheet on phones.

There is no message-delivery selector. Native terminal sessions pass input
straight to the CLI, retaining that CLI's own queue and interruption behavior.
Managed Claude and Codex chats hand follow-up input to the running turn at a
tool boundary; adapters without steering queue it until the turn finishes.
Queued messages can be edited, reordered,
removed, or withdrawn into the composer until delivery starts. Edits, order,
attachments, and attached context survive a daemon restart. Delivery already
accepted by a CLI is not automatically replayed.

Type **@** to attach up to three other threads from the same machine. Helm
snapshots bounded text excerpts, not their entire histories or attachments.
These excerpts are sent to the account/model of the receiving conversation.
Recovery banners distinguish failures, usage limits, stops, and restarts;
**Resume task** releases held messages or asks the agent to continue from its
saved conversation. Usage-limit failures pause queued work instead of retrying
automatically.

### Scheduled tasks

In **Thread details → Schedules**, create an interval task (minimum five
minutes), pause/resume it, edit it, run it now, or delete it. It runs in the
selected thread on its machine, using that thread's current account, model,
folder, and permissions. Results appear in the same conversation. These are
normal agent turns and consume provider usage; only schedule trusted tasks.

Schedules persist in `~/.helm/schedules.json`. The machine's daemon must be
running. Busy, stopped, archived, and attention-needed threads do not receive
scheduled work. Missed intervals coalesce into one run, not a catch-up burst;
dispatch failures pause the schedule. The displayed times use your browser's
local time zone. Interval tasks are not calendar/cron schedules.

Cache keepalive is deferred: this release installs no warmer, sends no
background cache pings, and exposes no keepalive toggle. Providers' native
prompt caching remains unchanged. The sidebar search has no shortcut badge;
Ctrl/Cmd+K and `/` still open search.

The open thread is highlighted in Running and Done. Done is a rolling list of
threads with replies that are not running or needing attention, updated within
the last three days; it is not a count of successful tasks. Its count can change
as threads resume, age out, or sync from another machine. In the model picker,
stars only favorite choices. **Set default** separately controls new chats;
neither action changes the model of the current conversation.

## Brains (optional)

Sessions are the main way to use helm: open a machine, pick a folder, start an
agent and drive it. A brain is an extra thread beside that, for the questions
that are not about one folder.

```bash
helm brain --account claudea            # here, or --on <machine>
```

Each machine can have one, and the app lists them under **brains** - a row per
machine, so a machine without one says so and one tap starts it. A brain sees
every machine and every running session, and acts on them through the `helm`
command in its own shell - so it can answer "what is waiting on me", read a
thread on another machine, or start one. It runs on its own machine, which is
why the one on the always-on machine is the one still there when your laptop
is not. It is an ordinary session, so the model picker in the composer is how
you change which model it thinks with, and the permission mode is how much it
may do without asking.

The same verbs work from any terminal in the network:

```bash
helm digest                       every machine, folder and running session
helm thread <id>                  one conversation
helm say <id> "<text>"            prompt an existing session
helm spawn <machine> <folder> <account> "<text>"
helm dispatch <machine> --account <target-profile> "<task>"
helm dispatch-status <id>         where a queued handoff stands
helm send-task <machine> --account <target-profile> "<task>"
helm receive <machine> [minutes]  grant this machine one folder from it
helm send <machine> [folder] --grant <token>
```

`helm digest` keeps the last answer from every machine, so one that is asleep
is listed with when it was last seen rather than left out.

**Send task** is available in a managed conversation's header. Completion
notification settings live in its **⋯** menu. Sending pauses the
source agent, copies the project and recent conversation, and starts a
continuation using an agent account on the destination. In **Send a project**,
enable **Send a task with this project** to start a new task instead.
Choose **Send task to another machine**, pick the machine, and send. Project
`.env` files are included automatically and written with `0600` permissions;
there is no environment checkbox in the task UI. Files and task context are
encrypted to the destination and signed by the source. No GitHub checkout,
fetch or Git history restoration is performed for this flow.

After a successful completed turn (with no outstanding questions or delegated
work), changes return automatically when the original machine is online.
Reconnection triggers a check; Helm also checks every 30 seconds. A running
original thread is never overwritten: return waits until it is idle.
Private Git checkpoints identify changed files and deletions, so unchanged
files are not uploaded again. Git must be installed on both machines; a Git
repository or GitHub account is not required. Checkpoints live in Helm's
private storage, not your project history, and may contain project secrets.
Nothing is committed or pushed to your project's Git remote by a task transfer.

Non-overlapping local edits are preserved. Overlapping changes pause the return
with a **Returned changes need review** banner and a separate complete returned
copy. Resolve the files and recheck, or choose **Keep my conflicting edits**.
The original conversation receives the result and continuation context; the
destination thread becomes read-only once its return snapshot is sealed.

Task and project transfers try a direct WebRTC data channel with
bounded send buffering, using a hub for signalling. If a direct connection
cannot be established, the same encrypted request travels through the hub.
If task delivery loses connectivity, an independent machine's hub can store
the encrypted request for later delivery; the laptop's own hub alone is not
enough. A **Running** receipt means the destination has started a session and
accepted its first prompt, so the source laptop can close. It does not mean
dependency setup or the task itself has finished.

`helm send-task` uses the current folder and, inside a managed session, its
conversation. Use `--source-folder`, `--target-folder`, `--session`, `--model`
or `--mode` to choose explicitly, `--no-env` to exclude project environment
files, and `--allow-skipped` after reviewing any omitted sensitive files or
symlinks. The command prints a handoff ID before sending; retry with the same
arguments and `--handoff-id <id>` to reuse the saved snapshot without starting
another session. Source and destination both need this Helm version.

This is a project snapshot plus a bounded conversation continuation, not a
live process migration. The destination agent is instructed to recreate
dependencies from project instructions, manifests and lockfiles. Provider
logins, machine-wide environment variables, services, virtual environments
and generated dependencies stay on the source. Required runtimes and agent
authentication must be available on the destination. Snapshot limits remain
32 MiB total, 16 MiB per file and 20,000 files; larger directory copies use
`helm copy`.

`helm dispatch` runs from any joined machine - inside a session or from a
plain shell. It packs the current folder, encrypts it to the target's own
key and queues it on every reachable home, so a machine that is offline
picks the work up the next time it connects; `dispatch-status` asks the same
question later. Retries are idempotent: the same handoff resumes its steps
rather than repeating them, and provider credentials stay on the machine the
work runs on. Source and target must both run this protocol version - the
envelope compression, request signing and queue frames are a wire change -
so update homes and targets first, then sources.

`helm receive` and `helm send` move one folder while both machines are
online - no queue, no session. `receive` mints a single-use grant, signed
by the target machine and bound to the named source, its one-time key and
a few minutes of life; `send` checks that signature against the roster,
seals the folder to the key inside, and the signed request itself is what
authorizes the write on the target.
`--include-env` carries `.env` files explicitly - they land owner-only
(`0600`) - and `--target-folder` chooses where it lands.

## What it costs

Every agent CLI records its own token usage next to its transcripts, and that
record is the complete one: it covers sessions helm never started, and it
survives helm's own event log being trimmed. **Usage** in the sidebar reads
those and adds them up - across every machine, or one machine on its own from
the meter beside its settings.

```text
$1.1k        API-equivalent, 7 days · 3.0B tokens · 19,857 turns
97.7%        of input served from cache — saved $7.6k
```

The prompt-cache figure is the one worth watching. A cached input token bills
at a fraction of a fresh one, so on agent sessions - where the same context is
resent every turn - the hit rate is most of the difference between the bill and
what it could have been. It is reported after the cache-write premium, because
writing the cache is billed above the fresh rate.

Break the spend down by **model**, **CLI**, **provider** or **folder**; the
folder view is usually the one that answers "where did the month go".

Two things the numbers are careful about. Costs are published rates × real
tokens, which on a subscription is not what you paid - it is what the same work
would have cost on the API, and the screen says `API-equivalent` rather than
"spent". A model with no published rate is counted in tokens and reported
`unpriced`, never costed at zero. And a machine that does not answer is not
zero: the footer says how many of your machines reported, the same way `helm
digest` lists a sleeping machine with when it was last seen rather than leaving
it out.

Reading is incremental. The first pass on a machine with a long history reads
every transcript its CLIs ever wrote; after that only the bytes a session
appended are read, and the index survives a daemon restart. On a machine with
1.8GB of Codex rollouts that is 7.6s once, then about 25ms.

## Profiles and secrets

Helm reads shell aliases and functions and turns them into profiles. This makes
different Codex, Claude, OpenCode, OpenCode 2 and Devin accounts selectable per
session.

Profiles reference secret locations; they do not upload provider credentials.
Agents and credentials stay on the computer where the work runs.

## Security model

- Every user owns a separate Helm home.
- Pairing links last a few minutes.
- Joined devices remain until explicitly removed. Removal also closes the
  device's live connections, not just its next sign-in.
- Machine invites are single-use.
- The network key stays in files readable only by the local user.
- Provider credentials never go to the VM unless the agent itself runs there.
- Queued code is encrypted to the target machine; the task text and settings
  ride readable through your own home, the same as a live call.
- A `helm send` transfer is end-to-end encrypted to a one-time key the
  target issued inside a signed, single-use, short-lived grant bound to
  the named source machine as well as the target; `.env`
  files move only when the sender passes `--include-env` and land `0600`.
- What a handoff leaves behind is decided by filename - a conservative
  filter, not a promise that nothing sensitive is inside the code itself.
- Only HTTPS should be exposed publicly; port `8787` stays behind Caddy.

The current design is for one trusted owner per Helm home. Do not put unrelated
users into the same network.

## Project layout

| | |
|---|---|
| `packages/protocol` | membership, credentials, and wire messages |
| `packages/connect` | daemon, CLI, profiles, SSH, brains, and local runtime |
| `apps/relay` | the VM home and connection relay |
| `packages/usage` | what each CLI recorded spending, priced and rolled up |
| `apps/web` | the mobile PWA and shared interface |

## Development

Requirements: Node 22+ and
[herdr](https://herdr.dev) for terminals. Claude Code 2.1.260+ and
codex-cli 0.154+ on any machine that runs agents (`packages/connect/src/drivers`
is written against those; older CLIs get a warning at start).

```bash
npm install
npm run check
```

`npm run check` type-checks and builds the web app, then runs the CLI and
network regression tests.

Browser regressions cover Markdown safety, dialog focus, the command palette,
CLI subagents, thread details, queue controls, references, and schedules:

```bash
npm exec --workspace @helm/web -- playwright install chromium
npm run test:browser
```

To use an installed Chromium instead, run
`HELM_TEST_CHROMIUM=/usr/bin/chromium npm run test:browser`.
These checks use isolated fixtures and do not connect to your Helm network.

### Large folder copies

`helm copy` streams a complete directory over SSH, using a reachable direct
address once the machine's SSH host key has been pinned. Otherwise it uses the
Helm hub. Both computers need `rsync` and an accessible SSH server; this command
does not install or enable system services.

```sh
helm copy why ./my-project --target-folder /home/haseeb/dev/my-project --dry-run
helm copy why ./my-project --target-folder /home/haseeb/dev/my-project --exclude node_modules --exclude .cache
```

Unlike the filtered, size-limited code handoff, this copies hidden files and Git
history too. Existing matching files can be replaced; unrelated destination
files are not deleted. Use `--exclude .env` when environment files should stay
here. Rerun the same command after interruption: completed files are skipped and
partial files are reused. Compression streams in memory, without writing an
archive on either disk. Filesystem permissions, symlinks and timestamps are
preserved; source files are retained.

Updated SSH tunnels negotiate a 512 KiB window per direction. The receiver
acknowledges data after writing it, so a fast sender cannot grow an unlimited
hub queue while a destination is slow. Old peers remain compatible through the
legacy tunnel path; update both ends and the hub to get flow control. A running
SSH connection is never silently replayed on a different route after failure.

Helm's safe updater waits for active transfers before restarting the sender,
receiver or relay. Runtime activity markers expire after a crash, so an
abandoned transfer cannot block updates indefinitely. Incoming data and credit
frames count as liveness; a delayed pong alone does not end a busy transfer.
