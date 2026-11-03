# What Helm is for

Coding agents keep stopping to ask something, and then sit idle until someone
answers. Helm exists so that waiting on an agent does not mean waiting at the
desk: the owner's phone is enough to see what is blocked, read the question,
answer it and move on.

Machines do the work; the phone is a control hub. The hierarchy is
machine -> folder -> chat. Each chat runs one profile: a CLI on an account.

## The bar

1. Pairing a device is one private link. Browser access lasts seven days. Removing a device ends access.
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
- **Passwords only start pairing and last minutes. Browser credentials last seven days.**
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
- **Chromium's bar on the desktop app:** an installed web app always keeps
  Chromium's zoom, extensions and menu buttons, so Helm never installs one. The
  launcher opens a plain `--app=` window with the system title bar: the
  desktop's own bar and Close button where it draws one, nothing where it
  draws none (niri with prefer-no-csd, Hyprland, sway), and then Helm's page
  draws its own Close button. Each start rewrites an older launcher
  (`refreshAppLauncher`) and sets the frame once the window's browser has
  exited (`syncWindowFrame`): Chromium writes its settings back after it lets
  go of the profile lock.
- **Remote hub access needs HTTPS.** HTTP works only over loopback. LAN
  discovery stays off until Helm has an encrypted LAN transport. Encrypted
  direct links remain available through a reachable HTTPS hub.
- **Machine credentials need the machine's private signing key.** The shared
  network key alone cannot sign them. Upgrade all machines together. Old
  machine and browser credentials are refused. Remote browsers must sign in
  again. Browser requests also need a private device key. Keep that key in
  browser storage as a non-exportable CryptoKey. A copied token alone must
  never authorize a remote request or a direct offer. Restore signing keys from backups; replacing a pinned key breaks trust.
- **Machine records need the owner's signature.** Check it with the saved
  signing key before applying changes. Keep old unsigned records fixed.
  A machine with no saved signing key must rejoin through an invitation.
  Never learn a replacement key from an unsigned update. Keep an invitation
  address in a local note until its owner advertises it. Never edit the
  inviter record to add that address.
- **Local sign-in refuses forwarded traffic.** Spins must never expose Helm's
  own port. Check existing links as well as new links.
- **Private Spin passes need a current machine signature.** The shared key
  alone cannot issue a pass. Enforce signer removal and the cookie lifetime.
- **A machine can admit other machines while trusted.** After a suspected
  compromise, review machines and devices added before removal. Revoking a
  signer also blocks browser credentials that it signed.

- **A herdr pane read includes old scrollback,** so an old warning reads as
  current. Read the live screen.
- **Reviews:** a second model's review has been confidently wrong here. Run
  the code before trusting a claim either way.
