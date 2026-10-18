# Running settings in the chat tray

Start-up values come from each driver's provider handshake, explicit native
launch flags and provider reports. A later partial handshake never clears a
setting it leaves out. Account defaults stay separate from a native
terminal's state. A provider refusal keeps the previous choice. The tray
shows reported settings even when Helm has no proven control for them.

## Claude terminals

Claude terminal chats, takeovers included, get Helm's hooks and status-line
wrapper (keeping the account's own status output). The terminal footer also
tracks permission changes made at the keyboard.

- The launch adds `--allow-dangerously-skip-permissions` so bypass can be
  chosen; this does **not** turn bypass on. Only
  `--dangerously-skip-permissions` or a confirmed native mode change does.
- Helm waits for the footer before accepting a mode change.
- Claude's hook blocks and direct questions can still apply in bypass mode.

## Pi

Pi terminals, takeovers and managed RPC sessions load
`packages/connect/extensions/helm-settings.ts` for that process only; the
account's extensions are never changed. It polls the live runtime, because
the account's saved settings are not the running session's. Pi processes
started before the adapter run without it until takeover or the next launch.

Pi has no permission modes. If the `bash-guard` extension offers its
command, Helm reads its status badge and shows Guard on/off for that session,
switching with `/bash-guard` and waiting for the reported state. The
extension does all enforcement: Guard off still keeps its
catastrophic-command blocks, and it covers only bash. No guard command means
no guard picker. The toggle is never an account default.
