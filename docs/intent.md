# What Helm is for

Coding agents keep stopping to ask something, and then sit idle until someone
answers. Helm exists so that waiting on an agent does not mean waiting at the
desk: the owner's phone is enough to see what is blocked, read the question,
answer it and move on.

Machines do the work; the phone is a control hub. The hierarchy is
machine -> folder -> chat. Each chat runs one profile: a CLI on an account.

## The bar

1. Pairing a device is one private link. A device stays in until removed.
2. A chat waiting on the owner is impossible to miss and one tap from answered.
3. It reads like a live chat: text streams, tool calls show as they start,
   approvals are cards with the real choices.
4. Low latency: chat data goes machine to device directly; a hub only
   introduces them.

## Settled, do not reopen without a reason

- **No Tailscale or other outside network service.** Helm builds its own.
- **No T3 Code code or apps.** T3's ideas and layout, Helm's own look.
- **One owner per network.** No shared Helm account, no hosted dependency.
- **Profiles point at secrets, never copy them.**
- **Passwords only start a pairing and last minutes; devices are durable.**
- **Agents run headless through each CLI's own protocol** and give a typed
  event stream. Reading a terminal and typing `y`/`n` blind was the old way
  and made the screen dead while the agent worked. herdr still owns plain
  terminals and agents started at the keyboard.

## Two invariants you can break without noticing

1. A machine is the only author of its own roster record. `mergeRoster` skips
   `net.self`; a hub never writes another machine's record.
2. A machine attaches to its own hub exactly once, over loopback, as
   `role=self`. Break either and the machine flaps forever.

## Traps that cost days

- **Push:** subscriptions are in `hub.sqlite` (`push_subs`), not `push.json`
  (that only holds the keys). Check `push_subs` and the journal before saying
  push is broken; it has been wrongly called broken three times.
- **"The deploy did not work":** an installed app keeps the old screens and
  icon until the window is reopened. Check what the machine serves
  (`curl -s <addr>/icon.svg`) before believing the screen.
- **Grey bar on the installed app:** an app installed from one address and sent
  to another shows Chrome's address strip. Install the desktop app from the
  machine's own address (`helm app`).
- **Chromium's bar on the desktop app:** an installed web app always keeps a
  Chromium strip, and a plain `--app=` window loses its bar only with the
  system title bar on a desktop that draws none (niri with prefer-no-csd,
  Hyprland). There the launcher opens that bare window; elsewhere it opens Helm
  installed as a web app with the overlay switch on, so only Chromium's small
  buttons stay. Each start rewrites an outdated launcher (`refreshAppLauncher`)
  and sets the frame once the window's browser has exited (`syncWindowFrame`):
  Chromium writes its settings back after it lets go of the profile lock.
- **A laptop's hub is plain http on its local network** (bound to `0.0.0.0` so
  a phone on the same wifi is fast). On a network you do not trust, run
  `helm up --install --host 127.0.0.1`.
- **A herdr pane read includes old scrollback,** so an old warning reads as
  current. Read the live screen.
- **Reviews:** a second model's review has been confidently wrong here. Run
  the code before trusting a claim either way.
