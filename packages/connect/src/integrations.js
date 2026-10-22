import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdir, mkdtemp, cp, rm, lstat, realpath, symlink, unlink } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { getProfiles, materialize } from './profiles.js';
import { ENGINES } from './engines.js';
import { expand, HELM_DIR } from './paths.js';

const exec = promisify(execFile);
// CLI commands rewrite their config files. Serialize manager mutations so two
// open sheets cannot overwrite each other's changes or partially copy a skill.
let pendingMutation = Promise.resolve();
function serialize(work) {
  const next = pendingMutation.then(work, work);
  pendingMutation = next.catch(() => {});
  return next;
}
export const addMcp = (p, profiles) => serialize(() => addMcpUnlocked(p, profiles));
export const removeMcp = (p, profiles) => serialize(() => removeMcpUnlocked(p, profiles));
export const changePlugin = (p, remove = false, profiles) => serialize(() => changePluginUnlocked(p, remove, profiles));
export const addSkills = (p, profiles) => serialize(() => addSkillsUnlocked(p, profiles));
export const removeSkill = (p, profiles) => serialize(() => removeSkillUnlocked(p, profiles));

// Endpoints checked 2026-10-11 against the publishers, not copied from directories.
const remote = (name, title, description, url, source, setup = '') => ({ name, title, description, transport: 'http', url, source, needsSignIn: true, setup });
const googleSource = 'https://developers.google.com/workspace/guides/configure-mcp-servers';
const googleSetup = 'Join Google Developer Preview. Enable a Cloud project. Create your own OAuth sign-in client. Follow the setup guide before connecting.';
export const CONNECTORS = [
  // https://developers.google.com/workspace/guides/configure-mcp-servers
  remote('google-drive', 'Google Drive', 'Files and documents · Google Developer Preview', 'https://drivemcp.googleapis.com/mcp/v1', googleSource, googleSetup),
  remote('google-calendar', 'Google Calendar', 'Events and availability · Google Developer Preview', 'https://calendarmcp.googleapis.com/mcp/v1', googleSource, googleSetup),
  remote('gmail', 'Gmail', 'Email and drafts · Google Developer Preview', 'https://gmailmcp.googleapis.com/mcp/v1', googleSource, googleSetup),
  // https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md
  remote('github', 'GitHub', 'Git projects, issues and pull requests', 'https://api.githubcopilot.com/mcp/', 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md'),
  // https://developers.notion.com/guides/mcp/get-started-with-mcp
  remote('notion', 'Notion', 'Pages and search', 'https://mcp.notion.com/mcp', 'https://developers.notion.com/guides/mcp/get-started-with-mcp'),
  // https://linear.app/docs/mcp
  remote('linear', 'Linear', 'Issues and projects', 'https://mcp.linear.app/mcp', 'https://linear.app/docs/mcp'),
  // https://docs.slack.dev/ai/slack-mcp-server/ (no dynamic client registration)
  remote('slack', 'Slack', 'Messages and channels', 'https://mcp.slack.com/mcp', 'https://docs.slack.dev/ai/slack-mcp-server/', 'Register a Slack OAuth sign-in app. Follow the setup guide.'),
  // https://mcp.sentry.dev/
  remote('sentry', 'Sentry', 'Errors and debugging', 'https://mcp.sentry.dev/mcp', 'https://mcp.sentry.dev/'),
  // https://github.com/upstash/context7
  { ...remote('context7', 'Context7', 'Current library documentation', 'https://mcp.context7.com/mcp', 'https://github.com/upstash/context7', 'Use an API key for higher limits.'), needsSignIn: false },
  // https://github.com/microsoft/playwright-mcp
  { name: 'playwright', title: 'Playwright', description: 'Control a browser on this machine', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], needsSignIn: false, source: 'https://github.com/microsoft/playwright-mcp' },
];

export function maskTarget(value) {
  if (typeof value !== 'string') return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      u.username = ''; u.password = ''; u.hash = '';
      for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
      return u.toString();
    } catch { return '[invalid URL]'; }
  }
  return value.replace(/[\r\n\x00]/g, '').slice(0, 500);
}
// Runners that start a package named in their arguments, and the word that
// comes before it ('' when the package is the first plain argument).
const RUNNERS = { npx: '', bunx: '', uvx: '', pipx: 'run', pnpm: 'dlx', yarn: 'dlx', docker: 'run', podman: 'run' };
const VALUE_FLAGS = new Set(['-e', '--env', '--env-file', '-v', '--volume', '--mount', '-p', '--publish', '--package', '--name', '--network', '-w', '--workdir', '-u', '--user', '--entrypoint', '-l', '--label', '--from', '--with', '--python', '--index-url']);
/**
 * The package a connector's command starts (`npx -y @playwright/mcp`, `uvx
 * mcp-server-git`, `docker run … ghcr.io/github/github-mcp-server`), without
 * its version, so the page can show that service's logo. Arguments can hold
 * secrets, so only that one word is ever read, and only when it looks like a
 * package: lowercase, short parts, no long run of digits.
 */
export function packageOf(command, args = []) {
  if (typeof command !== 'string' || !Array.isArray(args)) return undefined;
  const [program = '', ...inline] = command.trim().split(/\s+/);
  const verb = RUNNERS[program.split('/').pop()];
  if (verb === undefined) return undefined;
  const list = [...inline, ...args];
  let i = verb ? list.indexOf(verb) + 1 : 0;
  if (verb && !i) return undefined;
  for (; i < list.length; i++) {
    const word = list[i];
    if (typeof word !== 'string') return undefined;
    if (!word.startsWith('-')) {
      const name = word.replace(/(?<=.)@[^/]*$/, '').replace(/:[\w.-]*$/, '').replace(/[=<>~![].*$/, '');
      return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)*$/.test(name) && name.length <= 100 && !/\d{5}/.test(name)
        && name.split(/[/._-]/).every((part) => part.length <= 24) ? name : undefined;
    }
    if (VALUE_FLAGS.has(word)) i++;
  }
  return undefined;
}
const row = (name, c, scope, cwd) => {
  const pkg = packageOf(c.command, c.args);
  return { name, scope, ...(cwd ? { cwd } : {}), transport: c.type ?? (c.url || c.httpUrl || c.serverUrl ? 'http' : 'stdio'),
    // Arguments, headers and environment values can be arbitrary secrets. Never send them.
    target: maskTarget(c.url ?? c.httpUrl ?? c.serverUrl ?? (typeof c.command === 'string' ? c.command.trim().split(/\s+/)[0] : '')),
    ...(pkg ? { package: pkg } : {}), status: c.enabled === false ? 'disabled' : 'configured' };
};
export function parseClaudeConfig(text, projectText = '{}', cwd) {
  const config = JSON.parse(text), project = JSON.parse(projectText);
  return [ ...Object.entries(config.mcpServers ?? {}).map(([n, c]) => row(n, c, 'user')),
    ...Object.entries(config.projects ?? {}).flatMap(([dir, p]) => Object.entries(p.mcpServers ?? {}).map(([n, c]) => row(n, c, 'local', dir))),
    ...Object.entries(project.mcpServers ?? {}).map(([n, c]) => row(n, c, 'project', cwd)) ];
}
export function parseCodexConfig(text) {
  const config = parse(text);
  return { mcp: Object.entries(config.mcp_servers ?? {}).map(([n, c]) => row(n, c, 'user')),
    plugins: Object.entries(config.plugins ?? {}).map(([name, c]) => ({ name, scope: 'user', enabled: c.enabled !== false })) };
}
const textFile = async (file, fallback) => { try { return await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
const jsonFile = async (file) => JSON.parse(await textFile(file, '{}'));
const supported = (profile) => ['claude', 'codex'].includes(profile.engine);
function account(profile) {
  const spec = materialize(profile), engine = ENGINES[profile.engine];
  const home = expand(spec.env[engine?.homeEnv] || engine?.defaultHome || '~');
  // The daemon may itself run inside a chat whose environment names another
  // account's home (a Helm session carries CLAUDE_CONFIG_DIR). Only this
  // profile's own choice of home reaches its CLI.
  const env = { ...process.env, ...spec.env };
  for (const other of new Set(Object.values(ENGINES).map((e) => e.homeEnv).filter(Boolean))) {
    if (other !== engine?.homeEnv && !(other in (spec.env ?? {}))) delete env[other];
  }
  if (engine?.homeEnv) {
    // Setting Claude's default directory explicitly changes its JSON path.
    if (profile.engine === 'claude' && !spec.env[engine.homeEnv]) delete env[engine.homeEnv];
    else env[engine.homeEnv] = home;
  }
  // Chat flags such as --yolo are not accepted by management subcommands. A
  // discovered wrapper still needs its launcher arguments to reach the binary.
  const args = spec.cmd === engine?.bin || /\/(claude|codex)$/.test(spec.cmd) ? [] : spec.args;
  return { home, env, cmd: spec.cmd, args, userHome: spec.env.HOME || homedir(), customHome: !!spec.env[engine?.homeEnv] };
}
async function profileFor(id, profiles) {
  const p = (profiles ?? await getProfiles()).find((p) => p.id === id && !p.disabled);
  if (!p) throw new Error('Choose an account on this machine.');
  if (!supported(p)) throw new Error('This CLI is not supported by the manager yet.');
  return p;
}
const validName = (name) => { if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) throw new Error('Use a name with letters, numbers, dots, hyphens or underscores.'); return name; };
function location(p, a) {
  const scope = p.scope ?? 'user';
  if (!['user', 'project', 'local'].includes(scope)) throw new Error('Choose a valid scope.');
  if (a.engine === 'codex' && scope !== 'user') throw new Error('Codex MCP settings apply to the account; choose user scope.');
  if (scope !== 'user' && (!isAbsolute(p.cwd ?? '') || p.cwd.includes('\0'))) throw new Error('Choose an absolute project folder on this machine.');
  return { scope, cwd: p.cwd ? resolve(p.cwd) : account(a).userHome };
}
export async function runAccount(profile, args, { cwd, secretValues = [], extraEnv = {} } = {}) {
  const a = account(profile);
  try {
    const r = await exec(a.cmd, [...a.args, ...args], { cwd: cwd ?? a.userHome, env: { ...a.env, ...extraEnv }, timeout: 60_000, maxBuffer: 1 << 20 });
    return r.stdout;
  } catch (e) {
    let message = e.stderr || 'The CLI could not complete this change. Check that it is installed and supports this command.';
    // A CLI may echo supplied values on failure; redact before the RPC sees it.
    for (const s of [...secretValues, ...Object.values(a.env)].filter((s) => typeof s === 'string' && s.length > 3).sort((a, b) => b.length - a.length)) message = message.split(s).join('***');
    message = message.replace(/https?:\/\/[^\s"']+/g, maskTarget);
    throw new Error(message.slice(0, 1500).trim());
  }
}
function skillMeta(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!front) throw new Error('SKILL.md needs frontmatter with a name.');
  let meta;
  try { meta = parseYaml(front); } catch { throw new Error('SKILL.md has invalid YAML frontmatter.'); }
  const name = validName(meta?.name);
  if (['synced', 'anthropic-skills'].includes(name.toLowerCase())) throw new Error('That skill name is reserved by Claude.');
  return { name, description: typeof meta.description === 'string' ? meta.description.slice(0, 500) : '' };
}
async function skillRows(dir, sharedRoot) {
  const rows = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    try { const meta = skillMeta(await readFile(join(path, 'SKILL.md'), 'utf8'));
      const target = await realpath(path);
      rows.push({ ...meta, path, real: target, folder: entry.name, shared: target.startsWith(`${sharedRoot}/`), removable: true });
    } catch { /* not every entry is a skill */ }
  }
  return rows;
}
export async function listAccount(profile, { cwd } = {}) {
  const a = account(profile), sharedRoot = join(a.userHome, '.agents', 'skills');
  if (!supported(profile)) return { profileId: profile.id, label: profile.label ?? profile.id, engine: profile.engine, mcp: [], skills: [], plugins: [], support: { mcp: false, skills: false, plugins: false, auth: 'none' } };
  let mcp = [], plugins = [];
  try {
    if (profile.engine === 'claude') {
      const config = a.customHome ? join(a.home, '.claude.json') : join(a.userHome, '.claude.json');
      mcp = parseClaudeConfig(await textFile(config, '{}'), cwd ? await textFile(join(cwd, '.mcp.json'), '{}') : '{}', cwd);
      const installed = await jsonFile(join(a.home, 'plugins', 'installed_plugins.json'));
      plugins = Object.entries(installed.plugins ?? {}).flatMap(([name, installs]) => installs.map((i) => ({ name, scope: i.scope, version: i.version, cwd: i.projectPath })));
    } else ({ mcp, plugins } = parseCodexConfig(await textFile(join(a.home, 'config.toml'), '')));
  } catch { throw new Error('Could not read this account’s configuration. Check its config file.'); }
  const own = await skillRows(join(a.home, 'skills'), sharedRoot);
  const shared = profile.engine === 'codex' ? await skillRows(sharedRoot, sharedRoot) : [];
  // One skill is often reachable twice: an account link and a shared link to
  // the same folder. Show it once and keep every link so Remove clears both.
  const byFolder = new Map();
  for (const { real, ...r } of [...own, ...shared]) {
    const key = r.shared ? r.name : real, seen = byFolder.get(key);
    // Where a linked skill really lives tells whose it is (an Omarchy skill, say).
    if (seen) seen.links.push(r.path); else byFolder.set(key, { ...r, ...(real !== r.path ? { source: real } : {}), links: [r.path] });
  }
  const skills = [...byFolder.values()];
  return { profileId: profile.id, label: profile.label ?? profile.id, engine: profile.engine, mcp, skills, plugins,
    support: { mcp: true, skills: true, plugins: true, auth: 'terminal' } };
}
export async function listIntegrations(p = {}, profiles) {
  if (p.cwd && (!isAbsolute(p.cwd) || p.cwd.includes('\0'))) throw new Error('Enter an absolute project folder on this machine.');
  const all = (profiles ?? await getProfiles()).filter((x) => !x.disabled && x.engine !== 'shell');
  if (p.profileId && !all.some((a) => a.id === p.profileId)) throw new Error('Unknown account.');
  const accounts = await Promise.all(all.map(async (a) => {
    if (p.profileId && a.id !== p.profileId) return { profileId: a.id, label: a.label ?? a.id, engine: a.engine };
    try { return await listAccount(a, p); } catch { return { profileId: a.id, label: a.label ?? a.id, engine: a.engine, error: 'Could not read this account’s configuration. Check its config file.' }; }
  }));
  return { accounts, catalog: CONNECTORS };
}
async function addMcpUnlocked(p, profiles) {
  const profile = await profileFor(p.profileId, profiles), { scope, cwd } = location(p, profile);
  const name = validName(p.name), transport = p.transport;
  if (!['http', 'sse', 'stdio'].includes(transport) || (profile.engine === 'codex' && transport === 'sse')) throw new Error('Choose HTTP or a command for this CLI.');
  if (transport !== 'stdio') { try { if (!['http:', 'https:'].includes(new URL(p.url).protocol)) throw 0; } catch { throw new Error('Enter an HTTP or HTTPS URL.'); } }
  else if (typeof p.command !== 'string' || !p.command.trim() || p.command.includes('\0')) throw new Error('Enter a command.');
  if (p.args && (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string' || a.includes('\0')))) throw new Error('Command arguments must be a list of text values.');
  const pairs = (obj) => { if (!obj) return []; if (typeof obj !== 'object' || Array.isArray(obj) || Object.entries(obj).some(([k, v]) => !/^[\w-]+$/.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v))) throw new Error('Enter valid environment or header values.'); return Object.entries(obj); };
  const env = pairs(p.env), headers = pairs(p.headers);
  if (p.callbackPort && (!Number.isInteger(p.callbackPort) || p.callbackPort < 1 || p.callbackPort > 65535)) throw new Error('Enter a callback port between 1 and 65535.');
  if (transport !== 'stdio' && env.length) throw new Error('Environment values apply to command connectors.');
  if (transport === 'stdio' && (headers.length || p.clientId || p.clientSecret)) throw new Error('Headers and OAuth client fields apply to HTTP connectors.');
  if (profile.engine === 'codex' && headers.length) throw new Error('Codex add does not support custom headers. Use a bearer token environment variable in its config file.');
  const current = await listAccount(profile, { cwd });
  if (current.mcp.some((r) => r.name === name && r.scope === scope && (scope === 'user' || r.cwd === cwd))) throw new Error('A connector with that name already exists in this scope.');
  const args = ['mcp', 'add'];
  if (profile.engine === 'claude') {
    // Claude's env/header flags are variadic: bind positionals before them.
    args.push(name, ...(transport === 'stdio' ? [] : [p.url]), '--scope', scope, '--transport', transport);
    for (const [k, v] of env) args.push('-e', `${k}=${v}`);
    for (const [k, v] of headers) args.push('-H', `${k}: ${v}`);
    if (p.clientId) args.push('--client-id', p.clientId);
    if (p.clientSecret) args.push('--client-secret');
    if (p.callbackPort) args.push('--callback-port', String(p.callbackPort));
    if (transport === 'stdio') args.push('--', p.command, ...(p.args ?? []));
  } else {
    args.push(name);
    for (const [k, v] of env) args.push('--env', `${k}=${v}`);
    if (p.clientId) args.push('--oauth-client-id', p.clientId);
    if (p.clientSecret) args.push('--oauth-client-secret', p.clientSecret);
    args.push(...(transport === 'stdio' ? ['--', p.command, ...(p.args ?? [])] : ['--url', p.url]));
  }
  await runAccount(profile, args, { cwd, secretValues: [p.url, ...(p.args ?? []), ...env.map(([, v]) => v), ...headers.map(([, v]) => v), p.clientSecret].filter(Boolean), extraEnv: p.clientSecret && profile.engine === 'claude' ? { MCP_CLIENT_SECRET: p.clientSecret } : {} });
  return { row: (await listAccount(profile, { cwd })).mcp.find((r) => r.name === name && r.scope === scope && (scope === 'user' || r.cwd === cwd)) };
}
async function removeMcpUnlocked(p, profiles) {
  const profile = await profileFor(p.profileId, profiles), { scope, cwd } = location(p, profile);
  await runAccount(profile, ['mcp', 'remove', validName(p.name), ...(profile.engine === 'claude' ? ['--scope', scope] : [])], { cwd });
  return { ok: true };
}
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export async function connectMcp(p, sessions, profiles) {
  const profile = await profileFor(p.profileId, profiles), name = validName(p.name), a = account(profile);
  const rows = (await listAccount(profile, p)).mcp;
  const selected = rows.find((r) => r.name === name && (!p.scope || r.scope === p.scope) && (!p.cwd || !r.cwd || r.cwd === p.cwd));
  if (!selected) throw new Error('That connector is no longer configured.');
  if (selected.transport === 'stdio') throw new Error('Command connectors handle authentication themselves. Follow the server’s setup guide.');
  let args = ['mcp', 'login', name, '--no-browser'];
  if (profile.engine === 'claude') {
    try { await runAccount(profile, ['mcp', 'login', '--help']); }
    catch { args = ['/mcp']; }
  }
  const environment = { ...materialize(profile).env, [ENGINES[profile.engine].homeEnv]: profile.engine === 'claude' && !a.customHome ? '' : a.home };
  const session = await sessions.integrationTerminal({ cwd: selected.cwd ?? a.userHome,
    title: `Connect ${name} (${profile.id})`, env: environment,
    command: [a.cmd, ...a.args, ...args].map(quote).join(' ') });
  return { session, sessionId: session.id };
}
async function changePluginUnlocked(p, remove = false, profiles) {
  const profile = await profileFor(p.profileId, profiles);
  if (typeof p.name !== 'string' || !/^[\w.-]+@[\w.-]+$/.test(p.name)) throw new Error('Enter plugin@marketplace from a marketplace configured in this CLI.');
  const { scope, cwd } = location(p, profile);
  const verb = profile.engine === 'claude' ? (remove ? 'uninstall' : 'install') : (remove ? 'remove' : 'add');
  // Do not auto-accept marketplace shell commands. The CLI can refuse them.
  await runAccount(profile, ['plugin', verb, p.name, '--json', ...(profile.engine === 'claude' ? ['--scope', scope] : [])], { cwd });
  return { ok: true };
}

async function addSkillsUnlocked(p, profiles) {
  const all = (profiles ?? await getProfiles()).filter((a) => supported(a) && !a.disabled);
  const sharedRoot = join(homedir(), '.agents', 'skills');
  await mkdir(HELM_DIR, { recursive: true });
  const temp = await mkdtemp(join(HELM_DIR, 'skill-install-'));
  const installed = [], links = [];
  try {
    let source = p.source;
    if (typeof source !== 'string' || source.includes('\0')) throw new Error('Enter a git URL or an absolute skill folder.');
    if (!isAbsolute(source)) {
      if (!/^(https:\/\/|ssh:\/\/|git@)/.test(source)) throw new Error('Enter a git URL or an absolute skill folder.');
      const dest = join(temp, 'repo');
      try { await exec('git', ['clone', '--depth', '1', '--', source, dest], { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); } catch { throw new Error('Could not clone that repository. Check the URL and git access on this machine.'); }
      source = dest;
    }
    const candidates = [];
    async function scan(dir) {
      if (await textFile(join(dir, 'SKILL.md'), null) !== null) { candidates.push({ dir, ...skillMeta(await readFile(join(dir, 'SKILL.md'), 'utf8')) }); return; }
      for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await scan(join(dir, e.name));
    }
    await scan(source);
    if (!candidates.length) throw new Error('No SKILL.md with a name was found in that folder.');
    const names = new Set();
    for (const c of candidates) {
      if (names.has(c.name)) throw new Error('The repository has duplicate skill names.'); names.add(c.name);
      if (await lstat(join(sharedRoot, c.name)).catch((e) => { if (e.code === 'ENOENT') return null; throw e; })) throw new Error(`Skill ${c.name} already exists. Remove it before installing another copy.`);
      for (const a of all) if (a.engine === 'claude' && await lstat(join(account(a).home, 'skills', c.name)).catch((e) => { if (e.code === 'ENOENT') return null; throw e; })) throw new Error(`Skill ${c.name} already exists in a Claude account.`);
    }
    await mkdir(sharedRoot, { recursive: true });
    for (const c of candidates) {
      const dest = join(sharedRoot, c.name);
      installed.push(dest);
      await cp(c.dir, dest, { recursive: true, dereference: true, filter: async (path) => {
        if (path.split('/').includes('.git')) return false;
        const root = await realpath(c.dir), target = await realpath(path);
        if (target !== root && !target.startsWith(`${root}/`)) throw new Error('Skill links must stay inside the skill folder.');
        return true;
      } });
      // Codex reads ~/.agents/skills directly. Claude follows account-local links.
      for (const home of new Set(all.filter((a) => a.engine === 'claude').map((a) => account(a).home))) {
        await mkdir(join(home, 'skills'), { recursive: true });
        const link = join(home, 'skills', c.name); await symlink(dest, link); links.push(link);
      }
    }
    return { names: candidates.map((c) => c.name) };
  } catch (e) {
    for (const link of links) await unlink(link).catch(() => {});
    for (const dir of installed) await rm(dir, { recursive: true, force: true });
    throw e;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
async function removeSharedSkill(skill, sharedRoot, profiles) {
  const target = await realpath(skill.path);
  if (resolve(target, '..') !== resolve(sharedRoot)) throw new Error('Only direct shared skill folders can be removed here.');
  // Aliases can name the same shared copy differently. Remove only actual links.
  const homes = new Set(profiles.filter(supported).map((p) => account(p).home));
  for (const home of homes) {
    const dir = join(home, 'skills');
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isSymbolicLink()) continue;
      const link = join(dir, entry.name);
      if (await realpath(link).catch(() => '') === target) await unlink(link);
    }
  }
  await rm(target, { recursive: true, force: true });
}
async function removeSkillUnlocked(p, profiles) {
  const all = profiles ?? await getProfiles();
  validName(p.name);
  if (!p.profileId) {
    const sharedRoot = join(homedir(), '.agents', 'skills');
    const skills = (await skillRows(sharedRoot, sharedRoot)).filter((s) => s.name === p.name);
    if (skills.length !== 1) throw new Error('Choose one installed shared skill.');
    await removeSharedSkill(skills[0], sharedRoot, all);
    return { ok: true };
  }
  const profile = await profileFor(p.profileId, all), a = account(profile);
  const folder = validName(p.folder ?? p.name), sharedRoot = join(a.userHome, '.agents', 'skills');
  const skill = (await listAccount(profile)).skills.find((s) => s.folder === folder && s.name === p.name);
  if (!skill) throw new Error('That skill is no longer installed.');
  if (skill.shared) await removeSharedSkill(skill, sharedRoot, all);
  else for (const path of skill.links) await rm(path, { recursive: true, force: true });
  return { ok: true };
}
