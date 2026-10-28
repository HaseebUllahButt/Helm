# Approvals, questions and alerts

Pick **fake-ask** in New chat: every message asks to run `echo hi` first.

## Tool approval card
- **Prove (driven 2026-10-15):**
  ```sh
  $V click "Ask anything"; $V type "please ask"; $V click send
  $V wait "Command approval"; $V click Approve; $V wait "done."
  ```
  Decline: send again, `$V wait "Command approval"; $V click Decline`.
- **Proof:** Approve: the card goes and the reply shows. Decline: the turn
  says "stopped".
- **Traps:** "Always allow" is remembered by the agent, not by Helm, and the
  fake agent asks every time, so it cannot prove it.
- **Notes:** Approve can run the step before the agent reads the note.
  Decline to request a change. Helm sends the note as the next owner message
  when the agent cannot take text with its answer. Claude decline already takes the note.
- **Tests:** `test/browser/composer-card`, `child-requests`;
  `test/local-answer`, `driver-acp`, `driver-claude`, `driver-codex`.

## Codex reviews
- **Rule:** Select **Codex reviews** for one chat. Keep the existing defaults
  for new chats and helpers. Use the same project limits as **Ask before acting**.
- **Proof:** In a private copy, use a fake Codex account that emits
  `item/autoApprovalReview/started` and `item/autoApprovalReview/completed`.
  Select the mode, send a message, and open the steps. Check **Codex approved**.
  A denied step shows its reason and **Allow anyway**. Press it and check that
  `thread/approveGuardianDeniedAction` receives the same action and chat ID.
- **Trap:** **Allow anyway** permits one retry. It does not mean the action ran.
  A denial is already final for that attempt, so its card must not stop a live turn.
- **Tests:** `test/driver-codex`, `native-codex`, `modes`, `session-settings`,
  `events`; `test/browser/codex-review`.

## Questions
- **Keys:** Ctrl/⌘+Alt+1 through 9 choose an answer. Ordinary digits remain
  text, including in an empty composer. AltGraph remains a typing key.
- **Answers:** keep the selected answers as a list for Codex. Keep the
  joined text for older agents. A comma inside one answer never creates
  another answer in updated Codex copies.
- **Not yet driven;** the fake agent never asks questions, so use a real
  chat you made. To look at the card alone, run `test/browser/composer-card`
  with `HELM_TEST_SCREENSHOT_DIR` set. Several questions are sent only when
  all are answered.
- **Traps:** Codex deny and question paths were built from its docs and are
  not yet seen live.
- **Tests:** `test/driver-claude`, `driver-codex`, `native-claude-chat`.

## "Needs you" on Home
- **Rules (owner, 2026-10-28):** no yellow for "needs you" anywhere; it is
  white (`--need`). Yellow stays for warnings. A waiting chat is a plain row
  with a white dot that breathes three times, then stays still (endless
  motion redraws the window); its second line says what it wants.
  Snooze and "Dismiss failure" sit behind the row's ⋯. A row with a request
  opens the waiting box; a failure opens the chat.
- **Prove (driven 2026-10-28):** start two fake-ask chats with
  `$V rpc session.start` and `session.input`, then
  `$V click "<title>"` in the sidebar: the box opens with "2 of 2".
- **Tests:** `test/browser/sidebar`, `sidebar-shelves`, `chat-home`; `test/seen-sync`.

## The waiting box
- **Rules (owner, 2026-10-28):** every waiting chat except the open one is
  in one black box at the top centre (`WaitingIsland.tsx`). Closed it is a
  pill: the first chat and "+n". A chat that starts waiting opens it for
  12 s without a dimmed screen and without keys. Opened by a click, it dims
  the screen and takes keys: Ctrl+Enter says yes, Ctrl+1..9 or
  Ctrl+Alt+1..9 answers, Esc closes. A command, plan or tool is answered
  there; a single one-choice question shows its answers; a file change and
  anything else open the chat. After an answer the next chat comes in.
  Titles lead, scrubbed of links and paths. A system notice may carry a
  question or the first line of a finished reply, never a command, address
  or path.
- **Prove (driven 2026-10-28):** with two fake-ask chats waiting, click a
  sidebar row, `$V key Control+Enter`, `$V wait Allowed`: the other chat
  slides in; `$V click "Allow once"` and the box goes.
- **Not driven:** questions in the real app (the fake agent never asks);
  `test/browser/waiting-island` covers them. System notices: the hidden
  browser blocks them.
- **Traps:** a tap can be lost while the app shows its sign-in screen.
- **Tests:** `test/notify`, `desktop-notify`, `notification-route`, `push`;
  `test/browser/waiting-island`, `git-notifications`.
