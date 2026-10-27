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

## Optional change tours
- **Reach:** open a chat's **Git** screen. Choose **Uncommitted edits** or
  **Branch compared with main**, then press **Tour**. In **Graph**, open a
  commit and press **Tour this commit**. Opening Git never starts a helper.
- **Rules:** the helper uses the chat's account and its small model when one
  is available. The diff is a saved copy, treated as data. The helper has no
  inherited parent context and sends no result into the parent's conversation.
  It runs outside the repo, so repo instructions do not enter its prompt.
  Changed files without a valid stop appear under **Also changed**. Secrets
  stay hidden. Tours stay on the machine under `git-tours`, outside the repo.
  Saved tours use the exact change, including its base and content. Old tours
  keep their saved excerpts and say they are old; reads never replace them.
- **Prove (driven 2026-10-27):** use the private copy and a fake chat in a
  throwaway repo. Change two text files, add one file and `.env`. Press
  **Tour**. See the stops, **Needs your decision**, and **Also changed**.
  Use **Next**, close and reopen the tour, and check that no helper starts.
  Use **fake-slow** with a new change to see **Stop writing** and stop it.
  Choose the branch comparison, then tour a commit from **Graph**. Tour an
  older commit and see its old-tour notice. Check phone and computer sizes.
- **Tests:** `test/git-tour.test.mjs`, `test/delegation.test.mjs`;
  `test/driver-acp.test.mjs` covers the fake agent's transport.
  `test/browser/git-notifications.test.mjs` checks the tour controls at both sizes.

## A worktree per chat (`helm.json`)
- **Rules:** a repo opts in with a committed `helm.json` at its root:
  `{"worktrees": "per-chat", "setup": "<optional command>"}`. Never for
  quick chats, the brain, clones, hidden helpers, a folder that is already
  a linked worktree, or the checkout Helm runs from. Only the branch is
  renamed after the chat; the folder keeps its `-chat-<id>` name because
  the CLI files its conversation under that path.
- **Prove (driven 2026-10-20):** make `$W` as above with
  `{"worktrees":"per-chat","setup":"sleep 45"}` and a `node_modules/x`.
  `session.start` in `$W` returns a `cwd` of `$W-chat-<id>`; open it: the
  header says "setting up" and a message waits "Once setup is done". The
  machine page counts it under the repo's project; Git shows the branch
  and "worktree". Commit in the worktree, merge into main in `$W`, send one
  more message: the folder and branch are gone. Send again: it is back.
- **Traps:** the agent's process runs in that folder, so Helm stops it
  before removing a merged worktree; a rebuilt branch starts afresh. A
  Codex thread still open in its daemon keeps its folder: the native check
  joins it again within 2.5 s and rebuilds it, which looped every 3 s.
- **Tests:** `test/chat-worktree`, `native-codex`.

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
