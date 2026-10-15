# Helm feature map

Find a feature, then prove it works by driving the real app. Each area file
says what the owner sees, how to reach it, the exact
`scripts/verify-helm.mjs` steps, what counts as proof, known traps and the
tests that cover it. Entries marked **steps not yet driven** were written
from the code and notes. Run them once and remove the mark.

| Area | File |
|---|---|
| Chats and the composer: send, reply, queue, stop, modes, keys | [chats.md](chats.md) |
| Approvals, questions, "Needs you", alerts | [approvals.md](approvals.md) |
| New chat, accounts, models, CLI defaults | [new-chat.md](new-chat.md) |
| Sidebar, shelves, search, rename/archive/delete, brain | [sidebar.md](sidebar.md) |
| Helpers and subagents (`helm delegate`) | [helpers.md](helpers.md) |
| Machines, devices, sending work, `exec` and `copy` | [machines.md](machines.md) |
| Terminal | [terminal.md](terminal.md) |
| Browser for chats | [browser.md](browser.md) |
| Spins: `helm share` public links | [spins.md](spins.md) |
| Settings, appearance, usage, limits, updates | [settings.md](settings.md) |
| Rewind: Edit / Branch from here | [rewind.md](rewind.md) |
| Files, images, voice, visuals | [files-and-visuals.md](files-and-visuals.md) |
| Git, CI / CD, schedules | [git-and-schedules.md](git-and-schedules.md) |

## The loop

```sh
V="node scripts/verify-helm.mjs --name <short-name>"
$V up && $V open                       # private Helm, phone-size hidden browser
$V click "New chat"; $V click "verify-<short-name>"; $V click "No folder · quick chat"
$V click "fake"                         # or "fake-ask" for the one that asks first
$V click "Ask anything"; $V type "hello"; $V click send
$V wait "done."                         # the fake reply is "working on it done."
$V shot /tmp/x.png; $V errors           # look at the picture; no page errors
$V down                                 # always, when finished
```

Other commands: `text`, `key <key>`, `eval <js>`, `rpc <method> [json]`,
`size <w> <h>`, `open --desktop`, `logs [n]`, `status`. Method names for
`rpc` are listed in `packages/protocol/index.js`.

Faster setup, no clicks (driven 2026-10-15):

```sh
$V rpc session.start '{"quick":true,"profileId":"fake","title":"my test"}'   # prints the chat id
H="env -u HELM_SESSION_ID -u HELM_NATIVE_SESSION HELM_DIR=/tmp/helm-verify-<short-name>/helm node packages/connect/bin/helm.js"
$H say <chat-id> "hello"; $H thread <chat-id> -n 10       # "working on it done."
```

Always pass `HELM_DIR` like this when running `helm` against the private
copy; without it the command talks to the owner's real Helm.

## Traps that apply everywhere

- **The private copy has its own home folder** (`/tmp/helm-verify-<name>/home`),
  so the owner's real chats, terminals and spend do not show. `up --real`
  uses the real home to reach real logins: then Settled, search, Usage and
  `rpc session.list` show the owner's real data. Only touch chats you made.
- A yellow "Helm updates need attention … Local changes are blocking"
  banner shows on every screen while the repo has uncommitted files. Ignore
  it. Never press "Replace with GitHub's version": the copy runs from the
  real repo.
- The composer's placeholder changes ("Ask anything, / commands", "Ask
  anything, @ chats, / commands", "Decide above, or reply instead"). Click
  "Ask anything" (a part match). `type` refuses when nothing has focus, so
  click the box first.
- On phone size, Enter and Ctrl+Enter make a new line. Send with
  `click send`.
- `click` tries exact matches before partial ones and skips things covered
  by a sheet or menu. A disabled button fails after 5 s with a plain message.
- `open` always reloads. `open '#open=<machine>/<chat>'` and `open '#devices'`
  start the app on that screen. Back can need several presses.
- `upload <file>...` attaches files as the clip button would.
- The fake agent ignores Stop, cannot take images, never asks questions
  (only tool approvals), and asks again even after "Always allow".
