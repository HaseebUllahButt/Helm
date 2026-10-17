# Settings, appearance, usage, limits and updates

## Settings screen
- **Sees:** "Settings" with **Devices & pairing**, **CLI defaults**,
  **Public links**, **Usage & cost**, **Updates**; then DICTATION
  ("Dictation key · Works through <machine>", **Change**), APPEARANCE, a
  line about notifications, "Connection details" and "Unpair this device".
- **Reach:** the gear on Home ("Settings"), or Ctrl/⌘+Shift+S from anywhere
  except a terminal.
- **Prove (driven 2026-10-15):** `$V key Control+Shift+s; $V text`.
- **Proof:** the list above. For each sub-screen: `$V click "<name>"; $V
  text`; `$V click Back` returns to Settings.
- **Tests:** `test/browser/global-keys`, `ui`.

## Appearance
- **Sees:** Theme **Auto / Dark / Light / Navy**; Diff colours
  **Green/red / Blue/orange**; Lists **Roomy / Compact**. Kept per device.
- **Prove (driven):**
  ```sh
  $V key Control+Shift+s; $V click Dark
  $V eval "document.documentElement.dataset.theme"     # "dark"
  $V click Auto
  ```
- **Proof:** `"dark"`, and `shot` shows the dark screen.
- **Traps:** an installed app keeps the old icon and style until closed and
  reopened.
- **Tests:** `test/browser/appearance`, `ui`.

## Usage & cost
- **Sees:** "Usage", "All machines" or one machine, Today / 7 days /
  30 days / All, a total "At API prices", Tokens, Turns, "Saved by cache",
  then "WHERE IT WENT" by Model / CLI / Provider / Folder / Machine.
  Models with no price say "unpriced" or "–", never $0.
- **Reach:** Settings → Usage & cost, Ctrl/⌘+Shift+4, or a machine screen's
  "what <machine> has cost".
- **Prove (driven):** `$V key Control+Shift+4; $V text | head -20`.
- **Proof:** "Usage", "At API prices · last 7 days", the "WHERE IT WENT"
  rows. `$V rpc usage.report '{}'` returns the same totals.
- **Traps:** with `up --real` this shows the owner's real spend from this
  machine's CLI stores, not just fake chats. Devin spend can be up to five
  minutes late. Costs are what the API would charge, not money spent.
- **Tests:** `test/browser/usage`; `test/usage`, `usage-sync`,
  `cost-accounting`, `devin-usage`, `other-pricing`, `token-rate`.

## Limits and context
- **Sees:** under the box, how full the chat's memory is and the account's
  usage windows ("Limits left"); a card when a limit is hit, with "Continue
  automatically when this account's usage limit resets". A "Compact at" setting "For every chat on this
  account, on every machine."
- **Prove:** steps not yet driven; the fake agent reports tiny usage and no
  limits.
- **Traps:** Claude's live limit check returns 403 on the laptop; values
  can come from saved reports.
- **Tests:** `test/browser/chat-limits`, `context-meter`, `compaction`;
  `test/account-limits`, `limits-line`, `context-limit`, `context-usage`,
  `usage-recovery`.

## Updates
- **Sees:** a banner "Helm updates need attention on <machine>. Local changes
  are blocking automatic updates." with **Review updates**. Settings →
  **Updates**: each machine's commit ("7436d93 · …", "unsaved changes
  here"), CODING TOOLS (Claude Code, Codex and others update themselves),
  and GITHUB: **Let my agent update it** (recommended) or **Replace with
  GitHub's version** (keeps a backup).
- **CLI:** `helm self-update`; `helm update --replace`.
- **Prove (screen driven, actions not):** `$V key Control+Shift+s; $V click
  Updates; $V text`.
- **Proof:** "MACHINES", "verify-<you>", the repo's current commit.
- **Traps:** never press either GitHub button in the private copy: it runs
  from the real repo. Machines sync the newest committed version between
  themselves; GitHub pulls are only the explicit button. Mac and Windows do
  not auto-update. Open apps reload at a quiet moment.
- **Tests:** `test/browser/app-update`, `coding-tools`; `test/self-update`,
  `version-sync`, `cli-updates`.

## Connectors & skills
- **Sees:** machine screen → **Connectors & skills**: the account at the top
  (tap to change), then Connectors, Skills and Plugins. Each row has a logo
  tile (the real logo for known services, a coloured first letter for the
  rest) and one short line ("Runs on this machine", "Online service").
  **+ Add** sits beside each heading. Tapping a row opens its details: the
  full address or command, **Sign in** for online services (opens a
  terminal), and **Remove**. More than six skills fold behind "Show all N".
  A skill reachable by two links shows once; Remove clears both links.
- **Prove (driven):** `$V up --real`, `$V click "verify-<you>"`,
  `$V click "Connectors & skills"`, `$V click "Choose account"`, pick a
  Claude or Codex account, then `$V click "Add connector"` for the logos and
  tap a row for its details. Look only; never Remove the owner's items. For
  the fake account it says "Connector management is not supported for this
  CLI yet."
- **Tests:** `test/browser/integrations`; `test/integrations`. See
  `docs/integrations.md`.
