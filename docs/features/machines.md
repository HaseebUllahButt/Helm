# Machines, devices and moving work

Each private copy starts with one machine ("verify-<you>"). Pair two private
copies only with each other to test work between machines. For automatic task
returns, keep each private `HELM_DIR` inside its private `HOME`. The default
verify-helm folders are siblings, so a custom private daemon needs a containing
home. Return materialization refuses folders outside that home. Never use the
owner's home or network to bypass this check.

## Machines and devices
- **Reach:** Open a machine from Home on a computer, from the machine list on
  phone Home, or from search on any screen.
- Phone Home shows online machines. Expand **Machines** to see offline machines too.
- **Prove (driven 2026-10-15):** `$V click "Search anything"; $V type
  verify-<you>; $V key Enter` opens its screen. `$V key
  Control+Shift+s; $V click "Devices & pairing"; $V text` shows "Linux
  Chrome · this device · online now".
- **Transport:** remote access requires HTTPS. HTTP works only on loopback.
  Local network finding is on: machines on one Wi-Fi find each other on
  UDP 8787 and set up the direct link without waiting for the hub. Packets
  are encrypted and signed; no hub address is announced. Turn it off with
  `"lanDiscovery": false` in `config.json` or `HELM_LAN_DISCOVERY=0`. Test
  copies stay quiet unless `HELM_LAN_DISCOVERY=1`. `helm status` shows
  "local network finding" and the machines it heard.
  ufw drops these packets by default, and the only symptom is a slow route
  through the hub. Helm opens UDP 8787 and 44301–44332 in ufw for this
  machine's private range only: at start with `sudo -n`, and with a password
  prompt in `helm network-repair`. `helm status` warns while a rule is
  missing. Other firewalls are left alone.
  A browser stays signed in until it is removed.
  Its credential still carries a seven-day expiry, because older Helm refuses
  one without it; newer Helm ignores the expiry.
  Old credentials stop working after the security update. A browser pairs
  with a private device key. Remote requests prove that key for one machine,
  challenge and request. Direct offers prove it for the target and connection.
  Removing the credential's signer also closes existing direct connections.
  A machine connects only to a hub that signs as the owner of the address
  it dialled. A machine that joined through an older Helm has no inviter
  receipt. Machines that have not seen it yet refuse it: make a new join
  command.
- **Traps:** never press "Make join command" or remove devices on the real
  network to test. Removing a device signs it out everywhere. Join links
  expire in minutes. Public machines need inbound UDP 44301–44332 in both
  cloud and host firewalls for direct links. Native peers share these ports;
  `config.json` can override them with `directPorts: {begin, end}`. The end
  must be greater than the beginning. Private tests must match their own
  firewall rules and never change the owner's network.
- **Tests:** `test/machine-kind`, `device-presence`, `roster-watch`,
  `gossip`, `lan-discovery`, `network-monitor`, `hub-mesh`, `frame-lanes`, `direct-mesh`, `auth`, `local-login`,
  `hub-authz`, `roster-trust`, `security-transport`, `security-routes`; `test/browser/hub-auth`.

## Wake an offline machine

- On phone Home, expand **Machines**. On a computer, open Home or
  Dashboard. **Wake** appears next to an offline machine when Helm can see
  an online sender on its last wired network.
- Run `helm wake <machine>` to send a signal. Add `--wait <minutes>`
  to wait for the machine to connect. Add `--wake` to `exec`, `spawn`,
  `delegate --machine` or `dispatch` to wait up to five minutes before
  starting the job. Press Ctrl+C to stop waiting.
- Run current Helm on both Linux machines. Connect the target by
  Ethernet and start Helm there before putting it to sleep. Keep one
  machine online on the same IPv4 network and router. The sender can use
  Wi-Fi if its access point passes broadcasts to the wired network.
  Run `helm doctor` on the target to check the card and see how to enable wake.
- Machines share signed wake details with current hubs. A target's
  last wired network stays available across a restart. Helm checks the
  sender's current network before it sends the signal.
- Keep test packets inside a private network namespace. Give
  two fake targets the same IP range and different router addresses. Confirm
  that Wake appears for only the matching target, then capture its packet.
  Attach the matching target after the packet and check that `exec --wake`
  runs its command after the target connects.
- See `test/wake-state`, `test/wake-machine` and `test/wake-cli`.

## Remote screens
- **What:** the owner sees and uses another machine's real desktop in its own
  Helm app window. The engine is screen-relay's (`native/screen`, see its
  README). Decided 2026-11-19: this is for the owner only. Agents keep
  `helm browser` and never open a screen.
- **Reach:** Ctrl/Cmd+Shift+R in Helm (a machine menu), search "Open a
  screen" or "Screen of <machine>", or the screen button on a machine's
  page. `helm screen [status | stop]` shows or stops this machine's own.
- **Rules:** only an owner device may call `screen.*` on another machine,
  and only an owner device may press Set up (admin rights with no card).
  Each start makes a new 64-character key; the viewer link carries it in
  the fragment, so other local pages cannot use the engine. The window
  opens only from a page on a loopback address (the Helm app on a
  computer), because the forward listens on that computer's 127.0.0.1.
  A phone gets a note instead.
- **Keys:** the window works like a virtual machine's window. It opens
  full screen with control on and the keyboard locked, so Super keys and
  the browser's own keys (Ctrl+W) reach the other machine. No click first:
  screens open in their own browser profile (`~/.helm/screen-window`,
  `seedScreenProfile` in desktop.js) that allows 127.0.0.1 pages automatic
  fullscreen and keyboard lock. Brave hides keyboard lock behind its Shields
  (`navigator.keyboard.lock` is missing); its `brave_webcompat_keyboard`
  setting brings it back (tested 2026-11-23, Brave 1.99). A browser that
  still asks for a click gets it from the first click or key; that click is
  not sent on. On niri, Super+Ctrl+Esc (the owner's binding) turns the lock
  off without telling the page; going to another window and back locks
  again. Where the page sees Super+Ctrl+Esc, or after leaving fullscreen,
  control stays on, Super keys stay here, and a bar offers "Send all keys".
  A hidden test browser has no keyboard lock: prove it in a visible browser
  on a test display (Xvfb).
- **Desktop shortcuts on Wayland:** niri never runs its own binds for keys
  from a Wayland virtual keyboard (tested 2026-11-19: `wtype` Super+Esc did
  not open the overview). So the engine presses keys through a kernel
  keyboard (/dev/uinput, Helm's edit in `input.cpp`) and keeps the virtual
  keyboard for typed text. Set up writes a `uaccess` udev rule
  (`70-helm-screen.rules`) so the signed-in person may use it. Until then a
  Wayland screen asks for Set up; "Open without shortcuts" skips it.
- **Speed:** the picture rides a forward, so it takes the direct channel
  when `helm status` says that machine is reached direct (spins.md, Route).
  Otherwise every frame goes through a hub, and the delay is the path to
  the hub and back (about 0.4 to 0.9 s from why through the VM). The engine writes to Helm's tunnel on its
  own machine, so its TCP numbers show a loopback link. With them it let
  two or three pictures travel at once: about 3 a second on a 360 ms path.
  Helm starts it with `--behind-tls-proxy`, which makes it pace by the
  viewer's acknowledgements instead (13 a second in the same test, the test
  machine's own limit). `ENGINE_OPTIONS` in screen.js restarts an engine
  started with older options.
- **Linux only** for now: X11, or Wayland on niri, sway or Hyprland. GNOME
  and KDE on Wayland lack the screen copy the engine uses.
- **Not this computer:** the menu, search and the machine page leave out
  the computer that runs the window: its screen would only show itself.
  With no other machine online the menu says so.
- **Menu asks first:** on open, the menu calls `screen.status { quick }` on
  each machine (no package check). Machines that can show a screen come
  first. The rest are grey with the reason: no desktop open, desktop not
  supported, not Linux, older Helm, offline. Picking one says what to do
  instead (sign in to a desktop there, or Ctrl+Shift+T for its terminal).
  An answer that takes over 8 s counts as "can open".
- **Stops:** the engine stops 1 minute after the last viewer goes, with
  the forwards that carry it.
- **Prove (driven 2026-11-23):** `$V open --desktop; $V key
  Control+Shift+KeyR` shows "Open a screen" and "No other machine is
  online". The copy has one machine, so to see the Set up box, let the
  picker list this machine for a moment (App.tsx screenPicker filter): it
  shows "Turn on shortcuts for …" with stacked buttons. Never press it in a
  copy: it changes the real machine. The live picture needs two real
  machines.
- **Tests:** `test/screen.test.mjs`.

## Check installation and connections
- Open Settings and select **Check connection**. Each answering machine reports
  its paths to the others. A failed read identifies the device-to-machine step.
  A route proves a path is present, not that a chat or agent can run.
- Open **Recent connection changes** for observations from each machine. The
  last 100 changes survive restarts. Samples run every 15 seconds and on checks;
  short failures between samples may be absent. Last seen means a route was
  observed, not that a message was delivered.
- Select **Save support report** to download fixed fields with generated
  machine names. Reports omit addresses, keys, raw errors and chat data.
- Run `helm doctor` on the affected machine. Use `--json` for a support report.
  It reads status only. It never starts a service or changes settings.
- Network checks ignore container links, link-local addresses and Tailscale
  address changes. Physical addresses, default routes, VPN rules and DNS still
  trigger a check. Keep working hub and direct routes while probes run.
  A failed path can use a backup. A faster measured path can replace it.
- The live connection check stays on loopback. A healthy remote home must not
  hide a failed local service. A home health reply proves only its web response.
- Reports omit addresses, keys, account data, and raw errors. A route count
  does not prove a missing machine is asleep. Check that machine separately.
- **Tests:** `test/doctor`, `connection-history`, `connection-report`.

## Send a project or a task to another machine
- **Prove (driven 2026-10-21):** use two private Helm copies, each with its
  own home and sockets, paired only with each other. Open the source machine,
  choose **Send a project**, choose a folder, then **Send to** the target.
  Slow the test sender to observe progress, choose **Cancel send**, then
  **Retry**. Check the received files after **Sent** appears.
- **Proof:** a 36 MB file resumed with the same job and destination. Its
  SHA-256 matched, an executable kept mode 0751, and its symlink survived.
  Interrupted-job and signed-receipt recovery are also covered by the tests.
- **Traps:** current Send streams files without the old snapshot size or
  file-count caps. It keeps source files. Sending again keeps files created
  on the target.
  Older targets show a compatibility message: their copy has no atomic
  publication or signed completion receipt. A lost start reply needs **Check
  status**, not another send. A stopped send's **Retry** uses its original
  destination. Git history travels with current Send; dependencies and caches
  stay behind. It does not use GitHub; a new agent rebuilds dependencies.
  Task sends save their request number and content before sending. Reopening
  Send keeps that request until its confirmed result is dismissed. Source
  machines resume saved copies after restart. If the owner resumed work in
  the source chat, copying waits for that reply to finish. After an attempted
  delivery, automatic recovery only checks receipts; the hub delivers queued
  work. Only an owner retry can restart a failed target prompt. A known target
  refusal waits for that retry. Unconfirmed delivery must never become a new
  task number.
- **Tests:** `test/transfers`, `task-transfer`, `transfer-cli`,
  `transfer-check`, `transfer-activity`, `code-transfer`, `handoffs`,
  `send-engine`, `send-recovery`, `task-send`; `test/browser/transfers`, `send-v2`.

## Move a chat to another machine
- **Reach:** ⋯ on a sidebar row or in the chat → **Move to another machine**.
  Claude and Codex chats only; not helpers, terminal chats or a working reply.
- **Rules:** the move copies the folder, then the CLI's own conversation
  file with a new id and the new folder path (`chat-move.js`). Only `cwd`,
  `*roots` and the id change: Claude signs its thinking, so message text
  stays byte for byte. The target opens it as a saved chat ("Moved from
  …"); the next message resumes it with full memory. The old copy is
  archived, shows "Moved to …" and refuses messages. Both copies are kept
  when left unused (`discardEmpty`). Each step is saved; a restart
  continues it, and **Try again** resends what changed.
- **Prove (driven 2026-10-30):** pair two private copies (join code from
  `helm add pc` against the first copy's address), give both a `claude`
  account whose `auth status` says logged in, write a Claude transcript into
  the first copy's home and open it with `rpc session.resume`. Move it from
  the row ⋯; "Open chat on …" shows its messages and "Moved from". A real
  Claude resumed a moved conversation in a new folder and still knew a word
  from before the move.
- **Traps:** both copies are hidden Send jobs (`internal`), so no "View …
  on …" notice appears. The receiver checks rsync's options per job
  (`copy-arguments.js`); a new Send flag needs a line there.
- **Tests:** `test/chat-move`, `session-driver`, `copy-arguments`,
  `send-engine`.

## `helm exec` and `helm copy`
- **Prove:** start a command with `$V rpc exec.start` using a 32-digit hex
  id. Read its output with `exec.read`, restart the private daemon, then
  read the same id again. A running command and its output must survive.
- **Traps:** if exec says the command may have started, never rerun it;
  read it with `exec-status`. A detached supervisor saves its output and
  result across daemon restarts. Output keeps only the last 256 KB for an
  hour. The exit details and reserved ID remain after the output expires.
  `helm copy` needs rsync 3.2.3+ on both ends; a break resumes on rerun.
  With protected arguments, rsync receives its folder and options inside
  the byte stream. Check those before passing them to rsync, and bind the
  folder to the signed request. A Send must also match its approved stage.
  Plain copy still permits the sender to choose an absolute destination;
  this check is not a general file sandbox. Unsupported options fail with
  no retry, so a newer rsync needs a reviewed allowlist change.
- **Tests:** `test/execution`, `execution-rpc`, `copy`,
  `copy-transport`, `copy-arguments`, `copy-binary`, `bulk-transfer`.

## Tools: `helm tools`
- **Reach:** `helm tools add|list|show|run|remove`, and **Settings >
  Tools** (also in the palette). The app lists and removes; adding is
  only through the command, on the machine that has the program.
- **Rules:** each machine keeps its own tools in `~/.helm/tools.json`.
  `list` asks every machine; what it hears is kept in `tools-seen.json`,
  so an offline machine still shows its last known tools. A tool on this
  machine runs like `helm run` (this shell's settings, live input). On
  another machine it runs like `helm exec`: the caller reads all piped
  input first (1 MB, sent with `exec.start` as `stdin`). An older Helm
  drops that input, and the caller says so.
- **Prove:** with the private copy, `$H tools add hi --description "Say hi."
  -- echo hi`, then `$H tools run hi there` prints `hi there`. Open Settings >
  Tools at phone and computer sizes, press Remove, and see the notice with
  the add command to undo it.
- **Tests:** `test/tools`, `test/execution`.

## Saved CLI conversations and Take over
- **Rules:** a saved Claude, Codex, OpenCode or Pi conversation opens with
  its messages; opening alone starts no agent, and the next message resumes
  it. Take over waits for the current step. A terminal in the same folder
  must not hide the saved conversation. OpenCode 2's shared service reports
  busy chat IDs directly. Its saved tabs count as open only while a terminal
  in their folder is alive. Its process must never be stopped to take over
  one chat. Those chats can continue here after their current step finishes.
- **Prove:** `test/helpers/external-fixtures.mjs` puts outside histories in
  the copy's home and adds their profiles. Open each from the machine
  screen, check the answer and tray, reload and check again. Check that
  Load older chats reaches past the first page and search finds older rows.
  Taking over a live CLI still needs a real one.
- **Traps:** keep the fixture's working folder outside `/tmp` (histories
  there are hidden).
- **Tests:** `test/takeover`, `native-cli`, `native-launchers`,
  `native-claude-chat`, `external-open`.
