# Working on Helm

Rules every agent follows here, whichever CLI or account it runs on. They
come from the owner's own corrections; each one cost something once.

## Talking to the owner

Plain English. Short replies, simple words, short sentences. No jargon; if a
term cannot be avoided, explain it in a few words. Say what the owner will
see, not how the code does it.

## Development and rollout

For requested Helm development, finish the work by validating it, committing and
pushing to main, and updating every reachable installed machine. Check the source
checkout, installed checkout, running daemon version and served web build separately.
Preserve existing local changes; reconcile them or keep the old installed tree as a
backup before installing a clean release. Do not leave finished fixes only as dirty
edits in installed checkouts, because that blocks automatic updates.
Develop in the source checkout or a separate worktree. Keep temporary scripts and
machine-local helpers under ~/.helm, outside installed release checkouts.

Installed trees (`~/.helm-release` on the laptop, `~/.helm-src` on the VM) often
carry other sessions' uncommitted drafts. Move them with
`git checkout -m --detach <sha>` after saving `git diff`; never reset or stash
them away.

The owner's ~/.helm is production state. Tests must use a temporary HELM_DIR,
HELM_DB, HELM_SSH_DIR and process sockets, set before importing any Helm module.
Never create, join, leave, replace or restore the owner's network for a test, and
never restart the production daemon to make a test pass. Keep running owner chats
undisturbed; use isolated test hubs and the safe restart worker for deployments.

Use `helm digest` to check reachability and active sessions. Prefer `helm exec` for
remote commands. Run builds and tests directly (`--heavy` is a no-op now) and use
Helm's safe restart worker so hosted sessions survive and outstanding approvals or
active transfers can finish.

Report unreachable machines explicitly. An offline machine has not been deployed
or verified; a clean service-managed install catches up from GitHub or peers when
it reconnects. Keep update failures visible and verify the live release after rollout.

## Proving it works

The owner trusts a change only after it has been run. Passing tests are not
"it works", and two confident review claims here were wrong until someone ran
the code. For anything the owner can see or feel, use the `verify-helm` skill
(`node scripts/verify-helm.mjs`): a private Helm with a free fake agent in a
hidden phone-size browser. `docs/features/` says where each feature lives and
what counts as proof. Run `npm run check` before and after a change. Report
what you drove, what you saw, and what you could not check.

## Testing

- Run only the tests your change reaches: `node scripts/test-smart.mjs` (`--near` while working, `--list` to see why). `npm run check` uses it.
- Do not run the full suite (`npm run check:full`, `npm test`, `test:browser`) unless the owner asks.
- Never run two suites side by side. Rerun only failed files.

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
- Helpers stay attached to the chat that started them, as cards. Never unset
  HELM_SESSION_ID or CODEX_THREAD_ID to start one.
- No test chats on the owner's real machines or accounts. Test in a private
  copy (`verify-helm`); if a live run was the only way, delete the chat after.
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

## Pausing and handing over

No handoff file. To pause, stop at a clean point, commit verified work, and
end with a short reply that says what is left. To continue earlier work, run
`helm pickup`. The `pause-and-pickup` skill has the steps.

## Words the owner uses

- "Settled": the sidebar shelf of finished chats (not settings).
- "Spins": public links made with `helm share <port>`.
- "Running": chats the owner started. Helpers never appear there.
