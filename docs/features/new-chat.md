# New chat, accounts and models

## New chat box
- **Reach:** "New chat", or Ctrl/⌘+N (Ctrl/⌘+Shift+O in a normal browser
  tab, which keeps Ctrl+N). CLI: `helm spawn`, `helm chat <account> --quick`.
- **Prove (driven 2026-10-15):**
  ```sh
  $V key Control+n
  $V click "verify-<you>"; $V click "No folder · quick chat"; $V click "fake"
  $V text | tail -8         # "What is on your mind?", last line "fake"
  ```
- **Folders open at once** from the list the device keeps; the machine's
  answer replaces it. Prove it slow (driven 2026-10-16): `$V eval` a wrapper
  on `WebSocket.prototype.send` that holds `fs.list` for 3 s, then open two
  levels with "open <name>"; both show in under 3 s.
- **Traps:** with `up --real` the folder list is the owner's home: make no
  folders there. Only bind Ctrl/⌘+N, never a bare letter. The box once hung
  on "looking for agents" with the VM off; it must show the saved list.
- **Going back to an unused chat (owner, 2026-10-26):** leaving a chat with
  nothing sent still deletes it. Back or forward to it starts the same chat
  again (same folder, agent and settings, and the unsent text), so it is
  never an empty page. Prove (driven 2026-10-26): new fake chat, type
  "keep me" without sending, open another chat, `$V key Control+BracketLeft`
  (headless Chrome ignores Alt+Left): "What is on your mind?" with "keep me"
  in the box, and `rpc session.list` holds one new "Quick chat".
- **Tests:** `test/browser/new-chat`, `chat-home`, `onboarding`;
  `test/quick-chat`, `picker-prefs`, `onboarding`.

## Clone from GitHub
- **Rules:** Helm never signs in to GitHub and no GitHub key reaches the
  app; it uses the machine's `gh` login. The repo list is kept in
  `~/.helm/github-repos.json` and fetched again after 10 minutes. The chat
  starts at once; messages wait until the repo is in.
- **Prove (driven 2026-10-15):** without `--real` it shows the signed-out
  screen. With `up --real` (owner's list, read only), clone a public repo
  into the scratch folder:
  ```sh
  $V up --real; $V open --desktop; $V click "New chat"; $V key Enter
  $V click "Clone from GitHub"; $V click "Search repos"; $V type "expressjs/express"
  $V wait "ON GITHUB" 20000; $V key Enter
  $V click "Search folders, or type a path"; $V type "/tmp/helm-verify-<you>/work"; $V key Enter
  $V type fake; $V key Enter                     # the chat opens, "cloning n%"
  $V click "Ask anything"; $V type "what is in this repo?"; $V click send   # "1 waiting"
  $V wait "working on it done." 600000
  ```
  A failure: `$V rpc session.start '{"cwd":"/tmp/helm-verify-<you>/work/nope","profileId":"fake","clone":{"repo":"octocat/no-such-repo-xyz"}}'`
  shows "Could not clone …" and "Try again" under "Needs you".
- **Traps:** the clone uses gh's git setting (ssh on the laptop). A gh too
  old for `--json` (2.45 on Ubuntu 24.04) is read from plain `gh auth
  status` words. A restart mid-clone offers "Try again" and first clears the
  half-made folder this chat started.
- **Tests:** `test/github-repos`, `test/clone-chat`.

## Accounts, models, defaults
- **Prove (driven):** `$V rpc profile.list` lists `fake` and `fake-ask`;
  `$V rpc agent.list` gives CLI details. `$V key Control+Shift+s; $V click
  "CLI defaults"` shows rows for "Devin · fake" and "Devin · fake-ask".
- **Traps:** "Set default" is separate from this chat's model; on a phone
  it shows only on the chosen row. The model list can be up to ten minutes
  old, with no refresh button yet. Without an approved list the picker
  shows only the newest of each line (`modelShelf.ts`); devin's
  "-high-fast" ids fold into one row plus thinking and speed chips.
- **Tests:** `test/model-shelf`, `test/alias-accounts`, `native-account`, `profiles-refresh`,
  `engines`, `discover-wrapper`, `models`, `models-refresh`, `model-prefs`,
  `model-follow`, `project-settings`, `session-settings`;
  `test/browser/models`, `effort-default`.
