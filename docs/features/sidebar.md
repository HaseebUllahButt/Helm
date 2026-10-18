# Sidebar, shelves, search and the brain

On a phone the sidebar is the Home screen. To get there, press `click Back`
until `text` starts with "helm / Search anything".

## Folded sidebar (computer only)
- **Prove (driven 2026-10-17):** `open --desktop`, start a fake-ask chat and
  a fake-slow chat, `click "collapse sidebar"`, then
  `eval '[...document.querySelectorAll(".side-rail button")].map(b=>b.ariaLabel)'`.
- **Proof:** "…, needs you" and "…, working" tiles; clicking the amber one
  shows TOOL APPROVAL.

## Home shelves
- **Rules:** the owner calls the shelf of recently finished chats
  "Settled". The sidebar shows live and Helm-known chats only, on purpose.
- **Prove (driven 2026-10-15):** finish one fake chat, then
  `$V click Back; $V text | head -14`: your chat under "Settled" with its
  age.
- **Traps:** with `up --real`, Settled also holds the owner's real Claude
  chats (they arrive through Claude hooks), including the one running this
  check.
- **Tests:** `test/browser/sidebar`, `sidebar-shelves`, `sidebar-metadata`,
  `offline-cache`; `test/seen-sync`, `inventory`, `inventory-active`.

## Rename, archive, delete
- **Prove (driven):**
  ```sh
  $V click "actions for <title>"; $V click "Rename thread"
  $V key Control+a; $V type "my new name"; $V key Enter
  $V click "actions for my new name"; $V click "Archive thread"
  $V click "actions for <other>"; $V click "Delete thread"; $V click "delete"
  ```
- **Proof:** the new name; the machine screen shows "ARCHIVED 1"; the
  deleted chat is gone. Only do this to chats you made.
- **Tests:** `test/browser/ui`; `test/delete-stays-deleted`, `titles`,
  `slash-title`.

## Continue in a new chat
- **Prove (driven):** on a finished chat in a folder,
  `$V click "actions for <title>"; $V click "Continue in a new chat"; $V click "fake"`.
- **Proof:** a new chat in the same folder, its box holding
  "Run `helm pickup <id>` first."; a working chat's ⋯ does not offer it.

## Search, palette, machine screen
- **Prove (driven):** `$V key Control+k; $V text | tail -15; $V key Escape`
  lists actions; `$V key Control+Slash` shows "IN THE NEW-CHAT BOX", "IN A
  CHAT". `$V click "verify-<you> idle"` opens the machine screen.
- **Said in chats (driven 2026-10-18):** words typed in the box (two or more
  letters) are looked for inside every online machine's chats once typing
  pauses. Prove: send "the pelican flies at dawn" in a fake chat, wait
  "done.", `$V click "Search anything"; $V type pelican; $V wait "SAID IN CHATS"` (the group label is drawn in capitals):
  the chat's row shows "You: the pelican flies at dawn"; Enter opens it.
  A chat whose title already matched is not repeated. From a terminal,
  `$H search pelican` prints the same chat with the sentence. Each machine
  answers from `~/.helm/search-index.json` (`search-index.js`); the first
  search after an install reads every chat log once.
- **Traps:** the agent's reply is indexed when it finishes, not while it
  streams. Helpers, the brain and terminals are never found.
- **Traps:** a sleeping machine's screen is empty, not its last list.
- **Tests:** `test/browser/ui`, `global-keys`, `sidebar`, `palette-search`;
  `test/palette`, `machine-kind`, `search-index`.

## Helm brain
- **Not yet driven;** starting it with a real account costs money. In the
  copy its row says "verify-<you> · Choose an account".
- **Traps:** it asks permission for every Helm command, reads included. It
  stays on the VM and never moves to a laptop. Deleting it drops what it
  learned.
- **Tests:** `test/brain`, `network-brain`.
