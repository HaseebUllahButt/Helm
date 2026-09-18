# Set up a Con home

This guide is written so either a person or a coding agent can complete it.

## Goal

Turn an always-on Linux VM into one private Con home. At the end, return one
working pairing link to the owner. Do not create an account on a shared Con
server.

## Before starting

You need:

- an Ubuntu, Debian, or similar Linux VM with a stable public IPv4 address;
- SSH access with `sudo`;
- TCP ports 80 and 443 open in the VM firewall and cloud firewall.

You do not need a website, domain, DNS account, or Con account. Do not expose
port 8787 publicly. Caddy will be the only public entry point.

## 1. Install Caddy

Install the `caddy` package using its official instructions for the VM's Linux
distribution. Con uses it to create and renew HTTPS certificates. Do not add a
Caddy site by hand when using the normal `con setup` command.

## 2. Install Con

```bash
curl -fsSL https://raw.githubusercontent.com/HaseebUllahButt/helm/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

The public repository must exist before this command can work. From a private
checkout, run `npm install` and use `node packages/connect/bin/con.js` instead.

## 3. Create the Con home

```bash
con setup
```

This detects the public IPv4 address and creates a free address such as
`https://203-0-113-42.sslip.io`. It adds an isolated Con site to Caddy,
installs the user-level background process, waits for the public health check,
and prints a private link containing `#pair=`. Caddy setup may ask for the VM
user's `sudo` password.

If you already own a domain, point it at the VM, configure Caddy to proxy to
`127.0.0.1:8787`, then run `con setup https://your-name.example`.

If setup cannot reach the address, inspect both sides:

```bash
journalctl --user -u con-serve -n 50
sudo journalctl -u caddy -n 50
```

Also open the `/api/health` path under the address Con printed. Do not report
success until it returns HTTP 200.

## 4. Return the link

If a fresh controller link is needed, run:

```bash
con add controller
```

Return the complete `https://.../#pair=...` link to the owner through a private
channel. The fragment contains a short-lived secret. Do not put it in public
logs, issues, commits, or chat rooms.

Tell the owner:

- open the link on mobile to pair the PWA;
- run `con add controller` again if it expires;
- run `con add pc` when adding another computer, and `con add vm` for
  another always-on home;
- on a computer that has already joined, `con open` opens the app signed in,
  with no link at all.

## 5. Add another computer

On any connected computer:

```bash
con add pc
```

Install Con on the new computer, then run the exact `con join ...` command
printed by `con add pc`.

## 5a. Add a second always-on VM (optional)

A network can hold more than one home, so devices keep working when any one VM
is down. On an existing machine, get a code with `con add vm`. On the new VM,
after installing Caddy and Con, run the command that code was printed with:

```bash
con join <CODE> https://your-first-home.example
```

The code says "vm", so that machine also takes an address of its own and
starts serving. (`con setup --join <CODE> --at <url>` still does the same
thing, for existing scripts.)

This joins the existing network instead of founding a new one, assigns the new
VM its own free HTTPS address (or pass an explicit `https://…` at the end),
adds an isolated Con site to its Caddy, and installs the background service.
No new pairing link is needed — paired devices discover the second home from
the shared roster. Re-running the command on a VM that is already a member just
re-advertises it; to move a VM to a different network, run `con leave` first.

## Verification checklist for agents

Before handing off, verify all of these:

```bash
con status
systemctl --user is-active con-serve
loginctl show-user "$USER" -p Linger
```

Also request `/api/health` under the printed public address. Then generate a
fresh `con add controller`. Report the public home address, pairing link, service status,
whether `Linger=yes`, and whether the health check passed. Never report or copy
the network key from `~/.con/network.json`.
