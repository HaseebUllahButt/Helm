---
name: pause-and-pickup
description: Stop Helm work at a clean point and leave a short note the next agent can act on, or pick up where another session left off. Use when the owner says stop, pause, hand over, write the report or handoff, wrap up, or asks to continue, resume or pick up earlier work.
---

# Pause and pick up

HANDOFF.md holds open work only: short notes the next agent can act on in a
minute. What was done belongs in commit messages, which `git log` keeps.

## Pause

1. **Stop at a clean point.** Finish or undo the half-made edit. Nothing
   half-applied stays in the tree: another agent's commit may sweep it up.
2. **Commit what is verified,** by path (`git commit -- <files>`), after
   checking `git status` for files that are not yours. Leave unverified work
   uncommitted and say so in the note.
3. **Clean up what you started:** private Helm copies
   (`node scripts/verify-helm.mjs down`), helpers you no longer need, test
   chats, spins (`helm share stop <name>`).
4. **Write the note** at the top of the "Open" list in HANDOFF.md, at most
   8 lines: what is left, uncommitted files and their state, the first thing
   to do next, and any trap that will cost time again. Do not list what is
   done. If an older note covers the same work, rewrite it; delete notes
   whose work you finished.
5. **Tell the owner** in two or three plain sentences what is done, what is
   not, and what comes next.

## Pick up

1. Read only the newest note in HANDOFF.md, not the whole file.
2. `git log --oneline <note's last commit>..HEAD` and `git status`: what
   changed since, and what is uncommitted (it may belong to an agent still
   working - `helm digest` shows who is running).
3. If the owner names the previous chat, `helm thread <id>` shows its last
   messages.
4. Check before trusting: re-run what the note calls proven if your work
   builds on it (`verify-helm` for anything the owner sees).
5. Start with the note's next step, unless the owner asked for something
   else. Delete the note when its work is done.
