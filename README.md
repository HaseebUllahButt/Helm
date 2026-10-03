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

It prints one private link such as:

```text
https://helm.example.com/#pair=abc123
```

Open it on the device you want to use. The link expires after ten minutes; the
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

## CLI subagents

Open **Subagents** inside a conversation to choose a CLI account, model,
permissions, and a bounded task. Tasks stay attached to that orchestrator
and do not appear as separate recent chats, search results, or provider-history
rows. Inspect replies, stop work, send follow-up messages, and answer any
explicitly configured approval prompts in the parent task panel.

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
helm receive <machine> [minutes]  grant this machine one folder from it
helm send <machine> [folder] --grant <token>
```

`helm digest` keeps the last answer from every machine, so one that is asleep
is listed with when it was last seen rather than left out.

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

Browser regressions for Markdown safety, dialog focus, the command palette,
and CLI subagent controls:

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
