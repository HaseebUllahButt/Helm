---
name: pause-and-pickup
description: Stop Helm work at a clean point and leave a short note the next agent can act on, or pick up where another session left off. Use when the owner says stop, pause, hand over, write the report or handoff, wrap up, or asks to continue, resume or pick up earlier work.
---

# Pause and pick up

HANDOFF.md is the owner's session report. Old entries were thousands of
words and nobody reads them whole. A new entry is a short note: the next
agent reads it in a minute and knows what is safe to build on.

## Pause

1. **Stop at a clean point.** Finish or undo the half-made edit. Nothing
   half-applied stays in the tree: another agent's commit may sweep it up.
2. **Commit what is verified,** by path (`git commit -- <files>`), after
   checking `git status` for files that are not yours. Leave unverified work
   uncommitted and say so in the note.
3. **Clean up what you started:** private Helm copies
   (`node scripts/verify-helm.mjs down`), helpers you no longer need, test
   chats, spins (`helm share stop <name>`).
4. **Write the note** at the top of HANDOFF.md, under the intro and above the
   newest dated entry, in this shape and no longer than 30 lines:

```markdown
## YYYY-MM-DD - <what this session was for, in a few words>

**Done and proven:** <change> (<commit>) - <what you ran and what you saw>.
**Done, not proven:** <change> - <why it could not be run>.
**Not done:** <what is left>, <uncommitted files and their state>.
**Next:** <the first thing the next agent should do>.
**Decisions:** <choice> - <why> - <what showed it was right>.
**Traps:** <anything that cost time and will cost it again>.
```

   Leave out lines that have nothing. Details belong in commit messages,
   which `git log` keeps next to the code.
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
5. Start with the note's **Next** line, unless the owner asked for something
   else.
