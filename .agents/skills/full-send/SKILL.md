---
name: full-send
description: Finish a change alone, from start to shipped. Use only when the owner says "full send".
---

# Full Send

The owner is not watching this chat. They want the work done end to end. Your
updates and final reply go unread until long after you stop. You own the work
from its current state to shipped.

If the owner did not clearly say "full send", do not assume full autonomy.

The owner grants you permission to:

- Merge into main once the merge gate passes.
- Push main, and install the result as the project's AGENTS.md says. In Helm
  that means every reachable machine.
- Use the test methods that Proof needs, without asking first.

## Testing permission

"Full send" is the permission. If a project file says to ask before a test
method, or to leave testing to the owner, this request replaces that rule for
this task. That includes running the app, browser automation, screenshots and
visual checks. Use the method that gives direct proof. List it in the report.

Rules about how to test still apply: the correct command, fixture, private
copy or check. This permission only removes the ask-first step. It covers only
the tests this task needs. It does not cover the steps under "Asking the
owner".

## Steps

1. **Finish the change.** Complete the goal with the smallest change that
   works. Fix the case that happened, not every case that could. Work in this
   chat's worktree or a branch, never on main.
2. **Prove it.** Get proof for every change. See "Proof".
3. **Get review.** Use the `sol-loop` skill.
4. **Commit** with a message that leads with the problem, not a list of
   changes. Add one line that says how you proved it.
5. **Ship** when the merge gate passes: merge into main, push, install.
6. **Report** in your final reply: the commit, your proof, where it is
   installed, and each decision you made for the owner.

Stay active from step 1 to step 6. Nothing prompts you again after you stop.
Wait for long steps in the foreground.

## Proof

Proof is evidence you saw yourself in this chat: command output, a
reproduction, a screenshot. Use the most direct proof the change allows:

- Reproduce the failure, apply the fix, then watch the same reproduction pass.
- Run the checks the project names (`npm run check` in Helm).
- Add one focused test that fails without the fix, when the behavior has none.
- For screens and runtime behavior, run the app and look (`verify-helm` in
  Helm). Green mocked tests do not prove what the owner sees.

When you cannot prove a change, you do not have full confidence. Ask the owner.

## Merge gate

All of these are true on the latest commit:

- Your proof covers every change in the diff.
- The project's checks pass.
- `sol-loop` agreed, or each open finding has a written reason.
- The branch is up to date with main, and merges without conflict. Resolve
  conflicts by intent, then prove again.

Never skip a check or force-push main.

## Asking the owner

A question in a normal message goes unseen, and the chat looks done. Ask with
your CLI's question tool (`AskUserQuestion` in Claude Code,
`request_user_input` in Codex), so Helm shows the chat as "needs you". Put all
context in the question: what blocks you, and the options with your
recommendation first.

Ask only when you cannot continue alone:

- You cannot prove the change.
- The merge gate cannot pass, and you cannot fix that yourself.
- The next step is outside the grant: deleting data, touching production
  beyond the install, changing things outside the repo, or rewriting history.
- The goal is unclear in a way that changes the result.

Decide everything else yourself with sensible defaults. List those decisions in
the report.

If you have no question tool, or it returns no answer, take the safe path:
leave the work committed on its branch, unmerged, and start your final reply
with the question.
