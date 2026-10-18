# Rewind: Edit from here, Branch from here

Design: [`docs/rewind.md`](../rewind.md). Neither works with the fake agent
(Devin), so nothing here was driven. A real Claude or Codex chat costs
money; use a small one you made and delete it after.

## Edit from here
- **Not yet driven.** In a quick Claude chat send two messages, click "Edit
  from here" on the second, confirm. `rpc session.rewind-check` says whether
  files can be restored.
- **Proof:** the second message and its reply are gone; its text is back
  in the box; nothing new was sent.
- **Traps:** file restore needs the chat's own git worktree; the main
  checkout and shared folders are refused.
- **Tests:** `test/rewind`; `test/browser/rewind`.

## Branch from here
- **Not yet driven.** Claude only. Proof: a new chat in Home holding only
  the earlier messages; the original is untouched.
- **Traps:** the branch's cost line starts from the original's total; it is
  not a new charge.
- **Tests:** `test/session-fork`; `test/browser/rewind`.
