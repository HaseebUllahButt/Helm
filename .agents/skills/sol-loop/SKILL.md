---
name: sol-loop
description: Review a change with GPT Sol in a loop until both agents agree. Use when the owner says "sol loop" or "review loop", and as the review step of full-send and full-stop.
---

# sol-loop

Make a change more correct before it reaches main: a Sol helper reviews it in
a loop. Make the smallest changes that answer Sol. Watch for scope creep, and
push back when Sol is wrong.

## Budget

- Default: 3 rounds. Round 1 is full. Later rounds check only changed code
  and open findings.
- Extend to 5 only for security, permissions, data loss, or
  state/concurrency, while a blocker or should stays open with evidence. Or
  when the owner asks.
- Stop early if a round returns only nits. Declined nits and comment, doc or
  format-only fixes need no new round.
- One reviewer only. Sol must not start helpers of its own.
- Keep a ledger: id, severity, outcome. Never guess it.

## 1. Scope

Run `git status --short`. Do not stash, discard or include other chats'
changes. Limit review to this change's paths if they separate cleanly.
Otherwise stop and ask.

Base: `git merge-base HEAD main` (or the repo's default branch). For
uncommitted work only, use `HEAD`. The change is base to working tree in those
paths, with untracked files. Use one diff command for all rounds. State intent
and out-of-scope in 1-2 sentences. Run the covering checks (`npm run check` in
Helm). Do not send code this change breaks. Note missing or failing checks in
the brief.

## 2. Start Sol

Run `helm agents`. Pick a signed-in Codex account and its newest Sol model,
unless the owner named one. If no account runs Sol, report the blocker. Do not
use another model in its place.

```sh
helm delegate <account> --model <sol> --effort high --mode full --wait --json -- "<brief>"
```

Save the helper id. Do not edit scoped files while it reviews. A timeout,
error or empty reply is not approval: read it with
`helm delegate-result <id> --wait --json`, or stop it and start again with the
ledger.

Round 1 brief (the helper gets no history):

```
Review only. Do not edit, commit, merge, or start helpers.
Repo: <abs path> Base: <sha> Intent: <intent> Out of scope: <scope> Checks: <results>
See: git diff <base> [-- <paths>]; git status --short (read untracked).
Read surrounding code. Find bugs, broken callers, mismatch with intent.
Skip style unless it hides a bug. Hold to the smallest change. Flag code,
tests, or guards the intent does not need. Other paths, rare cases, small
perf, extra compat: nits.
blocker = intended case wrong. should = real bug callers will hit, in intent. nit = rest.
Reply:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion> (stable ids)
```

## 3. Answer findings

Check each finding and severity yourself. Another path, rare case or small
cost is a nit, whatever label it came with.

- Agree: smallest fix. Prefer delete or narrow over a new lock, cache, helper
  or option. Fix the case that happened. Add one focused test that fails
  without the fix, if the intent needs it.
- Disagree: say why, with evidence (file:line, test, output).
- Out of scope or nit: decline in one line. List it as a follow-up.

Update the ledger. Re-run checks and `git diff --shortstat <base>`. If review
grew the diff, cut first. Do not agree just to end the loop.

## 4. Next round

Start one only if budget remains and a blocker or should is open, behavior code
changed, or approval does not cover the current diff. Send it to the same
helper with `helm say <id> -- "<round brief>"`, then read
`helm delegate-result <id> --wait --json`. Send the ledger (`fixed:` /
`disagree:` / `declined:` + evidence) and the change since last round. Tell Sol:
open ids and changed code only. Mark each old id `resolved` or
`still open: <reason>`.

## 5. Stop

Agreed: APPROVE on the current diff, no blocker or should open, no concern of
your own. Stuck: an item stays disputed after two replies, or budget ends. Show
both sides in 2-3 lines each. The owner decides. Budget end is not approval.

Do not merge into main during the loop. When you commit after agreement, add
this line to the commit message:
`Reviewed with sol-loop: <N> rounds with <model>. Sol verdict: approved`.

Report: rounds, model, what Sol changed, diff size before/after, fixed and
declined findings with reasons.
