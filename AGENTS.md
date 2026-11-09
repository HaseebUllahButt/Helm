# Working on Helm

Rules for every agent here. Each one came from an owner correction. Anything
the code, `git log` or `helm help` shows is not repeated here.

## Development and rollout

- Requested Helm work is done only when it is verified, committed, pushed to
  main and installed on every reachable machine. Run `helm ship` from your
  worktree: it merges, pushes, and waits until each online machine runs the
  new commit and serves an app built from it. Fix what it reports; never
  call the work shipped while it fails.
- Develop in the source checkout or a worktree. Temporary scripts go under
  ~/.helm, never inside an installed checkout.
- Installed copies often hold other chats' unsaved edits. Never reset or stash
  them away, and never leave your own fix there unsaved.
- Update the machines that are online; skip offline ones without mentioning
  them. Never hide a failed update.

## Production state

The owner's ~/.helm is production. Tests run in a private copy, never touch the
owner's machine network. Every update restarts Helm immediately. Agents must
survive the restart; fix interruptions instead of waiting for chats or transfers.

## Proving it works

For any change the owner can see in the app, try it in a private Helm
(`verify-helm`), take a screenshot with `verify-helm shot`, and inspect it.
Then show the owner one proof in the chat: a before and after picture for
a change in looks, or a short clip for a change in behaviour (the skill
says how). Keep every other screenshot private. Say what you could not
check.

Use plain text for reviews and progress reports. Create or publish a visual
only when the owner asks. Skills must follow the owner's chosen format.
Report supported findings without a fixed count.

## Hit every surface

The most common defect: a change works on the path you tested and is
missing everywhere else. Before you call work done, go through this list
and say which items applied:

- **Ways in.** A feature in the chat is often also in Settings, the
  palette, a Ctrl/Cmd shortcut, the sidebar menu and the `helm` command.
- **Screens.** Phone and computer widths; dark, navy and light themes;
  the desktop app window.
- **Chat kinds.** Chats Helm runs, native chats the owner started in a
  terminal, helpers, and quick chats with no folder.
- **AI tools.** Each CLI needs a decision, even "not supported here". See
  [docs/engines.md](docs/engines.md).
- **Agents.** What the owner can do, an agent usually needs through a
  `helm` command, and the notes in `delegation.js` must stay true.
- **Machines.** This machine, another machine through the hub, a machine
  that is offline, and a machine that still runs the older Helm.
- **Restart.** Every update restarts Helm. State, open chats and
  half-finished steps must come back.
- **Way back.** If you add a way in, add the way out and a way to see it:
  close needs reopen, hide needs show.
- **Words and docs.** New text a person sees follows the writing rules.
  Check that `docs/` and `helm <command> --help` are still true.

## Testing

- While you work, run the test files you touch by name:
  `npm run test:smart -- test/a.test.mjs`. Rerun only failed files.
- Run `npm run check` once before you commit. It type-checks the web app when
  web code changed and runs the tests named after the changed files.
- `check` lists changed files with no test of their own. Pick their tests by
  name (docs/features lists tests per feature). Add `--near` only when needed.
- Never run `npm test`, `test:browser`, `test:network`, `check:full` or
  `--wide` unless the owner asks. No hosted server runs them for Helm.
- New tests wait for an event or a state, never for a fixed time.
- `test:smart` gives each run its own temporary folder, then stops what the
  tests left running and deletes the folder. When it says it stopped
  programs, fix the test that left them.
- Clean up what you start: `verify-helm down`, `helm share stop` for links
  you made, and your scratch folders.

## Working alongside other chats

- Commit your own work as soon as it is verified, not as one big tree later.

## Owner rules for the product

- Never add hidden limits on agents (queues, caps, waits). If one is truly
  needed, make it per chat and tell the owner.
- Never test with chats on the owner's real Helm unless there is no other way;
  then `helm delete` them.
- Never make Helm depend on Tailscale or any outside network service. Borrow
  the idea and build it inside Helm.
- Helm never pulls from GitHub on its own; machines update each other.
- Never cut off work in progress: switch at a prompt or after the current
  step, then resume.
- Every shortcut needs Ctrl/Cmd. Never bind a bare letter.
- Borrow freely from T3 Code's code and ideas.
- Every word Helm shows a person (screens, tooltips, errors, notices, CLI help
  and output) uses Simplified Technical English, the same rules agents get in
  `writingNote` (delegation.js). Short, direct, verb first, no jargon. A chat
  is a "chat", never a thread or session.

## Traps that keep coming back

- `pkill -f` / `pgrep -f` match the shell running them; bracket one
  character (`"helm.js serv[e]"`). Never stop Helm processes by unit name
  (`helm-terminals-<uid>`): a test copy and the real laptop share those names.
  Find a test copy's processes by its HELM_DIR.
- Roster cleaning must leave a valid record exactly as it is, or machines
  re-send rosters forever. Validate and reject; normalise where it is used.
- A latency number is only real after about 10 seconds of samples.
- On a machine with ananicy (the owner's `why`), a program that starts as
  `node` gets idle CPU and disk priority, and so does all it starts. Start
  Helm's own Node programs with `ownNode()` (own-node.js), never with
  `process.execPath`. A chat's shell is idle there too, so a private copy
  is slower than the real Helm: compare speeds only on the real one.

## Docs

Docs hold only decisions, cross-component rules and hidden traps; the code and
`git log` hold the rest. Rewrite or delete old text, never append.
[docs/README.md](docs/README.md) lists every doc and the full rules.

## Words the owner uses

- "Settled": the sidebar shelf of finished chats (not settings).
- "Spins": public links made with `helm share <port>`.
- "Running": chats the owner started. Helpers never appear there.
