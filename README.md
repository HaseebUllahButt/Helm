# con

Control the coding agents on all your computers from one app on your
phone.

Every Con network belongs to its owner. You run it on your own always-on VM;
there is no Con cloud account and no dependency on the person who made Con.

```bash
curl -fsSL https://raw.githubusercontent.com/HaseebUllahButt/helm/main/install.sh | bash
con setup
```

`con setup` detects the VM's public IP, gives it a free address such as
`https://203-0-113-42.sslip.io`, configures Caddy HTTPS, installs Con as a
background process, and prints one private pairing link. No website, domain
purchase, or DNS account is needed.

> The repository is not public yet, so the curl command will work after the
> first push. For the VM and HTTPS steps, follow [SETUP.md](SETUP.md).

## The idea

Coding agents often stop to ask a question. Con lets you see the question and
answer it without returning to the computer running the agent.

The hierarchy is simple:

```text
computer → directory → session
```

Sessions show which computer, directory, CLI, and account they use. A blocked
session moves to the top.

## How it connects

Your VM is the **Con home**. It has one stable HTTPS address and stays online.
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

The VM belongs to the user. Different users run different Con homes and never
share a database, key, or account.

A network can have **more than one** always-on VM. Each advertises its own
HTTPS address; every computer dials all of them, and each device attaches to
whichever home currently reaches the most machines, failing over to another if
one goes down. Add a second home with `con setup --join` (below).

## Adding things

`con setup` makes this VM the home. After that, every command is named for
what you are adding:

```bash
con add controller    a phone or browser: controls machines, runs nothing
con add pc            a laptop or desktop: runs agents, and controls others
con add vm            another always-on machine, dialled by the rest
```

Only `con add controller` prints a **link to open**. The other two print a
**code to type**, and what you type on the machine being added is always the
same command, whichever kind it is:

```bash
con join ABCD-1234 https://con.example.com
```

The code remembers which kind you asked for. A pc dials out to the home and
needs no address of its own; a vm additionally claims a free HTTPS address,
configures Caddy and starts serving, so the rest of the network can dial it
too. Controllers already paired need no new link; they simply gain a second
home to fall back on.

If you already own a domain, run `con setup https://con.your-domain.com`
after pointing it at the VM and configuring Caddy.

### The app on a machine

A computer that has joined does not need a pairing link to open the app — it
already holds the network key:

```bash
con open
```

That opens the app on `127.0.0.1`, signed in, showing every machine in the
network. This is how a laptop drives the VM.

The older `con up`, `con invite`, `con link` and `con login` commands
remain available for scripts and existing setups.

### Pair a phone

Run this anywhere that can reach the Con home:

```bash
con add controller
```

It prints one private link such as:

```text
https://con.example.com/#pair=abc123
```

Open it on the device you want to use. The link expires after ten minutes; the
paired device stays connected until removed.

### Add another computer

Install Con on the new computer. Then run `con add` on an existing one and
copy the command it prints:

```bash
con join ABCD-1234 https://con.example.com
```

The join code is single-use and expires after ten minutes. `con join` installs
Con as a background service on that computer, so it stays in the network
after the terminal closes; pass `--foreground` to run it in the terminal instead.

## Mobile PWA

On Android/Chrome: open the pairing link, pair, then choose **Install Con
app**. The installed app keeps the pairing.

On iPhone or iPad the order matters, because the installed app gets its own
storage and does not inherit a pairing made in Safari: open the Con address,
use **Share → Add to Home Screen** first, then open the installed app and
paste the pairing link (or type the code) there.

Installed to the home screen, the PWA is the app: same interface everywhere,
and a device stays paired until you remove it.

## The app

Open the app on any machine in the network and add it to your home screen or
dock; it installs as a PWA and stays paired until you remove the device. There
is no separate desktop build to keep in step - one app, one interface.

## How a session runs

Claude Code and Codex sessions run **headless**: con starts the CLI in its
streaming mode (`claude -p` with stream-json, `codex app-server`) and turns
what it says into one stream of events - text as it is written, each tool
call and its result, every permission prompt with the choices the CLI
offered. OpenCode and Devin are detected and started through the terminal
runtime. The app renders the agent screen, and the phone can watch and send
messages to all four CLIs. Stop interrupts the turn.

**How much the agent may do without asking** is a chip in the composer, next
to Send: `ask` · `edit` · `plan` · `auto` · `yolo` for Claude Code, `ask` ·
`edit` · `yolo` · `read` for Codex. Tap it for the list with what each one
means; shift+tab cycles the safe ones from the keyboard. A mode that removes
the guardrails takes two taps and then colours the chip and the box you type
in, so it is never a surprise. Changing it mid-conversation is real, not
cosmetic: Claude gets `set_permission_mode`, and every Codex turn carries the
approval policy *and* the sandbox.

Closing con does not end a conversation: sessions resume on the next message
(`claude --resume`, `codex thread/resume`) under the same account.

Plain terminals, and agents you started at the keyboard, still run in
[herdr](https://herdr.dev) panes and show as a terminal.

## Brains (optional)

Sessions are the main way to use con: open a machine, pick a folder, start an
agent and drive it. A brain is an extra thread beside that, for the questions
that are not about one folder.

```bash
con brain --account claudea            # here, or --on <machine>
```

Each machine can have one, and the app lists them under **brains** - a row per
machine, so a machine without one says so and one tap starts it. A brain sees
every machine and every running session, and acts on them through the `con`
command in its own shell - so it can answer "what is waiting on me", read a
thread on another machine, or start one. It runs on its own machine, which is
why the one on the always-on machine is the one still there when your laptop
is not. It is an ordinary session, so the model picker in the composer is how
you change which model it thinks with, and the permission mode is how much it
may do without asking.

The same verbs work from any terminal in the network:

```bash
con digest                       every machine, folder and running session
con thread <id>                  one conversation
con say <id> "<text>"            prompt an existing session
con spawn <machine> <folder> <account> "<text>"
```

`con digest` keeps the last answer from every machine, so one that is asleep
is listed with when it was last seen rather than left out.

## What it costs

Every agent CLI records its own token usage next to its transcripts, and that
record is the complete one: it covers sessions con never started, and it
survives con's own event log being trimmed. **Usage** in the sidebar reads
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
zero: the footer says how many of your machines reported, the same way `con
digest` lists a sleeping machine with when it was last seen rather than leaving
it out.

Reading is incremental. The first pass on a machine with a long history reads
every transcript its CLIs ever wrote; after that only the bytes a session
appended are read, and the index survives a daemon restart. On a machine with
1.8GB of Codex rollouts that is 7.6s once, then about 25ms.

## Profiles and secrets

Con reads shell aliases and functions and turns them into profiles. This makes
different Codex, Claude, and OpenCode accounts selectable per session.

Profiles reference secret locations; they do not upload provider credentials.
Agents and credentials stay on the computer where the work runs.

## Security model

- Every user owns a separate Con home.
- Pairing links last a few minutes.
- Joined devices remain until explicitly removed. Removal also closes the
  device's live connections, not just its next sign-in.
- Machine invites are single-use.
- The network key stays in files readable only by the local user.
- Provider credentials never go to the VM unless the agent itself runs there.
- Only HTTPS should be exposed publicly; port `8787` stays behind Caddy.

The current design is for one trusted owner per Con home. Do not put unrelated
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
