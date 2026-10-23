# Working on Helm

Rules for every agent here. Each one came from an owner correction. Anything
the code, `git log` or `helm help` shows is not repeated here.

## Development and rollout

- Requested Helm work is done only when it is verified, committed, pushed to
  main and installed on every reachable machine. Check the source checkout,
  installed checkout, running daemon and served web build separately.
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
Keep proof screenshots private unless the owner asks to see them.
Say what you could not check.

Use plain text for reviews and progress reports. Create or publish a visual
only when the owner asks. Skills must follow the owner's chosen format.
Report supported findings without a fixed count.

## Testing

- Run `npm run check` before and after a change.
- Never run the full test suite unless the owner asks. Rerun only failed files.

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

## Docs

Docs hold only decisions, cross-component rules and hidden traps; the code and
`git log` hold the rest. Rewrite or delete old text, never append.

## Words the owner uses

- "Settled": the sidebar shelf of finished chats (not settings).
- "Spins": public links made with `helm share <port>`.
- "Running": chats the owner started. Helpers never appear there.
