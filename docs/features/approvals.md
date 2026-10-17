# Approvals, questions and alerts

Use the "Fake agent (asks)" account: pick **fake-ask** in New chat. Every
message it gets asks to "Run a command" (`echo hi`) before it answers.

## Tool approval card
- **Sees:** a card above the box: "TOOL APPROVAL · Run a command", what it
  wants to run, a note field, and **Approve**, **Always allow**, **Decline**.
  The box says "Decide above, or reply instead". The header shows "waiting".
- **Reach:** appears by itself. Card types: command, file change, tool,
  plan, question.
- **Prove (driven 2026-10-15):**
  ```sh
  $V click "Ask anything"; $V type "please ask"; $V click send
  $V wait "TOOL APPROVAL"; $V click Approve; $V wait "done."
  ```
  Decline: send again, `$V wait "TOOL APPROVAL"; $V click Decline`.
- **Proof:** Approve: the card goes and "working on it done." shows. Decline:
  "Task stopped", "You stopped this task." and **Continue**.
- **Traps:** "Always allow" is remembered by the agent, not by Helm, and the
  fake agent asks every time, so it cannot prove "Always allow". There is no
  stop button while a card waits.
- **Tests:** `test/browser/composer-card`, `child-requests`;
  `test/local-answer`, `driver-acp`, `driver-claude`, `driver-codex`.

## Questions (pick an answer)
- **Sees:** a "Question" card: the question in large type, then the
  answers as one numbered list with thin lines between them. Hovering a row
  turns its number violet and shows an arrow; a tap is the answer. Pick-many
  questions show a tick box on the right and a Send button. On a keyboard the
  number is the key. A request with several questions is sent only when all
  are answered.
- **Look without a real chat:** `test/browser/composer-card` draws the card
  with screenshots when `HELM_TEST_SCREENSHOT_DIR` is set.
- **CLI:** in a terminal chat, `/allow`, `/always`, `/deny`,
  `/answer <n> <choice>`.
- **Prove:** steps not yet driven. The fake agent never asks questions; it
  needs a real Claude or Codex chat you made.
- **Traps:** Codex deny and question paths were built from its docs and are
  not yet seen live.
- **Tests:** `test/driver-claude`, `driver-codex`, `native-claude-chat`.

## "Needs you" on Home, and Snooze
- **Sees:** a "Needs you" shelf at the top of Home with a card: "NEEDS YOU ·
  JUST NOW", the chat title, machine, what it wants ("Run a command"),
  **Review and allow** and **Snooze…**. Snoozed chats move to "Snoozed" and
  come back at the chosen time; Undo shows for a few seconds.
- **Prove (driven, except Snooze):**
  ```sh
  # in a fake-ask chat:
  $V click "Ask anything"; $V type "need me"; $V click send; $V wait "TOOL APPROVAL"
  $V click Back                       # repeat until text starts with "helm"
  $V text | head -16                  # "Needs you", "Review and allow", "Snooze…"
  $V click "Review and allow"; $V click Approve; $V wait "done."
  ```
- **Proof:** the card on Home; "Review and allow" opens the chat on its card.
- **Tests:** `test/browser/sidebar-shelves`, `chat-home`; `test/seen-sync`.

## Alerts: pop-ups, desktop and phone
- **Sees:** a pop-up over the open screen when another chat waits ("… needs
  your OK", "has a question"); it leaves after 9 s. A desktop notice, and a
  phone push for approval requests; tapping opens the chat. Chat ⋯ menu →
  "Turn completion alerts off/on".
- **Prove:** steps not yet driven. The hidden browser blocks notifications
  (Settings says "Notifications are blocked for this site"). To see the
  pop-up, leave a fake-ask chat waiting and open a second chat.
- **Traps:** Chromium's own pop-ups are plain; Helm has its own notifier.
  A tap can be lost while the app shows its sign-in screen.
- **Tests:** `test/notify`, `desktop-notify`, `notification-route`, `push`;
  `test/browser/git-notifications`.
