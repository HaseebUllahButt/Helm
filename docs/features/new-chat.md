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

## Clone from GitHub
- **Sees:** "Clone from GitHub" under "No folder · quick chat" in the
  folder step. Then "Which repo?": a search box and the repos newest first,
  under headings - "Yours", then each organization by name, then "Shared
  with you" for other people's repos - with a lock on private ones. Below:
  the gh account (tap "switch" when the machine has more than one) and
  refresh. Typing `owner/name` offers any repo by name. Picking a repo asks
  "Where should <repo> go?": the last place clones went, home and its
  folders; typing searches every folder, and a typed path (`~/work`) is
  offered as it is. Picking a place closes the box and opens that folder's
  "New session" page, where a bar shows the clone; its Start button reads
  "Cloning… 40%" until the repo is in. A folder already holding that repo
  just opens. The keys row at the bottom only lists keys that do something.
- **Signed out:** "The GitHub CLI on <machine> is not signed in. Run this
  there: `gh auth login`", Copy, "Check again". Helm never signs in to
  GitHub itself. No gh at all: "The GitHub CLI is not on <machine> yet".
- **Where:** `apps/web/src/NewChat.tsx` (the `github` and `into` steps),
  `apps/web/src/cloneJobs.ts` (follows a clone after the box closes; the
  bar is in `Start` in `App.tsx`), `packages/connect/src/github-repos.js`
  (`github.repos`, `github.clone`). It is the machine's own `gh` login; no
  token reaches the app. A gh too old for `--json` (2.45 on Ubuntu 24.04)
  is read from its plain `gh auth status` words.
- **Prove (driven 2026-10-15):** without `--real` the private copy's home
  has no gh login, so it shows the signed-out screen. `up --real` shows the
  owner's list:
  ```sh
  $V up --real; $V open --desktop; $V click "New chat"; $V key Enter
  $V click "Clone from GitHub"; $V click "Search repos"; $V type "octocat/Hello-World"
  $V key Enter; $V click "Search folders, or type a path"; $V type "/tmp/<scratch>"
  $V key Enter; $V wait "Start" 60000
  ```
- **Proof:** the box closes on "New session · Hello-World" with "Cloning
  Hello-World · octocat" and a bar, then "Start …" and
  `/tmp/<scratch>/Hello-World/README`.
- **Traps:** with `--real` the owner's real chats are listed: touch none.
  The clone uses gh's own git setting (ssh on the laptop).
- **Tests:** `test/github-repos`.

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
