# Helpers and subagents

A helper (subagent) is a second chat started by a chat, on any account. It
shows as a card inside its parent, never as its own row in Working.

## Start a subagent from the app
- **Sees:** chat header **Agents** button → an "Agents" sheet (no tabs; Git
  and Browser have their own header buttons). It has a **Task** box, account / model / permission chips, "Works
  in this thread's folder", and **Start subagent**. Running ones list under
  "ACTIVE" with their own approval card (**Allow**, **Always allow**,
  **Deny**), "Message subagent", "Open conversation", "Stop subagent".
  Finished ones move to "FINISHED" with "Hide task".
- **Reach:** **Agents** in the chat header, or Ctrl/⌘+Shift+A.
- **Prove (driven 2026-10-15):** in a fake-ask chat:
  ```sh
  $V click Agents; sleep 3                  # wait past "Finding accounts…"
  $V click "Task"; $V type "my child task"; $V click "Start subagent"
  $V wait "Needs approval"; $V click Allow; $V wait "FINISHED"
  ```
- **Proof:** "ACTIVE 1" with "my child task · fake-ask · CLI default" and
  "Needs approval", then "FINISHED 1", "Finished", "working on it done.".
- **Traps:** the account starts as the parent's ("Fake agent (asks)"). The
  child's result is sent back to the parent, which starts a new parent turn;
  with fake-ask the parent then asks for approval again. Close the sheet with
  "Close thread details"; Back alone may not leave it.
- **Tests:** `test/browser/subagents`, `orchestration`, `child-requests`,
  `todos`; `test/delegation`, `task-return`, `subagent-usage`.

## `helm delegate` from a terminal
- **Sees:** the helper appears as a card in the chat that ran the command.
- **CLI:** `helm delegate <account> --model <id> --wait --json -- "<task>"`,
  `helm delegate-result <id> [--wait] [--json]`. `--cwd <folder>` picks the
  folder; `--worktree` gives it its own copy of the repo on a `helm/` branch.
  Exit codes: 0 done, 1 failed, 2 needs approval, 3 wait timed out.
- **Prove:** steps not yet driven against the private copy. Try, with a
  chat id from the private copy:
  `env HELM_SESSION_ID=<chat-id> HELM_DIR=/tmp/helm-verify-<you>/helm node
  packages/connect/bin/helm.js delegate fake --wait --json -- "hi"`.
- **Proof:** JSON with `"status": "done"` and the reply in `"output"`.
- **Traps:** never unset `HELM_SESSION_ID` for real helpers (they would show
  as separate chats). Helpers sharing a folder can clash; use `--worktree`.
  A finished helper frees its process after 30 s idle and resumes on a
  follow-up. The "no nested CLI" rule is a request, not a lock.
- **Tests:** `test/delegation`, `spawn-cli`, `cli-subagents`.

## The CLIs' own subagents
- **Sees:** Claude's own helpers in the Agents tab, marked native and
  read-only: "Finished", or "Stopped" after ten quiet minutes.
- **Prove:** steps not yet driven; needs a real Claude chat that starts a
  Task.
- **Tests:** `test/native-subagents`, `cli-subagents`;
  `test/browser/subagents`.

## Team summary
- **Sees:** a parent with children shows their model, state, time and a
  short result; a failed child puts the parent in "Needs you" with
  "Dismiss failure".
- **Prove:** steps not yet driven.
- **Tests:** `test/browser/orchestration`, `child-requests`.
