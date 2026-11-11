# Settings, usage, limits, dashboard, updates and connectors

## Settings and appearance
- **Reach:** Ctrl/⌘+Shift+S from anywhere except a terminal.
- **Prove (driven 2026-10-15):** `$V key Control+Shift+s; $V text`; for a
  sub-screen `$V click "<name>"`, then `$V click Back`. Theme: `$V click
  Dark; $V eval "document.documentElement.dataset.theme"` gives `"dark"`;
  `$V click Auto` after.
- **Traps:** appearance is kept per device. An installed app keeps the old
  icon and style until closed and reopened.
  Optional screens load when opened. A failed app file leaves Back and
  Reload Helm in the current pane. Use Reload Helm, then reopen the screen;
  browsers can keep a failed import until the page reloads.
- **Prove a failed file (driven 2026-10-23):** block the preferences app file
  in the private browser, open Your preferences, use Back, then Reload Helm.
  Reopen Your preferences after the reload; the editor appears.
- **Tests:** `test/browser/global-keys`, `ui`, `appearance`, `deferred-screen`.

## Your preferences and the keeper
- **Reach:** Settings → Your preferences.
- **Prove (driven 2026-10-18):** edit the box, Save; the line under it says
  "Changed just now by you". A new chat's brief ends with `[Helm owner: …]`
  (`grep "Helm owner" <copy>/helm/events/*.jsonl`). Keeper: write a rule in a
  fake chat ("Never delete my files without asking, I keep telling you"),
  then `up --real`, `rpc profile.list '{"refresh":true}'` and Run now: the
  list gains a line and "What the keeper last changed" shows it. With only
  fake accounts Run now says no account has a small model.
- **Traps:** the copy reads the web build only at `up`; rebuild, then
  `down`/`up`. The keeper runs on one machine (the vm, else the oldest).
- **Tests:** `test/owner-preferences`, `owner-sync`.

## Usage & cost
- **Prove (driven 2026-11-11):** `$V key Control+Shift+4; $V text | head -20`
  shows "At pay-per-use prices · last 7 days", "Cost per day" and "Usage by
  group"; `$V rpc usage.report '{}'` gives the same totals. The layout
  follows the pane width, not the window: check 390, 960 and 1280 wide.
  Usage and Dashboard share one look (cards, tiles, meters): look at both
  after a change to either. "Today" has no chart; "All" past two months
  shows one bar a week.
- **Traps:** an unpriced model shows "unpriced" or "–", never $0. With
  `up --real` this is the owner's real spend. Devin spend can be five
  minutes late. Costs are API prices, not money spent. Pi and OMP chats
  carry the cost Pi wrote down, so a free model shows $0, not "unpriced".
- **Tests:** `test/browser/usage`; `test/usage`, `usage-sync`,
  `cost-accounting`, `devin-usage`, `other-pricing`, `token-rate`.

## Dashboard and the limit balancer
- **Reach:** Ctrl/⌘+Shift+D, the palette ("Dashboard"), Settings →
  Dashboard, the Dashboard link over Home's machines, and the phone's
  Machines list. `helm machines --load` and `helm agents` give the same
  numbers to agents.
- **What it shows:** compute online (machines, CPU, memory, GPUs), each
  machine's load (`machine.stats`, read only while the screen is open; GPUs
  from `nvidia-smi` only), the limit balancer per tool, then Accounts.
- **Balancer rule (protocol/balance.js):** work stays on the usual account
  until a window is 98% used, then goes to the account of the same tool with
  the most limit left (10% at least). A hand pick always wins: an account
  picked in Home or the new-chat list, or a full name in `helm delegate` /
  `helm spawn`. `helm delegate same` and a tool name (`codex`) balance.
- **Prove (driven 2026-11-11):** `up --real`, write readings into
  `<copy>/helm/account-limits.json` for two Claude account keys (one at 100%),
  `restart`, then `rpc picker.prefs '{"last":"<out key>"}'`. Home says
  "… is out of limit, back in …. This chat uses …" and the new-chat list
  puts "limit left" first. Fake accounts report no limits.
- **Traps:** a machine on an older Helm shows "Update Helm on this machine to
  see its load". Limits come only from Claude and Codex.
- **Tests:** `test/balance`, `machine-stats`, `web-balancer`, `delegation`.

## Limits and context
- **Not yet driven;** the fake agent reports tiny usage and no limits. The
  "Compact at" setting applies to every chat on the account, on every
  machine. The meter uses a new size at once; Claude confirms it with its
  next reply. Test: `test/browser/context-limit`.
- **Codex banked resets:** only `account/rateLimits/read` names them, so
  `usage.limits` asks a private `codex app-server` at most every 15 minutes,
  and only for Codex accounts with chats. To drive it, add a codex profile
  whose `cmd` answers that read, start a chat on it, and open Usage
  (Ctrl+Shift+4): the account shows "2 banked resets · the next one ends …".
- **Traps:** Claude's live limit check returns 403 on the laptop; values
  can come from saved reports.
- **Tests:** `test/browser/chat-limits`, `context-meter`, `compaction`;
  `test/account-limits`, `limits-line`, `context-limit`, `context-usage`,
  `usage-recovery`.

## Updates
- `helm ship` checks a free private chat before merging and after the machines
  update. It restarts the private daemon, checks the same approval, then uses it
  and checks that one provider turn completes. It never creates owner chats.
  A failed proof prevents a successful ship result. The local check needs
  Playwright and its Chromium browser. Run `node scripts/release-proof.mjs`
  to see its failed step. This does not prove every network or operating system.
- **Prove (screen only):** `$V key Control+Shift+s; $V click Updates; $V
  text` shows "verify-<you>" and the repo's current commit.
- **Traps:** never press either GitHub button in the private copy: it runs
  from the real repo. Machines sync the newest committed version between
  themselves; GitHub pulls happen only from the explicit button. Linux
  background services and macOS login services can take these updates.
  Native Windows has no automatic service replacement. Open apps reload at a quiet moment.
  Daemons restart immediately after an update. Agent hosts stay running;
  chats and open transfers never postpone replacement.
- **Coding tools:** Helm runs each tool's own updater every six hours. An
  npm tool in a folder in the home (`npm i -g --prefix ~/.local`, used where
  npm's own folder needs sudo) updates into that same folder. Before this,
  Codex and Pi on `why` stayed old with "another Node version?". On a
  model launch, the Claude Code build that knows the model is often only on
  the early channel. A build that does not know a model treats it as 200k
  and compacts early. So when the program does not name a model on
  Anthropic's page, Helm installs the newer early build.
- **Prove restart:** start a private `fake-slow` chat, run `$V restart`,
  and confirm it finishes. Repeat with `fake-ask`: approve after restart
  and confirm the same request completes.
- **Tests:** `test/browser/app-update`, `coding-tools`; `test/self-update`,
  `version-sync`, `cli-updates`.

## Connectors & skills
- **Prove (driven):** `$V up --real`, machine screen → "Connectors &
  skills" → "Choose account", pick a Claude or Codex account, then "Add
  connector" for the logos, and tap a row for details. Look only; never
  Remove the owner's items. The fake account says "Connector management is
  not supported for this CLI yet." Without `--real`, add a Codex profile to
  the copy's `helm/profiles.json` whose `CODEX_HOME` is a seeded folder in
  the copy (a `config.toml` with `[mcp_servers.*]` and `[plugins.*]`, and
  `skills/`).
- **Traps:** a skill reachable by two links shows once, and Remove clears
  both.
- **Tests:** `test/browser/integrations`; `test/integrations`. Design:
  [`docs/integrations.md`](../integrations.md).
