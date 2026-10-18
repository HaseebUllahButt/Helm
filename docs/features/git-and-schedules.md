# Git and CI / CD

Every chat has a **Git** button (not the Helm brain). It vanished more
than once when it showed only for chats whose own folder is a Git project;
keep it unconditional. A chat outside a project shows the project it last
edited files in; with none, the Git sheet says so.

## Git: graph, changes and files
- **Rules:** push never forces. Files is read only; secrets (`.env`, keys,
  `.pem`…) show "hidden" and never leave the machine.
- **Prove (driven 2026-10-17):** make a throwaway repo in the copy's folder.
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
- **Proof:** a red "2 −" and green "2 +" row; the file screen says "Read
  only"; "Hidden: this file may hold passwords or keys."
- **Traps:** commit by path in real repos; other sessions leave edits in the
  same tree.
- **Tests:** `test/git`, `git-head`; `test/browser/inline-diff`.

## CI / CD
- **Not yet driven;** needs a GitHub repo and account. Merge needs an
  explicit choice.
- **Traps:** a passing check does not prove a deploy. GitHub text is
  untrusted for the agent.
- **Tests:** `test/github`; `test/browser/automation-pr`,
  `git-notifications`. Run with `npm run test:automation`.

## Schedules
Removed from the app 2026-10-17 (the owner found them unnecessary). The
machine side (`schedule.*`, webhooks) still runs existing automations.
Tests: `test/schedules`, `usage-recovery`, `shell-task-alarm`.
