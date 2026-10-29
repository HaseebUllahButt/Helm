# New chat, accounts and models

## New chat box
- **Reach:** "New chat", or Ctrl/⌘+N (Ctrl/⌘+Shift+O in a normal browser
  tab, which keeps Ctrl+N). CLI: `helm spawn`, `helm chat <account> --quick`.
- **Prove (driven 2026-10-15):**
  ```sh
  $V key Control+n
  $V click "verify-<you>"; $V click "No folder · sketch"; $V click "fake"
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
  in the box, and `rpc session.list` holds one new "Sketch".
- **First message:** open the chat as soon as it exists. Do not wait for
  the first message receipt. Keep an uncertain send under its saved message
  number. Only a clear refusal returns the text to the box.
- **Start recovery:** save the caller's start number before setup. Retry and
  reload reuse that number. Save queued words and their message number before
  clearing the box. Restore them only for the same signed-in device.
  A crash after chat creation recovers the reserved chat. A crash during
  folder, clone, or terminal setup can leave no saved chat. Keep the queued
  words and stop with a recovery error; do not repeat uncertain setup.
- **Tests:** `test/start-receipts`, `test/startingChats`; `test/browser/new-chat`, `chat-home`, `onboarding`;
  `test/quick-chat`, `picker-prefs`, `onboarding`.

## First chat setup

- **Reach:** New chat, pick a machine, then “No folder · sketch”.
  Open “First chat help”. Follow the short question and reply check.
- **Missing account:** install an agent on the chosen machine, open it in a
  terminal, and sign in. Press “Check agents again” without closing the picker.
  A failed machine check has a separate message and retry button. A search
  without a match does not mean the machine needs an agent installed.
- **Proof:** use a private Helm with a fake agent. Open the help, choose fake,
  send “hello”, and wait for “done.”. Inspect a private screenshot and errors.
  Missing-account recovery also has a named browser test.
- **Packages and platform evidence:** see [ready packages](../ready-packages.md).
- **Tests:** `test/browser/new-chat.test.mjs`, `test/ready-package.test.mjs`.

## Copy from GitHub
- **Rules:** Helm never signs in to GitHub and no GitHub key reaches the
  app; it uses the machine's `gh` login. The repo list is kept in
  `~/.helm/github-repos.json` and fetched again after 10 minutes. The chat
  starts at once; messages wait until the repo is in.
- **Unused clone chat (owner, 2026-10-29):** leaving it keeps it only while
  the clone runs or failed. Once the repo is in, leaving an unused one
  removes it and keeps the folder; going back starts a chat in that folder,
  without a second clone.
- **Prove (driven 2026-10-15):** without `--real` it shows the signed-out
  screen. With `up --real` (owner's list, read only), clone a public repo
  into the scratch folder:
  ```sh
  $V up --real; $V open --desktop; $V click "New chat"; $V key Enter
  $V click "Copy from GitHub"; $V click "Search repos"; $V type "expressjs/express"
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
  "Agent defaults"` shows rows for "Devin · fake" and "Devin · fake-ask".
- **Traps:** "Set default" is separate from this chat's model; on a phone
  it shows only on the chosen row. The model list can be up to ten minutes
  old, with no refresh button yet. Without an approved list the picker
  shows only the newest of each line (`modelShelf.ts`); devin's
  "-high-fast" ids fold into one row plus thinking and speed chips.
- **Catalog refresh:** every provider returns the usable list while it
  refreshes, marks that work, and lets open menus receive the completed
  account list. Public fetches include the account rebuilds they start.
  One account never waits for another account's CLI. A failed refresh keeps
  the usable list until the next expiry; a lost follow-up retries. Chat,
  defaults, helpers, brain and task transfer menus use the same flow.
  Open menus check again after ten minutes, including after a failed request.
  Codex first serves its newest valid disk cache, then runs `debug models`
  to refresh the account list. `app-server model/list` is a fallback because
  it can return old bundled rows before online discovery finishes.
  Do not pin `model_catalog_json` in Codex settings: it stops online refresh.
  Prove with a private CLI stub: open Agent defaults with an old list,
  release a held model reply with a new name, and check that the new name
  appears without leaving the page. Check phone and desktop sizes.
- **Tests:** `test/model-shelf`, `test/alias-accounts`, `native-account`, `profiles-refresh`,
  `engines`, `discover-wrapper`, `models`, `models-refresh`, `model-prefs`,
  `model-follow`, `project-settings`, `session-settings`;
  `test/browser/models`, `effort-default`.
