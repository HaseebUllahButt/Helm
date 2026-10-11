# Connectors, skills and plugins

Research checked on the laptop on 2026-10-11 before implementation. The manager
runs on the selected machine and uses each Helm profile's materialized environment.
It reads configuration files to list entries; it never starts MCP connections to
populate the screen. “Configured” is not a claim that a server is healthy or signed in.
Changes apply to new agent sessions, without restarting running agents.

## CLI capabilities

- Claude Code 2.1.295: `mcp add`, `list`, `get`, `remove`, and **`login`**.
  The installed `mcp login NAME --no-browser` prints the authorization URL and
  accepts a pasted redirect URL. Older versions can use interactive `/mcp`.
  OAuth still requires the person to complete the browser flow.
  User/local configurations live in `~/.claude.json`; local entries are under
  `projects[absolutePath].mcpServers`. Project entries are in `.mcp.json`.
  With `CLAUDE_CONFIG_DIR`, the JSON file is inside that directory. Setting
  `CLAUDE_CONFIG_DIR=~/.claude` explicitly also changes the JSON path; the
  manager preserves default CLI behavior rather than introducing that override.
  `plugin install NAME@MARKETPLACE --scope user --json` and
  `plugin uninstall NAME@MARKETPLACE --scope user --json` are headless commands.
  Marketplace shell-command approvals are not auto-accepted.
- Codex CLI 0.161.0: `mcp add/list/get/remove/login`; login accepts
  `--no-browser`. MCP settings are `[mcp_servers.NAME]` in
  `$CODEX_HOME/config.toml`. The add command supports stdio environment values,
  HTTP URLs, and OAuth client credentials. It does not accept arbitrary HTTP
  headers; those require native config editing. The manager does not rewrite TOML.
  Plugins have headless `plugin add NAME@MARKETPLACE --json` and
  `plugin remove NAME@MARKETPLACE --json` commands, as well as `plugin list --json`.
  Listing in Helm reads configured plugin entries without querying marketplaces.
- Gemini was not installed under `gemini` on this laptop. `agy mcp --help`
  exposes add/remove/list/enable/disable, but its account isolation, skills and
  extensions were not investigated further. Both are explicitly unsupported
  in this first manager; their existing configurations are untouched.

Installed help for the commands above, Claude plugin marketplace help, and
`helm agents --json` were checked. `codex` and `claudea` reported authenticated.

Sources:

- [Claude MCP](https://code.claude.com/docs/en/mcp)
- [Claude skills](https://code.claude.com/docs/en/skills)
- [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Codex MCP](https://developers.openai.com/codex/mcp/)
- [Codex skills](https://developers.openai.com/codex/skills/)
- [Codex plugins](https://developers.openai.com/codex/plugins/)

## Catalog and authentication

Every catalog entry includes its publisher's source URL in `integrations.js`.
Official remote URLs were confirmed for Google Drive, Calendar, Gmail, GitHub,
Notion, Linear, Slack, Sentry and Context7. Playwright uses Microsoft's documented
`npx -y @playwright/mcp@latest` stdio command.

Google published official Workspace endpoints in Developer Preview. They require
Preview membership, enabled APIs/services in a Cloud project, and an OAuth client
with the appropriate redirect URI. The catalog labels these prerequisites and
links the [Google setup guide](https://developers.google.com/workspace/guides/configure-mcp-servers).
Google's existence and setup documentation do not prove that a particular owner's
account is eligible or that its OAuth app is registered correctly. No community
Google endpoint was needed, and no Google sign-in was performed.

Slack's [official endpoint](https://docs.slack.dev/ai/slack-mcp-server/)
does not support dynamic client registration and requires registered app setup.
Context7 recommends an API key for higher limits. Native errors remain visible,
with supplied credentials redacted. The add form exposes OAuth credentials and
Claude's fixed callback port where a service requires them.

## Skills and boundaries

Codex reads `$HOME/.agents/skills` directly. Claude documents account-local
`skills` folders and supports symlinked skill directories, but does not document
reading `.agents/skills`. Shared installs therefore copy named skills into
`~/.agents/skills/NAME` and link them into every existing Claude profile's skills
folder. Helm also lists each account's existing personal skills. New accounts
created after a shared install need their Claude links set up separately.

A source can be an absolute local folder or an HTTPS/SSH git URL. Repositories
containing several named skills install all of them. SKILL.md frontmatter is
parsed as YAML and must declare a valid name. Duplicate names, existing skills,
reserved Claude names and links escaping the skill folder are rejected. Failed
copies roll back; removals of shared skills affect every linked account on that
machine. Install/removal operations are serialized to prevent overlapping CLI
config writes. Plugin marketplaces must already be configured in the CLI.

The manager lists personal skills and configured plugins, not bundled system
skills, cloud-only connectors or project skills outside the chosen context.
Claude local connector entries show their project folders; shared `.mcp.json`
entries are shown after choosing a project folder in the screen.

## Validation boundaries

Real authenticated `codex` and `claudea` profiles each completed add → parsed
list → remove for a uniquely named harmless stdio command, with final absence
checked. No test server remained. Browser tests use a sandboxed client fixture,
not the owner's running daemon. Actual OAuth completion, provider account
eligibility and installations into the owner's plugin marketplaces were not
performed. Terminal environment isolation, command routing, plugin mutations,
secret masking, skill links/rollback and config parsing have regression tests.

The worktree initially lacked a Node ABI 147 PTY binary because dependency install
scripts were blocked. The first full-suite attempt stalled in proc-host cleanup.
Building only the worktree's native dependency with
`npm exec --yes --package=node-gyp -- node-gyp rebuild --directory node_modules/@homebridge/node-pty-prebuilt-multiarch --nodedir=/usr`
restored normal validation; `node --test test/proc-host.test.mjs` then passed 8/8.
No installed checkout or running Helm daemon was changed.

Final checks on the finished feature:

- `npm exec --workspace @helm/web -- tsc --noEmit`: passed.
- `npm --workspace @helm/web run build`: passed; Integrations is a separate lazy chunk.
- `node --test test/integrations.test.mjs`: 13 passed, including native argument
  ordering, shared removal without an account, alternate shared links and
  sanitized errors when malformed configuration contains credentials.
- `node --test test/browser/integrations.test.mjs`: 3 passed. List and add-sheet
  behavior, machine/account routing, terminal opening and unsupported accounts
  were checked at 390px and desktop width. Screenshots were visually inspected.
- `node --test --test-concurrency=2 test/*.test.mjs`: 1,096 passed, 5 failed
  out of 1,101, with no skips or cancellations. The failure in
  `driver-claude.test.mjs:153` expects `null` effort but gets `undefined`.
  Four `native-cli.test.mjs:74` cases fail: Claude accepts input that the test
  expects to reject; the remaining engines encounter the leftover Claude session.
  Those failures also reproduce in isolation. The two test files, Claude driver,
  native launcher and native integration implementation are unchanged from
  6da47b1. They were not repaired as part of this assigned integration work.
- `git diff --check`: passed.

The real Claude stdio smoke was repeated with an environment value. A separate
isolated Claude configuration verified native HTTP/header add, header masking
in the list and native remove. The owner account test entries and the isolated
configuration were removed. CLI OAuth completion, remote-machine behavior,
real marketplace installs and git-URL skill downloads remain unverified.
