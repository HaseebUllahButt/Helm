# Set up a Helm home

This guide is written so either a person or a coding agent can complete it.

## Goal

Turn an always-on Linux VM into one private Helm home. At the end, return one
working pairing link to the owner. Do not create an account on a shared Helm
server.

## Before starting

You need:

- an Ubuntu, Debian, or similar Linux VM with a stable public IPv4 address;
- SSH access with `sudo`;
- TCP ports 80 and 443 open in the VM firewall and cloud firewall.

You do not need a website, domain, DNS account, or Helm account. Do not expose
port 8787 publicly. Caddy will be the only public entry point.

## 1. Install Caddy

Install the `caddy` package using its official instructions for the VM's Linux
distribution. Helm uses it to create and renew HTTPS certificates. Do not add a
Caddy site by hand when using the normal `helm setup` command.

## 2. Install Helm

```bash
curl -fsSL https://raw.githubusercontent.com/HaseebUllahButt/helm/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

The public repository must exist before this command can work. From a private
checkout, run `npm install` and use `node packages/connect/bin/helm.js` instead.

## 3. Create the Helm home

```bash
helm setup
```

This detects the public IPv4 address and creates a free address such as
`https://203-0-113-42.sslip.io`. It adds an isolated Helm site to Caddy,
installs the user-level background process, waits for the public health check,
and prints a private link containing `#pair=`. Caddy setup may ask for the VM
user's `sudo` password.

If you already own a domain, point it at the VM, configure Caddy to proxy to
`127.0.0.1:8787`, then run `helm setup https://your-name.example`.

If setup cannot reach the address, inspect both sides:

```bash
journalctl --user -u helm-serve -n 50
sudo journalctl -u caddy -n 50
```

Also open the `/api/health` path under the address Helm printed. Do not report
success until it returns HTTP 200.

## 4. Return the link

If a fresh device link is needed, run:

```bash
helm link
```

Return the complete `https://.../#pair=...` link to the owner through a private
channel. The fragment contains a short-lived secret. Do not put it in public
logs, issues, commits, or chat rooms.

Tell the owner:

- open the link on mobile to pair the PWA;
- paste the same link into Helm Desktop;
- run `helm link` again if it expires;
- run `helm add` when adding another computer.

## 5. Add another computer

On any connected computer:

```bash
helm add
```

Install Helm on the new computer, then run the exact `helm join ...` command
printed by `helm add`.

## 5a. Add a second always-on VM (optional)

A network can hold more than one home, so devices keep working when any one VM
is down. On an existing machine, get a code with `helm add`. On the new VM,
after installing Caddy and Helm:

```bash
helm setup --join <CODE> --at https://your-first-home.example
```

This joins the existing network instead of founding a new one, assigns the new
VM its own free HTTPS address (or pass an explicit `https://…` at the end),
adds an isolated Helm site to its Caddy, and installs the background service.
No new pairing link is needed — paired devices discover the second home from
the shared roster. Re-running the command on a VM that is already a member just
re-advertises it; to move a VM to a different network, run `helm leave` first.

## Verification checklist for agents

Before handing off, verify all of these:

```bash
helm status
systemctl --user is-active helm-serve
loginctl show-user "$USER" -p Linger
```

Also request `/api/health` under the printed public address. Then generate a
fresh `helm link`. Report the public home address, pairing link, service status,
whether `Linger=yes`, and whether the health check passed. Never report or copy
the network key from `~/.helm/network.json`.
