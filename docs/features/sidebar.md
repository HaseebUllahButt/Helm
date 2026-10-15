# Sidebar, shelves, search and the brain

On a phone the sidebar is the Home screen. To get there, press `click Back`
until `text` starts with "helm / Search anything".

## Home shelves
- **Sees:** top to bottom: "Search anything", "New chat", "Helm brain",
  then shelves: **Needs you**, **Snoozed**, **Working**, **Settled** (chats
  that replied lately and are not running, with "N new"), and **Machines**.
  Each shelf folds; "Show 25 more" pages Settled.
- **Prove (driven 2026-10-15):** finish one fake chat, then go Home.
  ```sh
  $V click Back; $V text | head -14     # "Settled", your chat title, "1m ago"
  ```
- **Proof:** your chat sits under "Settled" with its title and age.
- **Traps:** Settled also fills with the owner's real Claude chats (they
  arrive through Claude hooks), including the chat running this check. The
  owner calls the shelf "Settled". The sidebar shows live and Helm-known
  chats only, on purpose.
- **Tests:** `test/browser/sidebar`, `sidebar-shelves`, `sidebar-metadata`,
  `offline-cache`; `test/seen-sync`, `inventory`, `inventory-active`.

## Rename, archive, delete
- **Sees:** each row has a ⋯ button ("actions for <title>") with **Rename
  thread**, **Archive thread**, **Delete thread**. Delete asks: "Delete
  "<title>"? This ends the agent and permanently removes the thread from
  helm." with **Cancel** / **delete**. Archived chats fold under
  "ARCHIVED" on the machine screen. The chat's own ⋯ menu ("more") has the
  same items plus "Unarchive thread".
- **Prove (driven):**
  ```sh
  $V click "actions for <title>"; $V click "Rename thread"
  $V key Control+a; $V type "my new name"; $V key Enter
  $V click "actions for my new name"; $V click "Archive thread"
  $V click "actions for <other>"; $V click "Delete thread"; $V click "delete"
  ```
- **Proof:** the new name in the list; the archived chat leaves Settled and
  the machine screen shows "ARCHIVED 1"; the deleted chat is gone.
- **Traps:** `text` sometimes misses an open menu; take a `shot`. Only do
  this to chats you made.
- **Tests:** `test/browser/ui` (confirm box); `test/delete-stays-deleted`,
  `titles`, `slash-title`.

## Search and the palette
- **Sees:** "Search anything" finds chats, machines and folders. The
  palette also lists actions: New chat, Quick chat, Settings, Updates,
  Devices & pairing, What it has cost, CLI defaults, Public links, themes,
  Keyboard shortcuts.
- **Reach:** the search box, Ctrl/⌘+K, or "/" when not typing. "?" shows
  the key list.
- **Prove (driven):**
  ```sh
  $V key Control+k; $V text | tail -15; $V key Escape
  $V key "?"; $V text | tail -30; $V key Escape
  ```
- **Proof:** the action list above; "?" shows "This list", "IN THE NEW-CHAT
  BOX", "IN A CHAT".
- **Traps:** search results include real chats from this machine.
- **Tests:** `test/browser/ui`, `global-keys`; `test/palette`.

## Machine screen
- **Sees:** the machine's name and link ("direct · 27ms" or "via home"),
  **New chat**, **Send a project**, **Connectors & skills**, recent chats,
  "ELSEWHERE", "ARCHIVED", "Add a project shortcut", and header buttons
  **terminal**, "what <machine> has cost", "<machine> settings".
- **Prove (driven):** `$V click "verify-<you> idle"` from Home (the row's
  text, joined by a space).
- **Traps:** a sleeping machine's screen is empty, not its last list.
- **Tests:** `test/browser/sidebar`; `test/machine-kind`.

## Helm brain
- **Sees:** a "Helm brain" row on Home (one per machine). It keeps a map of
  machines and folders and can work on any of them. "Start a different
  brain" swaps it. Deleting it drops what it learned.
- **CLI:** `helm brain [--account <id>]`, `helm digest [--json]`.
- **Prove:** steps not yet driven. In the private copy the row says
  "verify-<you> · Choose an account"; starting it with a real account costs
  money.
- **Traps:** it asks permission for every Helm command, reads included. It
  stays on the VM and never moves to a laptop.
- **Tests:** `test/brain`, `network-brain`.
