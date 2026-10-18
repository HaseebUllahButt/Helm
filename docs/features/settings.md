# Settings, usage, limits, updates and connectors

## Settings and appearance
- **Reach:** Ctrl/⌘+Shift+S from anywhere except a terminal.
- **Prove (driven 2026-10-15):** `$V key Control+Shift+s; $V text`; for a
  sub-screen `$V click "<name>"`, then `$V click Back`. Theme: `$V click
  Dark; $V eval "document.documentElement.dataset.theme"` gives `"dark"`;
  `$V click Auto` after.
- **Traps:** appearance is kept per device. An installed app keeps the old
  icon and style until closed and reopened.
- **Tests:** `test/browser/global-keys`, `ui`, `appearance`.

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
  themselves; GitHub pulls happen only from the explicit button. Mac and
  Windows do not auto-update. Open apps reload at a quiet moment.
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
