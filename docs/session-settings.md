# Running settings in the chat tray

Startup values come from each driver's provider handshake, explicit native launch
flags, and provider reports. Missing fields in a later partial handshake do not
clear a previously reported setting. Account defaults stay separate from native
terminal state. A provider refusal leaves the previous selection in place.

Claude terminal chats, including takeover, receive Helm's hooks and status-line
wrapper. Hooks report the permission mode and model changes; the status line
reports the current model and effort while preserving the account's own output.
The terminal footer also tracks keyboard permission changes. The launch adds
`--allow-dangerously-skip-permissions` to make bypass selectable; this does not
select bypass. Only `--dangerously-skip-permissions` or a confirmed native mode
change activates it. Helm waits for the footer before accepting a mode change.
Claude's hook blocks and direct questions can still apply in bypass mode.

New shared Pi terminals, Pi takeovers, and managed Pi RPC sessions load
`packages/connect/extensions/helm-settings.ts` for that process. The extension
reports the running model and thinking level, including changes at the keyboard.
It polls the live runtime rather than mistaking the account's saved settings for
the current session. Native snapshots repeat after a daemon reconnect. Existing
processes that predate this adapter keep running; takeover or the next launch
loads the adapter without requiring a change to the account's extensions.

Pi has no built-in permission modes. If the installed `bash-guard` extension
advertises its command, Helm observes its status badge and exposes Guard on/off
for that session. Changing it invokes `/bash-guard` and waits for its reported
state; concurrent native writes remain serialized. The installed extension owns
all enforcement. Guard off still retains that extension's catastrophic-command
blocks and applies only to bash, not Pi's other tools. No guard command means no
guard picker; the tray says approvals belong to extensions. This session toggle
is not offered as an account default.

The tray displays reported settings even when a CLI keeps its native picker or
has no verified control for that value. Phone layouts retain the labels and
scroll the controls row when needed. Model, effort and guard capability metadata
are retained in the workspace header cache across refresh.
