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

```text
computer → directory → session
```

Sessions show which computer, directory, CLI, and account they use. A blocked
session moves to the top.

More in [docs/](docs/): the shared [browser](docs/browser-use.md),
[Edit from here](docs/rewind.md) and [visual replies](docs/visual-replies.md),
plus [why Helm is built this way](docs/intent.md).

## How it connects

Your VM is the **Helm home**. It has one stable HTTPS address and stays online.
Every other computer connects outward to it, so home routers need no port
forwarding.

```text
phone or browser ──▶ your VM ◀── laptop
                         ▲          laptop dialled out
                         └──────── another machine
```

Different users run different Helm homes and never share a database, key, or
account. A network can have **more than one** always-on VM; every computer
dials all of them, and devices fail over if one goes down.

## Adding things

`helm setup` makes this VM the home. After that, every command is named for
what you are adding:

```bash
helm add controller    a phone or browser: controls machines, runs nothing
helm add pc            a laptop or desktop: runs agents, and controls others
helm add vm            another always-on machine, dialled by the rest
```

**Settings** on any paired device makes the same invites. On the new computer:

```bash
helm join
# Paste: https://helm.example.com/#join=ABCD-1234
```

The link remembers which kind you asked for. A pc dials out and needs no
address of its own; a vm also claims a free HTTPS address and configures Caddy.
Join links are single-use and expire after ten minutes. `helm join` installs
Helm as a background service; pass `--foreground` to run it in the terminal
instead. The old `helm join CODE https://home.example` format still works.

If you already own a domain, run `helm setup https://helm.your-domain.com`
after pointing it at the VM and configuring Caddy.

On a computer that has joined, `helm open` (or `127.0.0.1:8787`, or the Linux
app launcher) opens the app signed in with no link. macOS runs Helm as a
LaunchAgent at login. If the browser asks for local network access, allow it.

The older `helm up`, `helm invite`, `helm link` and `helm login` commands
remain available for scripts and existing setups.

### Pair a phone

```bash
helm add controller
```

It prints a QR code and one private link such as
`https://helm.example.com/#pair=abc123`. Scan it or open it on the phone.
**Settings → Devices → Pair another device** shows the same code in the app.
The link expires after ten minutes; the paired device stays until removed.

- **Android/Chrome:** open the link, pair, then choose **Install Helm app**.
- **iPhone/iPad:** the order matters, because the installed app does not share
  Safari's storage. Open the Helm address, use **Share → Add to Home Screen**
  first, then open the installed app and paste the pairing link there.

Prompts and approvals need a live connection and are never replayed
automatically.

## How a session runs

Claude Code and Codex chats started in Helm run **headless** (`claude -p`
with stream-json, `codex app-server`); OpenCode, OpenCode 2 and Devin use ACP.
Closing Helm does not end a conversation; it resumes on the next message under
the same account.

**How much the agent may do without asking** is a chip next to Send:
`ask` · `edit` · `auto` · `yolo` for Claude Code, `ask` · `edit` · `yolo` ·
`read` for Codex. New sessions default to YOLO unless the account is
configured otherwise; plan mode is not supported. A change mid-conversation
really changes what the agent may do.

Plain terminals, and agents started at the keyboard, run in
[herdr](https://herdr.dev) panes and show as a terminal.

### Conversations started outside Helm

Live external CLIs appear in **Running**. Opening one reads its transcript
without starting another agent or stopping it. This works on Linux and macOS;
other systems may show only saved history.

A CLI open before Helm started shows **Take over**. It never cuts work off: at
the prompt it moves at once; mid-task it waits until the current step has
landed. Helm then closes that process and reopens the same conversation in a
terminal both sides share. In the old window, `claude -c` (or
`codex resume --last`) joins the same live terminal.

### One live session from terminal and app

Keep using `claude`, `codex`, and aliases such as `claudea`. Recent Codex
versions share a local app-server, and Helm joins its threads directly.

For Claude Code and the other terminal CLIs (Pi, OMP, Devin, OpenCode 1/2,
Grok, Cursor, Antigravity CLI, Gemini, Kimi and Muse), Helm puts a small
launcher for each in `~/.helm/bin` and adds that folder to the front of PATH in
your shell's startup file. Nothing of the CLI's own is replaced: each launcher
finds the real command after itself, so provider updates need no repair. Open a
new terminal after the first start. No provider login is added.

The laptop and app share one process. Closing either view leaves it running;
**End session** stops it. An unwatched session idle at its prompt for 30
minutes ends by itself; its conversation stays in the CLI's history.

Not covered: Claude Desktop, cloud sessions, `claude --bg`, CLIs called by an
explicit binary path, and noninteractive scripts.

```bash
HELM_NATIVE_BYPASS=1 claude    # skip Helm for one command
helm integrate --remove        # remove the launchers and PATH line
helm integrate                 # turn it back on
```

For Helm's structured chat in a terminal:

```bash
helm chat claude
helm chat codex --mode ask -- "Work on this project"
helm chat --attach <Helm-session-ID>
helm chat claude --resume <native-session-ID>
```

`--resume` needs the original CLI to be closed. Ctrl+C or `/detach` leaves the
agent running; `/stop` interrupts the turn; `/end` stops the agent and deletes
its Helm thread. At a permission prompt use `/allow`, `/always` or `/deny`. For
questions use `/answer <question number> <choice number or text>`.

## Updates

Helm is yours to change: tell your agent to change it. Each machine checks
every couple of minutes, and on start and reconnect, and starts a newer
version when it finds one:

- a new version **saved** (committed) in its own Helm checkout;
- a new release pushed to GitHub;
- a newer saved version on another of your machines.

Unsaved edits never spread, and a machine only moves forward. If two machines
both have their own changes, neither is overwritten; an update notice links to
**Settings → Updates** with the reason. There you choose:

- **Let my agent update it** starts an agent that merges GitHub's version into
  yours, keeps your changes, runs the tests and saves the result.
- **Replace with GitHub's version** overrides your changes on every machine.
  They are kept on a `helm-backup-…` branch (and a stash, if unsaved).
  `helm update --replace` does the same from a terminal.

## Threads

A message sent while the agent works waits, and says when its CLI will read
it. **Send now** pushes it in at once; on CLIs that cannot take a message
mid-turn it stops only the current response. Waiting messages can be edited,
reordered or removed until delivery starts. Type **@** to attach short excerpts
of up to three other threads; the excerpts go to this conversation's
account/model.

**Done** lists recent threads that are not running or waiting on you. It is
not a count of successful tasks.

### Scheduled tasks

In **Thread details → Schedules**, run a prompt on an interval (five-minute
minimum), at a fixed time, or from a webhook. A task can reuse the thread or
start a fresh thread each run. Busy, stopped or archived threads never get
scheduled work. Automation does not bypass permissions, and every run uses
provider usage: only schedule trusted tasks.

Webhooks get a secret POST URL; the machine and home must be online. Optional
HMAC uses `X-Hub-Signature-256`. Prompts can use `{{body}}`, `{{body.field}}`,
`{{query.field}}` and `{{headers.name}}`. **Payloads are untrusted input**: the
template decides what the agent sees.

Schedules, including webhook secrets, are saved in `~/.helm/schedules.json`
(mode 0600).

**Continue automatically when this account's usage limit resets** is opt-in
per thread. Helm resumes once at the provider's reset time, with no browser
open. An unknown or unclear reset time never starts a retry loop.

Test this area with `helm run -- npm run test:automation`. It uses temporary
Helm state, fake providers and temporary repos.

### GitHub pull requests, checks and deployments

**Git → CI / CD** shows PRs, checks, workflow runs and deployments, and can
comment, review, merge, commit and push. A passing workflow is not treated as
proof that a deploy worked. Push never forces history.

Helm uses the GitHub CLI logins on the project's machine: run `gh auth login`
there for each account. `GH_TOKEN` or `GITHUB_TOKEN` also work. Tokens stay on
that machine and are never sent to the app or saved by Helm.

**Notify this thread** keeps watching with the app closed. **Wake the agent on
GitHub changes** is a separate opt-in that wakes an idle thread when checks
finish, reviews change or conflicts appear; the default is five wakes per UTC
day. Wakes never skip an approval, a stop or a usage-limit card. GitHub text is
untrusted context for the agent.

## CLI subagents

Open **Thread details → Agents** to give a task to another CLI account and
model. Tasks stay attached to the parent thread; follow them, stop them, and
answer their approvals there. Subagents that Claude Code starts itself appear
as **native** and are read-only.

Any CLI with shell access on a joined machine can use them directly:

```bash
helm agents --json
helm delegate claudea --model opus --wait --json -- "Review the security changes"
helm delegate-result <child-id> --wait --json
```

`helm agents` lists accounts, sign-in status and model IDs, never secret
values; use `--refresh` after a new login. `--model` picks the child's model
through its own CLI, so Codex can ask Claude Opus with an existing login.

The task text is all the child knows; the parent conversation is not copied.
Children share the folder (or `--cwd <folder>`), so give them distinct work.
Children default to YOLO; a read-only parent needs a read-only child.

`--wait` returns when the child is done, or at once if it needs approval. Exit
codes: 0 success, 1 failure, 2 approval pending, 3 wait timeout (the child
keeps working).

Helm-managed Codex and Claude threads have their own built-in subagents turned
off, so delegation goes through Helm. This is routing, not a security
boundary: an agent can still start a CLI through its shell.

### Remote commands

```sh
helm exec Laptop --cwd /home/haseeb/dev/project -- npm run check
helm exec VM -- sh -lc 'uptime; free -h'
helm exec VM --env SERVICE_NAME=example -- printenv SERVICE_NAME
helm exec-status VM <command-id> --wait --json
helm exec-cancel VM <command-id>
```

`helm exec` runs over Helm's own connection, not SSH. Arguments stay separate;
use `sh -lc` for pipelines. Your local environment is never copied; pass
`--env NAME=value`. `--cwd` takes an absolute path on the target. Default
timeout is 15 minutes; a timeout exits 124.

**If a start was not confirmed, do not rerun it.** The CLI prints the command
id; read it with `exec-status` or stop it with `exec-cancel`. `--heavy` is
accepted and does nothing.

## Helm brain

One persistent conversation for the whole network, hosted on the always-on VM:

```bash
helm brain --account claudea
```

An offline VM stays the brain's home; Helm never moves it to a laptop. Without
a VM, pick one with `helm redesignate <machine> vm`. Tell it "go to why, then
this folder, do this." It keeps a network map in `~/.helm/snapshot.json` and
owner-confirmed notes in `~/.helm/brain/KNOWLEDGE.md`.

The same verbs work from any terminal:

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

`helm digest` lists a sleeping machine with when it was last seen.

### Sending a task to another machine

**Send task** (in a thread's header) pauses the agent, copies the project and
recent conversation, and continues on the other machine. When the task
finishes, the changes come back to the original machine once it is online and
idle. Your own edits are kept; overlapping edits stop with **Returned changes
need review**. Nothing is committed or pushed to your project's Git remote.

Things that surprise people:

- Project `.env` files **are included** automatically (written `0600`). Use
  `helm send-task --no-env` to leave them out.
- Git must be installed on both machines. Helm keeps private checkpoints
  outside your project history; they may contain project secrets.
- It is a snapshot, not a live move. Logins, services, virtual environments
  and installed dependencies stay behind. The other agent rebuilds
  dependencies.
- Limits: 32 MiB total, 16 MiB per file, 20,000 files. Use `helm copy` for
  bigger folders.
- Retry with the same arguments and `--handoff-id <id>` to reuse the saved
  snapshot without starting another session.

`helm dispatch` queues work for a machine that may be offline; it picks it up
when it connects. Update homes and targets before sources, because the queue
format changed.

`helm receive` and `helm send` move one folder while both machines are online.
`.env` files move only with `--include-env`.

### Large folder copies

```sh
helm copy why ./my-project
helm copy why ./my-project --target-folder ~/dev/my-project --exclude node_modules --exclude .cache
```

Both computers need `rsync` 3.2.3 or newer. Without `--target-folder`, files
land in the same place on the other machine (under its home if they were
under yours). This copies hidden files and Git history too, and can replace
matching files; unrelated files are not deleted. Use `--exclude .env` to keep
environment files here. Rerun after an interruption to continue. `--ssh` uses
the older SSH path.

## What it costs

**Usage** in the sidebar adds up the token records each CLI keeps on every
machine, including sessions Helm never started.

Costs are published rates × real tokens. On a subscription that is not what
you paid, so the screen says `API-equivalent`. A model with no published rate
shows `unpriced`, never zero. A machine that does not answer is not counted as
zero: the footer says how many machines reported.

## Profiles and secrets

Helm reads shell aliases and functions and turns them into profiles, so
different Codex, Claude, OpenCode and Devin accounts can be chosen per session.
Profiles point at secret locations; they do not upload credentials. Agents and
credentials stay on the computer where the work runs.

## Security model

- Every user owns a separate Helm home.
- Pairing links last a few minutes. Machine invites are single-use.
- Joined devices remain until removed. Removal also closes their live
  connections.
- The network key stays in files readable only by the local user. Never copy
  `~/.helm/network.json`.
- Provider credentials never go to the VM unless the agent itself runs there.
- Queued code is encrypted to the target machine; the task text and settings
  pass readable through your own home, the same as a live call.
- A `helm send` transfer is end-to-end encrypted to a one-time key in a
  signed, single-use, short-lived grant from the target.
- What a handoff leaves behind is decided by filename. It is a careful filter,
  not a promise that nothing secret is inside the code.
- Only HTTPS should be public; port `8787` stays behind Caddy.

The design is for one trusted owner per Helm home. Do not put unrelated users
into the same network.

## Development

Requirements: Node 22+ and [herdr](https://herdr.dev) for terminals. Claude
Code 2.1.260+ and codex-cli 0.154+ on machines that run agents (older CLIs get
a warning).

```bash
npm install
npm run check
```

`npm run check` type-checks, builds the web app, and runs only the tests your
changes can reach (`--list` shows which and why). `npm run check:full` runs
every test.

```bash
npm exec --workspace @helm/web -- playwright install chromium
npm run test:browser
```

To use an installed Chromium, run
`HELM_TEST_CHROMIUM=/usr/bin/chromium npm run test:browser`. These checks use
isolated fixtures and do not connect to your Helm network.

### Claude account compaction policy

Apply the owner's Claude 5.5 thresholds separately on each machine:

```sh
node scripts/configure-claude-compaction.mjs ~/.claude-personal
```

It keeps existing settings and writes a backup first. It sets auto-compaction
at 350k tokens for Opus 5.5, 250k for Sonnet 5.5 and 99k for Haiku 5.5
(verified with Claude Code 2.1.295). Accounts that share a config directory
share the policy.
