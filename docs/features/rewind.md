# Rewind: Edit from here, Branch from here

Full design: `docs/rewind.md`. Neither works with the fake agent (Devin),
so nothing here was driven. A real Claude or Codex chat costs money; use a
small one you made and delete it after.

## Edit from here
- **Sees:** on one of your past messages in an idle Claude or Codex chat,
  **Edit from here**. It removes that message and everything after, and puts
  your words, images and @ chats back in the box. A confirm box offers
  conversation only (default) or also restoring files.
- **Reach:** the message's actions in the chat. `rpc session.rewind-check`
  says whether files can be restored.
- **Prove:** steps not yet driven. In a quick Claude chat: send two
  messages, click "Edit from here" on the second, confirm.
- **Proof:** the second message and its reply are gone; its text is back
  in the box; nothing new was sent.
- **Traps:** file restore needs the chat to own its own git worktree; the
  main checkout and shared folders are refused. Imported messages and other
  CLIs do not offer it. Native chats driven by another client are excluded.
- **Tests:** `test/rewind`; `test/browser/rewind`.

## Branch from here
- **Sees:** **Branch from here** on your message starts a new chat as it was
  just before that message; the original chat is untouched.
- **Prove:** steps not yet driven.
- **Proof:** a new chat in Home holding only the earlier messages.
- **Traps:** Claude only. The branch's cost line starts from the
  original's total; it is not a new charge.
- **Tests:** `test/session-fork`; `test/browser/rewind`.
