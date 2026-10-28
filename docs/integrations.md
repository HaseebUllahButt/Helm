# Connectors, skills and plugins

The manager runs on the selected machine, inside each Helm profile's own
environment. It lists entries by reading config files and never starts MCP
connections, so "configured" does not mean healthy or signed in. Changes
apply to new agent sessions; running agents are not restarted.

## Decisions and CLI limits (checked 2026-10-11)

- **Claude Code 2.1.295:** `mcp add/list/get/remove/login`;
  `mcp login NAME --no-browser` prints the sign-in address and takes a pasted
  redirect address. Entries live in `~/.claude.json` (local ones under
  `projects[absolutePath].mcpServers`) and `.mcp.json`. `CLAUDE_CONFIG_DIR`
  moves the JSON file inside that folder, even when set to `~/.claude`, so
  the manager never adds that variable. Marketplace shell-command approvals
  are never auto-accepted.
- **Codex CLI 0.161.0:** entries are `[mcp_servers.NAME]` in
  `$CODEX_HOME/config.toml`. `mcp add` cannot set arbitrary HTTP headers,
  and **the manager never rewrites TOML**, so headers need hand editing.
  Plugins are listed from config without asking marketplaces.
- **Codex chats Helm starts skip online MCP servers and ChatGPT apps**: each
  thread gets `mcp_servers.NAME.enabled=false` for every `url` entry and
  `features.apps=false` (`codexOnlineOff`), so the owner's own Codex still has
  them. Local servers and plugins stay on: Helm chats use the computer-use
  plugin. Measured 2026-10-28 on 0.165.0: apps off saved about 1.5 s a new
  chat; servers and plugins off gave no clear gain. The owner chose apps off.
- **Gemini and `agy` are not supported;** their configs are left untouched.
- **Shared skills:** Codex reads `$HOME/.agents/skills`; Claude does not
  document reading it but follows symlinked skill folders. So a shared
  install copies to `~/.agents/skills/NAME` and links it into every
  existing Claude profile. Accounts made later need their links set up
  separately. Removing a shared skill removes it for every linked account.
- Duplicates, existing skills, reserved Claude names and links that leave
  the skill folder are refused; failed copies roll back. Installs and
  removals run one at a time so CLI config writes never overlap. Plugin
  marketplaces must already be set up in the CLI.
- Bundled system skills, cloud-only connectors and project skills outside
  the chosen folder are not listed.

## Catalog

Each entry in `integrations.js` keeps its publisher's source address.
Google Workspace endpoints are in Developer Preview: they need Preview
membership, enabled APIs and an OAuth client with the right redirect
([setup](https://developers.google.com/workspace/guides/configure-mcp-servers)).
Slack's endpoint has no dynamic client registration and needs a registered
app. Native errors are shown with supplied secrets hidden.

## Not yet proven

Real OAuth sign-in, account eligibility, real marketplace installs,
git-address skill downloads and other machines.

## Trap: missing pty binary in a worktree

A worktree whose install scripts were blocked lacks the Node pty binary,
and the full suite stalls in proc-host cleanup. Build only that dependency:

```sh
npm exec --yes --package=node-gyp -- node-gyp rebuild --directory node_modules/@homebridge/node-pty-prebuilt-multiarch --nodedir=/usr
```
