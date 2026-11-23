# Shared keys

Open Settings → Shared keys. Add a key or run `helm keys set API_KEY` in
your own terminal. Enter the value at the hidden prompt or pipe it in.
`helm keys list` shows names, machines that used each key and the last use.
Remove a key or a chat's access in Settings. The CLI has `remove` and
`revoke` for the same actions.

- The oldest machine in the network keeps the encrypted store. It needs
  to be online to use a shared key. Keys use the same machine encryption
  as code handoffs, including when a command needs a key on another machine.
- A chat asks the owner the first time it uses a key. It runs a command
  with `helm run --key API_KEY -- <command>`. Use `helm exec <machine>
  --key API_KEY -- <command>` to run the command elsewhere.
- Use `--key API_KEY` on `helm delegate`, `helm spawn` or `helm send-task`
  to give the new chat access. Repeat the option for more keys. A keyed
  task transfer skips .env files. The new chat uses the same `helm run`
  command with any agent account because its agent process holds no keys.
- Helm hides literal keys in stdout and stderr before it saves the output.
  Agent tools save their own output. Give keys to commands that use them
  to sign in. Do not ask commands to print, transform or save a key.
- Access ends when the chat ends. Remove access to stop new commands at
  once. A command already started keeps its environment until it exits.
  Replacing a key also ends the old grants.

## Prove it in a private copy

1. Add a fake value in Settings. Check that the value field closes and
   the list shows only the name.
2. Start a fake chat. Run `HELM_SESSION_ID=<chat> $H run --key API_KEY --
   sh -c 'printf "%s\n" "$API_KEY"'`. Open the app and allow the request.
   The command prints `[hidden]`. Run it again to check approval reuse.
3. Restart the copy. Check that the key and grant are still listed. Remove
   the grant in Settings, then check that the next use asks again.
4. Remove the key. Check that the CLI and Settings both show it is gone.

Tests: `test/shared-keys`, `test/execution`, `test/delegation`,
`test/spawn-cli`, `test/task-transfer` and `test/handoffs`.
