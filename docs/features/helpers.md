# Helpers and subagents

A helper (subagent) is a second chat started by a chat, on any account. It
shows as a card inside its parent, never as its own row in Working.

## Start a subagent from the app
- **Reach:** **Agents** in the chat header, or Ctrl/⌘+Shift+A.
- **Prove (driven 2026-10-15):** in a fake-ask chat:
  ```sh
  $V click Agents; sleep 3                  # wait past "Finding accounts…"
  $V click "Task"; $V type "my child task"; $V click "Start subagent"
  $V wait "Needs approval"; $V click Allow; $V wait "FINISHED"
  ```
- **Proof:** "ACTIVE 1" with "my child task · fake-ask · CLI default", then
  "FINISHED 1" and "working on it done.".
- **Traps:** the child's result starts a new parent turn, so fake-ask asks
  again. Close the sheet with "Close thread details"; Back may not.
- **Tests:** `test/browser/subagents`, `orchestration`, `child-requests`,
  `todos`; `test/delegation`, `task-return`, `subagent-usage`.

## `helm delegate`
- **Not yet driven** against the copy. Try
  `env HELM_SESSION_ID=<chat-id> HELM_DIR=/tmp/helm-verify-<you>/helm node
  packages/connect/bin/helm.js delegate fake --wait --json -- "hi"`: JSON
  with `"status": "done"` and the reply in `"output"`.
- **Traps:** never unset `HELM_SESSION_ID` for real helpers (they would show
  as separate chats). Helpers sharing a folder can clash; use `--worktree`.
  A finished helper frees its process after 30 s idle and resumes on a
  follow-up. The "no nested CLI" rule is a request, not a lock.
- **One result per task:** once the parent has the result, a helper that
  wakes by itself later (a background watcher timing out) never gives the
  parent another turn. Those relays were nearly all "stale watcher, nothing
  changed". Real news goes by `helm say`; the helper's brief says so.
- **Tests:** `test/delegation`, `spawn-cli`, `cli-subagents`.

## The CLIs' own subagents
- **Not yet driven;** needs a real Claude chat that starts a Task. They show
  read only, "Stopped" after ten quiet minutes. A failed child puts the
  parent in "Needs you".
- **Tests:** `test/native-subagents`, `cli-subagents`;
  `test/browser/subagents`, `orchestration`.

## Messages between agents
- **Reach:** Agents → **Messages between agents**. In a chat: `helm say
  <chat-id> -- "q"`, `helm reply <message-id> -- "a"`, `helm messages
  --json`. Outside a chat `helm say` is a plain owner message.
- **Rules:**
  - Only the message travels, not history. It waits for the next turn and
    never interrupts. It does not also wake the parent with a result. No
    automatic replies.
  - Retry an unconfirmed send with the same `--message-id`, recipient and
    text; the receipt stops a duplicate. "Delivered" means accepted, not
    read. Stopped or archived agents are not woken.
  - `helm messages` in the agent's own chat, or `helm delegate-result` for
    that helper's replies, marks them read and removes their waiting copies;
    looking at the panel does not. The same reply to the same question is
    reused even with a new message id.
  - Helm-managed chats on paired machines only; older daemons keep the old
    view.
- **Prove:** a fake parent and two fake helpers; `helm say` as one,
  `helm reply` as the other (private `HELM_DIR`, each helper's
  `HELM_SESSION_ID`). The parent's Agents panel shows both once, with the
  reply link, and no extra parent turn.
- **Read-once proof (driven 2026-10-18):** `fake-slow` parent, `fake`
  helper, five `session.agent-send` replies: the composer shows "5
  waiting". `session.delegation-result` with the owning `parentId` and
  `consume:true` returns all five and clears them; a second call returns
  none.
- **Tests:** `test/agent-messages`, `input-delivery`, `delegation`;
  `test/browser/agent-messages`, `subagents`.
