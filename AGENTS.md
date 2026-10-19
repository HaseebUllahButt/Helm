# Working on Helm

Rules for every agent here. Each one came from an owner correction. Anything
the code, `git log` or `helm help` shows is not repeated here.

## Development and rollout

- Requested Helm work is done only when it is verified, committed, pushed to
  main and installed on every reachable machine. Check the source checkout,
  installed checkout, running daemon and served web build separately.
- Develop in the source checkout or a worktree. Temporary scripts go under
  ~/.helm, never inside an installed checkout.
- Installed trees (`~/.helm-release` on the laptop, `~/.helm-src` elsewhere)
  often hold other sessions' uncommitted drafts. Save `git diff`, then move with
  `git checkout -m --detach <sha>`; never reset or stash them away. Never leave
  a finished fix as a dirty edit there: it blocks automatic updates.
- An offline machine is not deployed or verified: say so. Keep update failures
  visible and verify the live release after rollout.

## Production state

The owner's ~/.helm is production. Tests use a temporary HELM_DIR, HELM_DB,
HELM_SSH_DIR and process sockets, set before importing any Helm module. Never
create, join, leave, replace or restore the owner's network for a test, or
restart the production daemon to make a test pass. Deploy with the safe restart
worker so running chats survive.

## Proving it works

Passing tests are not "it works": two confident review claims here were wrong
until someone ran the code. For anything the owner can see or feel, drive it
with the `verify-helm` skill (a private Helm in a hidden phone-size browser);
`docs/features/` says what counts as proof. Report what you drove, what you saw
and what you could not check.

## Testing

- `npm run check` before and after a change. It runs only the tests your change
  reaches.
- Never run the full suite (`check:full`, `npm test`, `test:browser`) unless the
  owner asks. Never run two suites side by side. Rerun only failed files.

## Sharing the checkout

Other agents often edit this checkout at the same time (another Claude, Codex,
Devin). Before committing, read `git status` and leave files you did not touch.

- Commit by path (`git commit -- <files>`). Never `git add -A` or `git add .`:
  it has swept other sessions' half-finished work into pushed commits.
- Commit your own work as soon as it is verified, not as one big tree later.
- Before moving HEAD (reset, rebase, checkout), read `git log` and
  `git reflog -5`: someone may have committed on top. Never `stash pop` unless
  your `stash push` said it saved something.
- Several agents editing at once each get their own worktree
  (`helm delegate --worktree`); merge back by branch.

## Owner rules for the product

- No hidden limits on agents: no queues, slots, memory waits or worker caps,
  not even "for safety". If a guard is truly needed, make it per chat, explain
  it in a comment, and tell the owner.
- Never unset HELM_SESSION_ID or CODEX_THREAD_ID to start a helper.
- No test chats on the owner's real machines or accounts. Test in a private
  copy (`verify-helm`); if a live run was the only way, `helm delete` it after.
- Never make Helm depend on Tailscale or any outside network service. Borrow
  the idea and build it inside Helm.
- Helm never pulls from GitHub by itself. Machines take the newest committed
  version from each other; GitHub is an explicit, warned button.
- Never cut off work in progress: switch at a prompt or after the current
  step, then resume.
- Every shortcut needs Ctrl/Cmd. Never bind a bare letter.
- Design: keep Helm's own look and change real screens in small pieces. No
  new rounds of mockups unless asked. Borrow T3 Code's layout ideas, never its
  look.

## Traps that keep coming back

- `pkill -f` / `pgrep -f` match the shell running them; bracket one
  character (`"helm.js serv[e]"`). Never stop Helm processes by unit name
  (`helm-terminals-<uid>`): a test copy and the real laptop share those names.
  Find a test copy's processes by its HELM_DIR.
- A "before" timing from a git worktree secretly runs the new code:
  `node_modules/@helm/*` link back to the main checkout. Relink them first.
- Roster cleaning must leave a valid record exactly as it is, or machines
  re-send rosters forever. Validate and reject; normalise where it is used.
- A latency number is only real after about 10 seconds of samples.
- A worktree without a built node-pty hangs in `proc-host.test.mjs`. Fix:
  `npx node-gyp rebuild` in the pty package.
- On the laptop, the four "native launch" tests in `native-cli.test.mjs` time
  out whatever the change. On `why`, 5 tests in `browser-window.test.mjs` fail
  the same way (not looked into yet).
- On the VM, Codex's sandbox needs both `/etc/apparmor.d/bwrap` and
  `/etc/apparmor.d/codex-bwrap`: Codex runs its own bundled bwrap.

## Docs

- Most changes need no doc change. Agents can read the code.
- Docs keep only decisions and why, rules that cross components, and traps the
  code does not show. No feature lists, flag lists, step-by-step code tours,
  change logs, plans or reports. `git log` is the record.
- When something changes, rewrite or delete the old text. Never append.

## Words the owner uses

- "Settled": the sidebar shelf of finished chats (not settings).
- "Spins": public links made with `helm share <port>`.
- "Running": chats the owner started. Helpers never appear there.
