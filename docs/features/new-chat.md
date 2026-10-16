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
- **Folders open at once:** → on a folder shows what is inside straight
  away, from the folder list the device keeps (and the last answer for that
  folder); the machine's own answer replaces it a moment later. The
  "New session" / "Add project" / "Send" folder screens do the same.
  Prove it with the machine made slow: `$V eval` a wrapper on
  `WebSocket.prototype.send` that holds any message with `fs.list` for 3 s,
  then open two levels with "open <name>"; both show their folders in
  under 3 s (driven 2026-10-16).
- **Traps:** the folder list starts at the private copy's own home, so
  making folders there is safe. With `up --real` it is the owner's home: do
  not make folders there.
  Only bind Ctrl/⌘+N, never a bare letter. The box once hung on "looking for
  agents" with the VM off; it now shows the saved list.
- **Tests:** `test/browser/new-chat`, `chat-home`, `onboarding`;
  `test/quick-chat`, `picker-prefs`, `onboarding`.

## Clone from GitHub
- **Sees:** "Clone from GitHub" under "No folder · quick chat" in the
  folder step. Then "Which repo?": the repos newest first under "Yours",
  each organization by name, then "Shared with you", with a lock on
  private ones. The list is the one kept from last time (on the machine's
  disk, `~/.helm/github-repos.json`), so it shows at once; one older than
  10 minutes is fetched again quietly behind it. Below: the gh account
  ("switch" with more than one), "447 repos · checked 3m ago" and refresh.
  A search with no match says "Not in your list. Looking on GitHub…": the
  list is fetched again and GitHub's own search is asked (an exact
  `owner/name` first, then names, known owners first) and shown under "On
  GitHub". Only then: "No repo called "x" on GitHub that <login> can see"
  with "Look again". Picking a repo asks "Where should <repo> go?" in the
  same folder tree as the folder step: "last used" place and Home on top,
  → and ← open and close, typing searches, a typed path (`~/work`) is
  offered as it is; "Goes to ~/dev/<repo>" under the list. A folder
  already holding that repo just opens; one holding something else is
  refused there. Then the agent step as always ("Clones owner/repo into
  …"). Enter starts the chat at once in the repo's folder: it is listed
  (Working, "cloning 40%"), and a card over the box shows the bar. What
  is written meanwhile waits ("1 waiting · Once the repo is in") and goes
  to the agent when the repo is in. Leaving and coming back keeps it; a
  cloned chat is never dropped as empty. A failed clone shows why with
  "Try again" and sits under "Needs you".
- **Signed out:** "The GitHub CLI on <machine> is not signed in. Run this
  there: `gh auth login`", Copy, "Check again". Helm never signs in to
  GitHub itself. No gh at all: "The GitHub CLI is not on <machine> yet".
- **Where:** `apps/web/src/NewChat.tsx` (the `github` and `into` steps),
  `apps/web/src/session/CloneCard.tsx` (the card in the chat),
  `packages/connect/src/github-repos.js` (`github.repos`, `github.find`,
  `github.check`, the clone itself), `packages/connect/src/sessions.js`
  (`start({ clone })`, `#followClone`, `retryClone`). It is the machine's
  own `gh` login; no token reaches the app. A gh too old for `--json`
  (2.45 on Ubuntu 24.04) is read from its plain `gh auth status` words.
- **Prove (driven 2026-10-15):** without `--real` the private copy's home
  has no gh login, so it shows the signed-out screen. `up --real` shows the
  owner's list (read only); clone a public repo into the scratch folder
  with the fake agent:
  ```sh
  $V up --real; $V open --desktop; $V click "New chat"; $V key Enter
  $V click "Clone from GitHub"; $V click "Search repos"; $V type "expressjs/express"
  $V wait "ON GITHUB" 20000; $V key Enter
  $V click "Search folders, or type a path"; $V type "/tmp/helm-verify-<you>/work"; $V key Enter
  $V type fake; $V key Enter                     # the chat opens, "cloning n%"
  $V click "Ask anything"; $V type "what is in this repo?"; $V click send   # "1 waiting"
  $V wait "working on it done." 600000
  ```
  A failure: `$V rpc session.start '{"cwd":"/tmp/helm-verify-<you>/work/nope","profileId":"fake","clone":{"repo":"octocat/no-such-repo-xyz"}}'`.
- **Proof:** the chat is in the sidebar while it clones; the waiting
  message goes in after it and the fake agent answers; the repo's files are
  in the folder. The failure shows "Could not clone …", the reason and
  "Try again", under "Needs you".
- **Traps:** with `--real` the owner's real chats are listed: touch none.
  The clone uses gh's own git setting (ssh on the laptop). A restart during
  a clone leaves the chat saying so, with "Try again" (a half-made folder
  this chat started is cleared first).
- **Tests:** `test/github-repos`, `test/clone-chat`.

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
