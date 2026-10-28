# Sidebar, shelves, search and the brain

On a phone the sidebar is the Home screen. To get there, press `click Back`
until `text` starts with "helm / Search anything".

## Home (computer)
- **Rules (owner, 2026-10-27):** the helm logo top left is the way home. A
  wide screen opens on the first machine once; after that no machine is
  picked by itself. Home is a quick-chat box and one plain row per machine
  (no cards: chats stay in the sidebar). The box starts on the machine open
  before Home and has the message box's chips: machine, agent, model,
  thinking, permissions. Enter starts the quick chat at once and sends the
  text when the agent is up (`sendWhenReady`). A chip's list drops under the
  box, so the box never moves.
- **Prove (driven 2026-10-27):** `open --desktop`, `$V click Home`, open the
  agent chip, pick `fake-ask`, set permissions to Read only, type, Enter:
  the chat opens with the text and its chip says "read". With `up --real`
  the model and thinking chips list the account's models; start nothing.

## Folded sidebar (computer only)
- **Prove (driven 2026-10-17):** `open --desktop`, start a fake-ask chat and
  a fake-slow chat, `click "collapse sidebar"`, then
  `eval '[...document.querySelectorAll(".side-rail button")].map(b=>b.ariaLabel)'`.
- **Proof:** "…, needs you" and "…, working" tiles; clicking the amber one
  shows TOOL APPROVAL.

## Home shelves
- **Rules:** the owner calls the shelf of recently finished chats
  "Settled". The sidebar shows live and Helm-known chats only, on purpose.
- **Rules (owner, 2026-10-28, idea A):** a Settled chat is one line: the
  agent logo, the title, and one status (its age, a green dot when not
  opened yet, "Needs you" or "Failed"). A Running chat has its status dot
  before the title, so the title gets the whole line; the second line has
  the agent logo, folder, machine, branch and the clock. A
  machine shows a word only for news ("2 running", or the age when
  offline). The top bar shows only the dot while connected. Shelf headers
  have no divider lines.
- **Rules (owner, 2026-10-24):** a CLI opened in a terminal with nothing
  said in it is in neither Running nor Settled. It joins at its first
  message. The machine marks it `blank` until then.
- **Prove (driven 2026-10-24):** launch `helm-native-cli.js claude <fake
  program>` with the copy's `HELM_DIR` and `XDG_RUNTIME_DIR` (no
  `HELM_NATIVE_BYPASS`): no row. Send its `UserPromptSubmit` hook with
  `sendHook`: it shows under Running. Send `Stop`: it moves to Settled.
- **Prove (driven 2026-10-15):** finish one fake chat, then
  `$V click Back; $V text | head -14`: your chat under "Settled" with its
  age.
- **Traps:** with `up --real`, Settled also holds the owner's real Claude
  chats (they arrive through Claude hooks), including the one running this
  check.
- **Rules:** a machine sends a chat update only when it changes what the
  app holds. Status goes at once; counter-only changes share one update
  per chat per 0.5 s (`session-updates.js`).
- **Tests:** `test/browser/sidebar`, `sidebar-shelves`, `sidebar-metadata`,
  `offline-cache`; `test/seen-sync`, `inventory`, `inventory-active`,
  `session-updates`.

## Rename, archive, delete
- **Sees:** each row has a ⋯ button ("actions for <title>") with **Rename
  thread**, **Archive thread**, **Delete thread**. Delete asks: "Delete
  "<title>"? This ends the agent and permanently removes the thread from
  helm." with **Cancel** / **Delete**. Archived chats fold under
  "ARCHIVED" on the machine screen. The chat's own ⋯ menu ("more") has the
  same items plus "Unarchive thread".
- **Prove (driven):**
  ```sh
  $V click "actions for <title>"; $V click "Rename thread"
  $V key Control+a; $V type "my new name"; $V key Enter
  $V click "actions for my new name"; $V click "Archive thread"
  $V click "actions for <other>"; $V click "Delete thread"; $V click "Delete"
  ```
- **Proof:** the new name; the machine screen shows "ARCHIVED 1"; the
  deleted chat is gone. Only do this to chats you made.
- **Delete key (owner, 2026-10-26):** Delete asks to delete the open chat,
  or the sidebar row that has focus; only Enter (or the button) says yes.
  A second Delete never says yes (owner, 2026-10-27: a double press lost
  two chats). It never takes a key you type: only outside a text box or in an empty
  message box, and never in a terminal (`deleteKey`, chatKeys.ts). Prove
  (driven 2026-10-26): open a chat, empty its box, `$V key Delete`; the
  question names that chat; `$V key Delete` again and it stays; `$V key
  Enter` and it is gone.
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
  copy its row's tooltip says "verify-<you> · Pick an account".
- **Traps:** it asks permission for every Helm command, reads included. It
  stays on the VM and never moves to a laptop. Deleting it drops what it
  learned.
- **Tests:** `test/brain`, `network-brain`.
