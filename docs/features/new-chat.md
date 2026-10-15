# New chat, accounts and models

## New chat box
- **Sees:** a three-step box: Machine → Folder → CLI. "Where should we
  build?", then "What should we build on <machine>?" with folders, "No
  folder · quick chat" and "New folder in …", then "Which agent …?" listing
  accounts (engine name over the account name, e.g. "Devin / fake").
- **Reach:** "New chat" on Home, or Ctrl/⌘+N (Ctrl/⌘+Shift+O in a normal
  browser tab, which keeps Ctrl+N). In the box: Ctrl/⌘+Enter quick chat,
  Ctrl/⌘+Shift+Enter new folder with the typed name, ←/→ open or close a
  folder.
- **CLI:** `helm spawn <machine> <folder> <account> <text>`, `helm spawn
  <machine> - <account> <text>` (quick chat), `helm chat <account> --quick`.
- **Prove (driven 2026-10-15):**
  ```sh
  $V key Control+n                      # or: $V click "New chat"
  $V click "verify-<you>"; $V click "No folder · quick chat"; $V click "fake"
  $V text | tail -8                     # "What is on your mind?", last line "fake"
  ```
- **Proof:** an empty chat titled "Quick chat", "· quick chat" under it,
  "What is on your mind?", and the account name on the last line.
- **Traps:** the folder list starts at the private copy's own home, so
  making folders there is safe. With `up --real` it is the owner's home: do
  not make folders there.
  Only bind Ctrl/⌘+N, never a bare letter. The box once hung on "looking for
  agents" with the VM off; it now shows the saved list.
- **Tests:** `test/browser/new-chat`, `chat-home`, `onboarding`;
  `test/quick-chat`, `picker-prefs`, `onboarding`.

## Accounts
- **Sees:** one row per sign-in (per home folder), with a "default" tag and
  "API key" tag where it applies.
- **CLI:** `helm agents [--json] [--refresh]` (accounts, sign-in state,
  model names), `helm profiles [--refresh]`.
- **Prove (driven):** `$V rpc profile.list` lists `fake` "Fake agent" and
  `fake-ask` "Fake agent (asks)". `$V rpc agent.list` gives CLI details.
- **Traps:** only `up --real` adds the real accounts; even then, only start
  chats with "fake" or "fake-ask" unless the change is about that CLI.
- **Tests:** `test/alias-accounts`, `native-account`, `profiles-refresh`,
  `engines`, `discover-wrapper`.

## Models, favourites, defaults
- **Sees:** the model chip opens a list; star favourites; "Set default" is
  separate from this chat's model. Chat ⋯ menu → "Use these settings for new
  chats". In the account step: "Make <CLI> · <account> the default".
- **Reach:** Settings → **CLI defaults** shows each machine's defaults
  ("starts with the CLI's defaults" when none).
- **Prove (CLI defaults driven):**
  ```sh
  $V key Control+Shift+s; $V click "CLI defaults"; $V text | head -20
  ```
- **Proof:** a row for "Devin · fake" and "Devin · fake-ask".
- **Traps:** the model list can be up to ten minutes old; there is no
  refresh button yet.
- **Tests:** `test/browser/models`, `effort-default`, `slash-model-context`;
  `test/models`, `models-refresh`, `model-prefs`, `model-follow`,
  `project-settings`, `session-settings`.
