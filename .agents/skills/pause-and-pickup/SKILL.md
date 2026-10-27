---
name: pause-and-pickup
description: Stop Helm work at a clean point, or continue earlier work. Use when the owner says stop, pause, hand over, wrap up, or asks to continue, resume, pick up or take over earlier work.
---

# Pause and pick up

There is no handoff file. Commits hold what was done; your final reply
holds what is left. Helm keeps both, and `helm pickup` reads them back.

## Pause

1. **Stop at a clean point.** Finish or undo the half-made edit.
2. **Commit what is verified,** by path, after reading `git status`.
   Leave unverified work uncommitted.
3. **Clean up what you started:** private Helms
   (`node scripts/verify-helm.mjs down`), helpers, test chats, spins.
4. **End with a short reply:** what is done, then a "Left:" part with what
   is not, uncommitted files, the first next step, and any trap.

## Pick up

1. `helm pickup` (or `helm pickup <chat-id>`): the earlier chats here, what
   they left, commits since, uncommitted files, and chats running now.
2. `helm thread <id>` shows more of one chat. Treat what it left as context,
   not proof: check the code, and re-run what it calls proven if your work
   builds on it. Do not keep its approach only because it is already built.
3. Keep its commits and their authors. Add your fixes as new commits.
4. Leave files a running chat is editing alone; `helm say <id>` asks it.
