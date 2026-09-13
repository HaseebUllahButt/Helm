# helm

Control the coding agents on all your computers from one desktop app or your
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
phone or Helm Desktop ──▶ your VM ◀── laptop
                              ▲          laptop dialled out
                              └──────── desktop
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

## Five commands

```bash
helm setup                           make this VM the always-on Helm home
helm link                            pair a phone, browser or desktop app
helm add                             add another computer
helm join CODE https://helm.example.com
helm status                          show the network and runtime
```

If you already own a domain, you can instead run
`helm setup https://helm.your-domain.com` after pointing it at the VM and
configuring Caddy.

### A second always-on VM

To add another home to an existing network, get a join code from any connected
machine with `helm add`, then on the new VM run:

```bash
helm setup --join ABCD-1234 --at https://helm.example.com
```

That joins the existing mesh (rather than starting a new one), gives this VM
its own free HTTPS address, and installs it as a background home — one command,
the same as the first VM. Pass an explicit `https://…` at the end if you own a
domain for it. Devices already paired need no new link; they simply gain a
second home to fall back on.

The older `helm up`, `helm invite`, and `helm login` commands remain available
for scripts and advanced setups.

### Pair another device

Run this anywhere that can reach the Helm home:

```bash
helm link
```

It prints one private link such as:

```text
https://helm.example.com/#pair=abc123
```

Open it on mobile to pair the PWA automatically. Paste the same link into Helm
Desktop. The link expires after ten minutes; the paired device stays connected
until removed.

### Add another computer

Install Helm on the new computer. Then run `helm add` on an existing one and
copy the command it prints:

```bash
helm join ABCD-1234 https://helm.example.com
```

The join code is single-use and expires after ten minutes. `helm join` installs
Helm as a background service on that computer, so it stays in the network
after the terminal closes; pass `--foreground` to run it in the terminal instead.

## Mobile PWA

On Android/Chrome: open the pairing link, pair, then choose **Install Helm
app**. The installed app keeps the pairing.

On iPhone or iPad the order matters, because the installed app gets its own
storage and does not inherit a pairing made in Safari: open the Helm address,
use **Share → Add to Home Screen** first, then open the installed app and
paste the pairing link (or type the code) there.

The PWA and desktop app use the same interface and stored device membership.

## Desktop app

Helm Desktop is a small Tauri window around the same app. Paste the private link
from `helm link` once and it stays paired.

Build and install it locally on Linux:

```bash
npm run desktop:build
npm run desktop:install
```

Tagged releases are built by GitHub Actions and published as `.AppImage` and
`.deb` downloads.

## Profiles and secrets

Helm reads shell aliases and functions and turns them into profiles. This makes
different Codex, Claude, and OpenCode accounts selectable per session.

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
- Only HTTPS should be exposed publicly; port `8787` stays behind Caddy.

The current design is for one trusted owner per Helm home. Do not put unrelated
users into the same network.

## Project layout

| | |
|---|---|
| `packages/protocol` | membership, credentials, and wire messages |
| `packages/connect` | daemon, CLI, profiles, SSH, and local runtime |
| `apps/relay` | the VM home and connection relay |
| `apps/web` | the mobile PWA and shared interface |
| `apps/desktop` | the Linux Tauri desktop app |

## Development

Requirements: Node 22+, Rust for desktop builds, and
[herdr](https://herdr.dev) for agent terminals.

```bash
npm install
npm run check
```

`npm run check` type-checks and builds the web app, then runs the CLI and
network regression tests.
