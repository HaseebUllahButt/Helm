# Settings, usage, limits, updates and connectors

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
- **Prove (driven):** `$V key Control+Shift+4; $V text | head -20` shows "At
  API prices · last 7 days" and "WHERE IT WENT"; `$V rpc usage.report '{}'`
  gives the same totals.
- **Traps:** an unpriced model shows "unpriced" or "–", never $0. With
  `up --real` this is the owner's real spend. Devin spend can be five
  minutes late. Costs are API prices, not money spent.
- **Tests:** `test/browser/usage`; `test/usage`, `usage-sync`,
  `cost-accounting`, `devin-usage`, `other-pricing`, `token-rate`.

## Limits and context
- **Not yet driven;** the fake agent reports tiny usage and no limits. The
  "Compact at" setting applies to every chat on the account, on every
  machine.
- **Traps:** Claude's live limit check returns 403 on the laptop; values
  can come from saved reports.
- **Tests:** `test/browser/chat-limits`, `context-meter`, `compaction`;
  `test/account-limits`, `limits-line`, `context-limit`, `context-usage`,
  `usage-recovery`.

## Updates
- **Prove (screen only):** `$V key Control+Shift+s; $V click Updates; $V
  text` shows "verify-<you>" and the repo's current commit.
- **Traps:** never press either GitHub button in the private copy: it runs
  from the real repo. Machines sync the newest committed version between
  themselves; GitHub pulls happen only from the explicit button. Linux
  background services and macOS login services can take these updates.
  Native Windows has no automatic service replacement. Open apps reload at a quiet moment.
  Daemons restart immediately after an update. Agent hosts stay running;
  chats and open transfers never postpone replacement.
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
