# Git, CI / CD and schedules

Git needs a folder chat; quick chats have no Git tab. None of the Git steps
were driven yet. The private copy's home is its own
(`/tmp/helm-verify-<you>/home`); make a throwaway repo there first.

## Git: graph and changes
- **Sees:** a **Git** button in a folder chat's header ("Git: 3 changed
  files") → Thread details → **Git** with Graph and Changes. Graph: the last
  80 commits; tap one for details, a file for its diff. Changes: +/- counts,
  each diff, a "viewed" tick. Commit, push and create PR, one step at a time
  or all in order; push never forces.
- **Prove:** steps not yet driven.
  ```sh
  git init /tmp/helm-verify-<you>/work/demo && echo hi > /tmp/helm-verify-<you>/work/demo/a.txt
  # New chat → verify-<you> → that folder → fake; then the Git button
  ```
- **Proof:** "a.txt" listed under Changes with "+1".
- **Traps:** commit by path in real repos; other sessions leave edits in the
  same tree.
- **Tests:** `test/git`, `git-head`; `test/browser/inline-diff`.

## CI / CD
- **Sees:** a "CI / CD" section: PR reviews, checks, workflow runs, failed
  steps with log links, deployments; "Refresh CI / CD"; switches "Notify this
  thread about CI / CD" and "Wake agent on GitHub changes". Review and merge
  from the panel (merge needs an explicit choice).
- **Prove:** steps not yet driven; needs a GitHub repo and account.
- **Traps:** a passing check does not prove a deploy. GitHub text is
  treated as untrusted for the agent.
- **Tests:** `test/github`; `test/browser/automation-pr`,
  `git-notifications`. Run with `npm run test:automation`.

## Schedules (automations)
- **Sees:** Thread details → **Schedules** → "Automations": "Runs on
  <machine> with this thread's account, model and permissions…", the
  switch "Continue automatically when this account's usage limit resets",
  "No automations for this thread." and **New automation**. Kinds: interval
  (5 min or more), fixed time (time zone, weekdays), webhook. Each has
  pause, edit, **Run now**, delete, and "Start a fresh thread for each run".
- **Prove (screen driven 2026-10-15, adding one not yet driven):**
  ```sh
  $V click Agents; $V click Schedules; $V text | sed -n '/Thread details/,$p'
  ```
- **Proof:** "No automations for this thread." and "New automation".
- **Traps:** a failed run pauses the schedule. Webhooks need the public hub
  online. Rotating a webhook address cancels queued runs.
- **Tests:** `test/schedules`, `usage-recovery`, `shell-task-alarm`.
