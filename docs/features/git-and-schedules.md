# Git and CI / CD

Every chat has a **Git** button (not the Helm brain). It vanished more
than once when it showed only for chats whose own folder is a Git project;
keep it unconditional. A chat whose folder is not a project (a config
folder, a quick chat) shows the project it last edited files in; with none,
the Git sheet says so. The private copy's home is its own
(`/tmp/helm-verify-<you>/home`); make a throwaway repo there first.

## Git: graph, changes and files
- **Sees:** a **Git** button in every chat's header ("Git: 3 changed
  files") opens the Git screen with tabs **Graph**, **Changes**, **Files**,
  **CI / CD**. Graph: the last 80 commits; tap one for details, a file for
  its diff. Changes: +/- counts, each diff, a "viewed" tick. Commit, push and
  create PR, one step at a time or all in order; push never forces.
- **Diffs:** numbered, coloured rows; a wrapped line stays in the code
  column. On a phone the indent every line shares is trimmed and the diff
  runs edge to edge. **Wrap** in the top bar folds long lines (on by
  default on a phone). Each open diff has **Open whole file**.
- **Files (read only):** the repo's files (tracked plus new, not ignored),
  opening in the chat's folder. "Find a file" searches every path. A green
  dot marks changed files and folders. Secrets (`.env`, keys, `.pem`…)
  show "hidden" and never leave the machine. A file opens with line
  numbers and colours, **Copy path**, **See changes** when it changed, and
  "Read only". Binary files say "This is not a text file".
- **Prove (driven 2026-10-17):**
  ```sh
  W=/tmp/helm-verify-<you>/work/demo; mkdir -p $W/src && cd $W && git init -q
  printf 'a\nb\n' > src/x.ts; printf 'S=1\n' > .env; git add -A; git -c user.email=a@b -c user.name=t commit -qm base
  printf 'a\nB\n' > src/x.ts; cd -
  ID=$($V rpc session.start "{\"cwd\":\"$W\",\"profileId\":\"fake\",\"title\":\"demo\"}" | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)
  $H say $ID hello                          # an unsent chat does not show
  $V open; $V click verify-<you>; $V click "Devin · …/work/demo"
  $V click "Git: 1 changed files"; $V click x.ts; $V shot /tmp/diff.png
  $V click "Open whole file"; $V shot /tmp/file.png
  $V click "Back to the files"; $V click .env; $V text | grep Hidden
  ```
- **Proof:** the diff with line numbers and a red "2 −" and green "2 +" row;
  the file screen with "Read only"; "Hidden: this file may hold passwords
  or keys."
- **Traps:** commit by path in real repos; other sessions leave edits in the
  same tree.
- **Tests:** `test/git` (file list, secrets, links out of the repo),
  `git-head`; `test/browser/inline-diff`.

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
- **Removed from the app 2026-10-17** (the owner found them unnecessary).
  The machine side (`schedule.*`, webhooks) is still there and existing
  automations keep running; nothing in the app lists them any more.
- **Tests:** `test/schedules`, `usage-recovery`, `shell-task-alarm`.
