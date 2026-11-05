# Helpers and subagents

A helper (subagent) is a second chat started by a chat, on any account. It
shows as a card inside its parent, never as its own row in Working.
Every helper has a parent chat: `helm delegate` from a plain shell or through
`helm exec` is refused. Such a helper had no card, no reader for its result,
and a project copy nobody kept. Another machine gets `helm spawn`.

## Start a subagent from the app
- **Reach:** **Agents** in the chat header, or Ctrl/⌘+Shift+A.
- **Prove (driven 2026-10-15):** in a fake-ask chat:
  ```sh
  $V click Agents; sleep 3                  # wait past "Finding accounts…"
  $V click "New task"; $V click "Describe one task"; $V type "my child task"; $V click "Start helper"
  $V wait "Needs approval"; $V click Allow; $V wait "FINISHED"
  ```
- **Proof:** "ACTIVE 1" with "my child task · fake-ask · CLI default", then
  "FINISHED 1" and "working on it done.".
- **Task box:** Enter starts the helper, Shift+Enter makes a new line (on a
  phone Return makes a new line). Paste, drop or the paperclip adds pictures
  and files; they go with the first message. A machine without
  `helperAttachments` gets no paperclip. The helper card has no message box:
  **Open chat** is the way to talk to a helper.
- **Prove pictures (driven 2026-11-06):** pick "Fake agent (sees pictures)",
  paste a picture into the task box, press Enter, then **Open chat**: the
  first message shows the picture. `fake-slow` cannot see pictures and shows
  "this agent cannot see images" instead.
- **Traps:** the child's result starts a new parent turn, so fake-ask asks
  again. Close the sheet with "Close thread details"; Back may not.
- **Tests:** `test/browser/subagents`, `orchestration`, `child-requests`,
  `todos`; `test/delegation`, `task-return`, `subagent-usage`.

## `helm delegate`
- **Prove:** run against the private copy:
  `env HELM_SESSION_ID=<chat-id> HELM_DIR=/tmp/helm-verify-<you>/helm node
  packages/connect/bin/helm.js delegate fake --wait --json -- "hi"`: JSON
  with `"status": "done"` and the reply in `"output"`.
- **Traps:** never unset `HELM_SESSION_ID` for real helpers (they would show
  as separate chats). Helpers sharing a folder can clash; use `--worktree` (its copy ends as
  in git-and-schedules.md, "A worktree per chat").
  A finished helper releases its process after 30 s idle and resumes on a
  follow-up. A Codex helper that shares its parent's context keeps the
  native connection open instead. The "no nested CLI" rule is a request,
  not a lock.
- **One result per task:** once the parent has the result, a helper that
  wakes by itself later (a background watcher timing out) never gives the
  parent another turn. Those relays were nearly all "stale watcher, nothing
  changed". Real news goes by `helm say`; the helper's brief says so.
- **Codex context:** a local helper on the same account, in the same
  folder and on the parent's model can start from its parent's cached
  context. Codex caches per model, so a copy on another model reuses
  nothing and pays full price for the parent's history; that helper starts
  a new chat, and the parent writes the context it needs in the task. A
  model left unset is the account default; the driver reads it before it
  copies. This needs a running
  native Codex daemon. Helm keeps the parent's instructions and puts the
  helper note beside its first task. The helper view shows only its own
  turns. Other accounts, engines, folders and worktrees use a new chat.
  A failed fork also uses a new chat.
- **Restart trap:** an ephemeral fork has no saved Codex history. Helm
  holds one native connection per account on its process host. A Helm
  restart keeps that connection. When Codex loses the fork, Helm starts a
  saved Codex chat from that helper's own tasks, replies and tool results.
  The Helm chat and its visible history stay the same. This recovery can
  need fresh input tokens. After a reboot only a fork with work in flight
  reconnects; a finished one starts at its next message.
- **Proof (driven 2026-10-27):** a private real helper reused cached input,
  kept its Codex chat through a Helm restart and a process-host restart,
  then recovered in the same Helm chat after a private Codex daemon restart.
  Its phone view showed its own three tasks and replies.
- **Tests:** `test/delegation`, `codex-helper-fork`, `driver-codex`,
  `session-driver`, `native-codex`, `spawn-cli`, `cli-subagents`.

## The CLIs' own subagents
- **Which one an agent uses (`delegationNote`):** Claude chats use their own
  Agent tool for short work on the same account. A fork reuses the parent's
  cached context, and a non-fork helper starts smaller than a new chat
  (16.7k against 28k tokens in the 2026-11-06 run). Long or background
  work, another account, tool or machine, and worktrees go to `helm
  delegate`: the owner cannot stop one built-in helper alone, only its
  parent. Codex and every other tool keep `helm delegate`; Codex's own
  child had no cached input (below), and the others are not measured.
- **Claude proof (driven 2026-11-06, real Haiku chat in `verify-helm up
  --real`):** asked for "a helper", the chat used Agent on Haiku. Agents
  showed "Count .conf files in /etc · Finished". A message typed in its
  view was passed on by the parent, and the helper answered, also after
  `verify-helm restart`. Haiku sent `run_in_background` as the string
  "false", so Claude ran it in the background; the parent still waited
  and reported.
- **Messages:** A helper message keeps its delivery number across reconnects.
  The machine saves a receipt before it calls the CLI. A restart during that
  call can leave delivery uncertain. Check the helper, then use **Check the
  previous message** to clear that check. The message may already have arrived.
  Older machines must update before the app can send a helper message.
- **Codex proof (driven 2026-10-27):** a private real chat started one v2
  child with `fork_turns="all"`. Agents showed one finished child. Its
  view showed its own task and "OK" reply, including after a private
  daemon restart. The child's input had no cached tokens, so Helm leaves
  `multi_agent_v2` unchanged. Do not enable it merely because the child
  cards work.
- A failed child puts the parent in "Needs you".
- **Tests:** `test/native-subagents`, `cli-subagents`;
  `driver-codex`; `test/browser/subagents`, `orchestration`.

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
