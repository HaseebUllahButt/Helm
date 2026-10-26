---
name: full-stop
description: Do the full-send work, but stop before main so the owner merges. Use only when the owner says "full stop".
---

# Full Stop

Do the same work as `full-send`, but stop with the change ready for the owner
to merge. Never merge it.

Read [full-send](../full-send/SKILL.md) and follow its steps, testing
permission, proof, review and asking rules. "Full stop" is the permission for
that work, including the test methods Proof needs. Its merge, push-main and
install permissions do not apply. The rules below win.

## No merging

You may commit, rebase onto main and fix conflicts on this chat's branch.
Never merge into main, push main, install, or ask a helper to do any of
those.

## Stop at the gate

Use full-send's merge gate as the readiness check. Replace its ship and report
steps with a handoff. Proof and review must cover the final diff. Prove
behavior changes and real conflict fixes again before the handoff.

- **Ready to merge:** the gate passes. Leave the commits on the branch.
- **Blocked:** say what stops it, what you tried and what is needed. Follow
  full-send's rules for asking the owner.

Report the branch, the last commit, the verdict, the proof, the `sol-loop`
outcome and what is still at risk. Say that it is not merged.
