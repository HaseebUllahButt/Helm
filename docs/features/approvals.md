# Approvals, questions and alerts

Pick **fake-ask** in New chat: every message asks to run `echo hi` first.

## Tool approval card
- **Prove (driven 2026-10-15):**
  ```sh
  $V click "Ask anything"; $V type "please ask"; $V click send
  $V wait "TOOL APPROVAL"; $V click Approve; $V wait "done."
  ```
  Decline: send again, `$V wait "TOOL APPROVAL"; $V click Decline`.
- **Proof:** Approve: the card goes and the reply shows. Decline: "You
  stopped this task." and **Continue**.
- **Traps:** "Always allow" is remembered by the agent, not by Helm, and the
  fake agent asks every time, so it cannot prove it.
- **Tests:** `test/browser/composer-card`, `child-requests`;
  `test/local-answer`, `driver-acp`, `driver-claude`, `driver-codex`.

## Questions
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
  $V click "Ask anything"; $V type "need me"; $V click send; $V wait "TOOL APPROVAL"
  $V click Back                       # repeat until text starts with "helm"
  $V click "Review and allow"; $V click Approve; $V wait "done."
  ```
- **Tests:** `test/browser/sidebar-shelves`, `chat-home`; `test/seen-sync`.

## Alerts
- **Not yet driven;** the hidden browser blocks notifications. For the
  in-app pop-up, leave a fake-ask chat waiting and open a second chat.
- **Traps:** a tap can be lost while the app shows its sign-in screen.
- **Tests:** `test/notify`, `desktop-notify`, `notification-route`, `push`;
  `test/browser/git-notifications`.
