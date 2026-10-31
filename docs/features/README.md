# Helm feature map

Recipes for proving a feature works in a private Helm with the
`verify-helm` skill (`.agents/skills/verify-helm/SKILL.md` has the loop,
the fake accounts and the traps that apply everywhere). Entries marked
**not yet driven** were written from the code; run them once and remove the
mark.

| Area | File |
|---|---|
| Chats and the composer: send, queue, stop, modes, keys | [chats.md](chats.md) |
| Approvals, questions, "Needs you", alerts | [approvals.md](approvals.md) |
| New chat, clone, accounts, models | [new-chat.md](new-chat.md) |
| Sidebar, shelves, search, rename/archive/delete, brain | [sidebar.md](sidebar.md) |
| Helpers, subagents, messages between agents | [helpers.md](helpers.md) |
| Machines, devices, sending work, `exec` and `copy` | [machines.md](machines.md) |
| Terminal | [terminal.md](terminal.md) |
| Browser for chats | [browser.md](browser.md) |
| Spins: `helm share` public links | [spins.md](spins.md) |
| Settings, usage, limits, updates, connectors | [settings.md](settings.md) |
| Rewind: Edit / Branch from here | [rewind.md](rewind.md) |
| Files, images, voice, visuals | [files-and-visuals.md](files-and-visuals.md) |
| Git and CI / CD | [git-and-schedules.md](git-and-schedules.md) |

## Setup without clicks

The area files use `V` and `H` as below (driven 2026-10-15):

```sh
V="node scripts/verify-helm.mjs --name <you>"
$V up && $V open
$V rpc session.start '{"quick":true,"profileId":"fake","title":"my test"}'   # prints the chat id
H="env -u HELM_SESSION_ID -u HELM_NATIVE_SESSION HELM_DIR=/tmp/helm-verify-<you>/helm node packages/connect/bin/helm.js"
$H say <chat-id> "hello"; $H thread <chat-id> -n 10       # "working on it done."
```

Always pass `HELM_DIR` like this; without it `helm` talks to the owner's
real Helm.
