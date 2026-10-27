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
- **Prove (driven, except Snooze):** in a fake-ask chat:
  ```sh
  $V click "Ask anything"; $V type "need me"; $V click send; $V wait "Command approval"
  $V click Back                       # repeat until text starts with "helm"
  $V click "Review and allow"; $V click Approve; $V wait "done."
  ```
- **Tests:** `test/browser/sidebar-shelves`, `chat-home`; `test/seen-sync`.

## Alerts
- **Rules:** the pop-up and system notices lead with the chat's name. Only a
  command shown whole gets "Allow once" in the pop-up; anything cut, a file
  change or a tool opens the chat. A system notice may carry a question or
  the first line of a finished reply, never a command, address or path.
- **Prove the pop-up (driven):** open one chat, then start another with
  `$V rpc session.start` in `"mode":"default"` on a Claude account whose
  `cmd` replays a fixture with a Bash `can_use_tool` (copy
  `test/fixtures/claude/always.ndjson` and change the tool), and send it a
  message with `$V rpc session.input`. It closes after 12 s.
- **Not driven:** system notices; the hidden browser blocks them.
- **Traps:** a tap can be lost while the app shows its sign-in screen.
- **Tests:** `test/notify`, `desktop-notify`, `notification-route`, `push`;
  `test/browser/git-notifications`.
