# Where the AI tools differ

A feature that touches chats needs a decision for each tool, even "not
supported here". This page says where the tools differ and what breaks.
Read from the code on 2026-11-04; check the driver before you trust a row.

Eleven tools have a headless driver: Helm runs the CLI itself and reads its
event stream (`DRIVERS` in `session-wire.js`). Gemini, Kimi and Muse work
only as native chats: the owner starts them in a terminal and Helm reads
their history. `shell` is a plain terminal. ACP is the Agent Client
Protocol: JSON over stdin and stdout (`drivers/acp.js`).

| Tool | How Helm runs it | Approvals | Pictures | Models, effort | Stop, resume | Rewind | Usage |
|---|---|---|---|---|---|---|---|
| claude | `claude -p` stream-json | 4 modes; Helm answers `can_use_tool` | yes | changed while live | interrupt; `--resume` | yes | rate-limit events, limits page |
| codex | `app-server`, one per account | 5 modes; command, file and permission requests | yes | applies next turn | `turn/interrupt`; `thread/resume` | yes | rate limits, limits page |
| opencode | ACP `acp`; the folder comes from the process (2.x refuses `--cwd`) | build/plan; Helm allows the rest itself | if the agent says so | changed while live | `session/cancel`; `session/load` | no | context only |
| opencode2 | ACP `acp`, no `--cwd` | as opencode | if the agent says so | as opencode | `session/resume` | no | context only |
| devin | ACP | its own edit/read/bypass | if the agent says so | effort is `thought_level` | `session/load` replays | no | Helm answers `/usage` |
| grok | ACP `agent --no-leader … stdio` | Claude's mode words | if the agent says so | effort is a start flag | `session/load` | no | context only |
| cursor | ACP `acp` | ask/agent; Helm answers auto | yes | `cursor-agent models` | load; no history reader | no | context only |
| vibe | ACP `vibe-acp`, next to `vibe` | ask/accept-edits/smart-approve/auto-approve | yes | `model` and `thinking` options | `session/load`; no native chat | no | context only |
| antigravity | ACP, a binary Helm installs | default/auto_edit/yolo | if the agent says so | no effort | `session/resume`; no native chat | no | context only |
| agy | stream-json NDJSON | none: Helm cannot answer requests | saved as files | each change restarts it | no cancel, stop kills it | no | per-turn difference |
| pi, omp | `--mode rpc` (`pi.js`) | no modes; extension dialogs become cards | yes | `set_model`, `set_thinking_level` | `abort`; `--session` | no | from messages |
| gemini, kimi, muse | no driver | – | – | – | native chat only | no | no |

Questions to the owner: Claude and Codex (`requestUserInput`); Pi and OMP
through extension dialogs. Todo cards: Codex (`turn/plan`) and the ACP
tools. Not checked: Claude and Pi todos, ACP questions beyond approvals,
Grok effort in a live chat, Cursor effort, the Antigravity model list.

## Places that list tools by name

A new tool, or a feature for "every tool", must look at each of these:

- Headless drivers: `DRIVERS` in `session-wire.js`.
- History readers: `transcript.js`.
- Helper tracking and messages to a helper: `cli-subagents.js`.
- Moving a chat to another machine: `MOVABLE` in `chat-move.js` (Claude,
  Codex).
- Native chat controls: `native-controls.js`. Mode lists: `modes.js`.
- Rewind: `session-rewind.js`; checkpoints only for tools that rewind
  (`session-delivery.js`).
- Web app: Branch is Claude only (`DrivenSession.tsx`), the context limit
  is Claude only (`ContextLimit.tsx`), model tiers are Devin only
  (`Controls.tsx`).

## Traps

- **Pictures:** never give the base driver a default
  `sendWithAttachments`. The app reads its presence as "takes pictures".
  For ACP, null means "not known before `initialize`", not "no".
- **agy:** an image block or a CLI slash command such as `/model` ends its
  session. Helm saves pictures as files and passes
  `--disable-slash-commands`. Its usage counters add up over the chat, so
  take the difference per turn.
- **Claude:** plan mode is blocked twice, on the command line and in the
  approval answer. In auto mode an approval is denied with no phone notice;
  only questions reach the owner. A turn Claude starts by itself (a
  background task ended) can arrive with no stream events. Each step then
  opens from its full message; without that start, waiting messages sat
  until the whole wake-up ended.
- **Codex:** one app-server serves every chat on an account. Never put a
  chat's variables (`HELM_SESSION_ID` and others) in its environment; each
  thread sets them through Codex's shell policy. At the unchanged idle
  deadline, check native children and background terminals before releasing
  a chat. Unsubscribe that chat; leave other chats on the account running.
  Helm-owned servers use zero extra unload delay, so Codex does not add
  another 30 minutes. Terminal-owned servers keep their settings. Unknown
  background state keeps the chat alive and writes the reason to the log.
  A restart suspends the connection and does not unsubscribe.
  Codex has no slash command list
  of its own, so Helm keeps a fixed one.
- **ACP:** do not copy the tool's mode or model notices back before Helm's
  own choices are applied, or the chat's saved choices are lost. On stop,
  answer every open approval with `cancelled`, or the tool hangs.
- **opencode2:** no messages during a reply and no `--cwd`; it uses the
  process folder. On the Laptop and why the `opencode` name runs 2.x too
  (2026-11-11). The opencode driver asks `--version` and then uses the 2.x
  rules. Past messages of an opencode chat come from the 2.x tables when the
  1.x tables have none; both versions share one `opencode.db`.
- **opencode, opencode2 free models:** each free model has its own limit.
  A chat on a free model that hits it moves to the next free model with
  limit left and goes on in the same turn. A paid model never moves.
- **Grok:** flags go between `agent` and `stdio`, and `--no-leader` must
  stay. Without it Helm steers a shared Grok backend.
- **Pi:** when the version sends `agent_settled`, `agent_end` is not the
  end: compaction runs after it.
- **Vibe:** the profile names `vibe`, but the driver runs `vibe-acp` from
  the same folder. With no Mistral sign-in, `session/new` says "Missing API
  key"; Helm shows `vibe --setup` instead. Its chat store
  (`logs/session/unified`) has no reader yet, so terminal Vibe chats do not
  show in Helm.
- **Antigravity:** never run `--version` (about 1 GB unpack) and never
  clean its shared temp folder (it kills a live agent).
- **Rewind:** off for native, shared and outside chats, even on Claude and
  Codex. A Codex rewind step that timed out must not run again.
