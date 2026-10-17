import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, cp, chmod, rm, realpath, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const sandbox = await mkdtemp(join(tmpdir(), 'helm-integrations-'));
process.env.HOME = sandbox;
process.env.HELM_DIR = join(sandbox, '.helm');
process.env.HELM_SSH_DIR = join(sandbox, '.ssh');
process.env.HELM_NO_SERVICE = '1';
const { CONNECTORS, maskTarget, parseClaudeConfig, parseCodexConfig, listAccount, listIntegrations, addMcp, removeMcp, connectMcp, changePlugin, addSkills, removeSkill } = await import('../packages/connect/src/integrations.js');
after(() => rm(sandbox, { recursive: true, force: true }));
const fixture = (name) => readFile(new URL(`./fixtures/integrations/${name}`, import.meta.url), 'utf8');
async function fake(engine, suffix = '') {
  const root = join(sandbox, `${engine}${suffix}`); await mkdir(root, { recursive: true });
  const cmd = join(root, engine); await cp(new URL('./fixtures/integrations/cli.mjs', import.meta.url), cmd);
  // Use this repository's module resolution even when the executable is in the sandbox.
  await writeFile(cmd, `#!/bin/sh\nexec '${process.execPath}' '${resolve('test/fixtures/integrations/cli.mjs')}' "$@"\n`); await chmod(cmd, 0o755);
  return { id: engine + suffix, label: engine + suffix, engine, cmd, args: [], env: { [engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: root, HOME: sandbox } };
}
const calls = async (p) => (await readFile(join(p.env.CLAUDE_CONFIG_DIR || p.env.CODEX_HOME, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
test('catalog has verified publisher links, unique names, and the requested Google products', () => {
  assert.equal(new Set(CONNECTORS.map((c) => c.name)).size, CONNECTORS.length);
  for (const c of CONNECTORS) { assert.ok(c.title && c.description); assert.match(c.source, /^https:\/\//); assert.equal(typeof c.needsSignIn, 'boolean'); assert.ok(c.transport === 'http' ? new URL(c.url) : c.command && Array.isArray(c.args)); }
  for (const n of ['google-drive', 'google-calendar', 'gmail']) assert.match(CONNECTORS.find((c) => c.name === n).setup, /Preview/);
});
test('JSON parser preserves every scope and project while omitting arbitrary secrets', async () => {
  const rows = parseClaudeConfig(await fixture('claude.json'), '{"mcpServers":{"project":{"url":"https://project.test/mcp"}}}', '/project');
  assert.equal(rows.length, 5); assert.deepEqual(rows.filter((r) => r.name === 'same').map((r) => r.cwd), ['/project-a', '/project-b']);
  assert.equal(rows.at(-1).scope, 'project'); assert.equal(rows.at(-1).cwd, '/project');
  assert.equal(rows[1].target, 'node'); assert.doesNotMatch(JSON.stringify(rows), /password|hidden|secret-/);
});
test('real TOML syntax handles quoted names, multiline arrays and nested environment tables', async () => {
  const { mcp, plugins } = parseCodexConfig(await fixture('codex.toml'));
  assert.deepEqual(mcp.map((r) => r.name), ['remote.with-dot', 'echo']); assert.equal(mcp[0].status, 'disabled');
  assert.equal(mcp[1].target, 'node'); assert.equal(plugins[0].name, 'example@market');
  assert.doesNotMatch(JSON.stringify(mcp), /password|hidden|secret-/);
  assert.throws(() => parseCodexConfig('[mcp_servers'), /./);
});
test('URL masking removes userinfo, all query values and fragments', () => {
  assert.equal(maskTarget('https://a:b@x.test/mcp?innocent=credential#secret'), 'https://x.test/mcp?innocent=***');
  assert.equal(maskTarget('https://bad url'), '[invalid URL]');
});
test('native MCP add and remove stay isolated in each account and respect scope', async () => {
  for (const engine of ['claude', 'codex']) {
    const p = await fake(engine), other = await fake(engine, '-other');
    const profiles = [p, other];
    await addMcp({ profileId: p.id, name: 'echo', transport: 'stdio', command: 'node', args: ['-e', 'console.log(1)'], env: { A: 'secret' }, scope: 'user' }, profiles);
    assert.equal((await listAccount(p)).mcp[0].name, 'echo'); assert.equal((await listAccount(other)).mcp.length, 0);
    await assert.rejects(addMcp({ profileId: p.id, name: 'echo', transport: 'stdio', command: 'node', scope: 'user' }, profiles), /already exists/);
    await removeMcp({ profileId: p.id, name: 'echo', scope: 'user' }, profiles); assert.equal((await listAccount(p)).mcp.length, 0);
    const log = await calls(p); if (engine === 'claude') { assert.equal(log[0].args[0], 'echo'); assert.ok(log[0].args.indexOf('echo') < log[0].args.indexOf('-e')); } assert.equal(log.length, 2); assert.ok(log[0].args.includes('--')); assert.equal(log[1].verb, 'remove');
    if (engine === 'claude') {
      const project = join(sandbox, 'project'); await mkdir(project, { recursive: true });
      for (const scope of ['local', 'project']) {
        await addMcp({ profileId: p.id, name: 'scoped', transport: 'http', url: 'https://x.test/mcp', scope, cwd: project }, profiles);
        assert.ok((await listAccount(p, { cwd: project })).mcp.some((r) => r.name === 'scoped' && r.scope === scope && r.cwd === project));
        await removeMcp({ profileId: p.id, name: 'scoped', scope, cwd: project }, profiles);
      }
    } else await assert.rejects(addMcp({ profileId: p.id, name: 'project', scope: 'project', cwd: sandbox }, profiles), /user scope/);
  }
});
test('headers, OAuth secrets, errors and configuration failures never expose credentials', async () => {
  const p = await fake('claude', '-secret'); p.env.FAILURE_SECRET = 'secret-token'; p.env.HEADER_SECRET = 'header-token';
  await assert.rejects(addMcp({ profileId: p.id, name: 'failure', transport: 'http', url: 'https://x.test', headers: { Authorization: 'header-token' } }, [p]), (e) => !/secret-token|header-token/.test(e.message));
  await addMcp({ profileId: p.id, name: 'oauth', transport: 'http', url: 'https://x.test', clientId: 'id', clientSecret: 'oauth-secret', callbackPort: 8080 }, [p]);
  const call = (await calls(p)).at(-1); assert.equal(call.secret, 'oauth-secret'); assert.ok(call.args.includes('--client-secret')); assert.ok(!call.args.includes('oauth-secret'));
  await writeFile(join(p.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'broken secret-token');
  await assert.rejects(addMcp({ profileId: p.id, name: 'safe-error', transport: 'stdio', command: 'node' }, [p]), (e) => /configuration/.test(e.message) && !/secret-token/.test(e.message));
  const reply = await listIntegrations({}, [p]); assert.match(reply.accounts[0].error, /configuration/); assert.doesNotMatch(JSON.stringify(reply), /secret-token/);
});
test('Connect creates a fresh terminal with account environment, no credentials in its command', async () => {
  for (const engine of ['claude', 'codex']) {
    const p = await fake(engine, '-login'); p.env.API_TOKEN = 'must-not-echo';
    await addMcp({ profileId: p.id, name: 'remote', transport: 'http', url: 'https://x.test' }, [p]);
    let options;
    const result = await connectMcp({ profileId: p.id, name: 'remote' }, { integrationTerminal: async (o) => { options = o; return { id: 'new-terminal' }; } }, [p]);
    assert.equal(result.sessionId, 'new-terminal'); assert.equal(options.env.API_TOKEN, 'must-not-echo'); assert.doesNotMatch(options.command, /must-not-echo/); assert.match(options.command, /'mcp' 'login' 'remote' '--no-browser'/);
  }
});
test('plugin mutations use each CLI native verbs and do not accept arbitrary commands', async () => {
  for (const engine of ['claude', 'codex']) {
    const p = await fake(engine, '-plugin');
    await changePlugin({ profileId: p.id, name: 'sample@market' }, false, [p]); assert.equal((await listAccount(p)).plugins[0].name, 'sample@market');
    await changePlugin({ profileId: p.id, name: 'sample@market' }, true, [p]); assert.equal((await listAccount(p)).plugins.length, 0);
    assert.deepEqual((await calls(p)).map((c) => c.verb), engine === 'claude' ? ['install', 'uninstall'] : ['add', 'remove']);
    await assert.rejects(changePlugin({ profileId: p.id, name: '--evil' }, false, [p]), /plugin@marketplace/);
  }
});
test('shared skill install, duplicate protection and removal preserve unrelated accounts', async () => {
  const p = await fake('claude', '-skills'), other = await fake('claude', '-skills-other'), codex = await fake('codex', '-skills');
  const source = join(sandbox, 'source'); await mkdir(source); await writeFile(join(source, 'SKILL.md'), '---\nname: example-skill\ndescription: Example for tests\n---\nInstructions.');
  const profiles = [p, other, codex];
  assert.deepEqual((await addSkills({ source }, profiles)).names, ['example-skill']);
  const dest = join(sandbox, '.agents/skills/example-skill');
  for (const a of [p, other]) assert.equal(await realpath(join(a.env.CLAUDE_CONFIG_DIR, 'skills/example-skill')), dest);
  assert.equal((await listAccount(codex)).skills[0].shared, true);
  await assert.rejects(addSkills({ source }, profiles), /already exists/);
  await symlink(dest, join(other.env.CLAUDE_CONFIG_DIR, 'skills/alternate-name'));
  await removeSkill({ name: 'example-skill' }, profiles);
  await assert.rejects(lstat(join(other.env.CLAUDE_CONFIG_DIR, 'skills/alternate-name')), /ENOENT/);
  assert.equal((await listAccount(codex)).skills.length, 0); assert.equal((await listAccount(other)).skills.length, 0);
  await assert.rejects(lstat(dest), /ENOENT/);
  await writeFile(join(source, 'SKILL.md'), '---\ndescription: No name\n---');
  await assert.rejects(addSkills({ source }, profiles), /name/);
  await assert.rejects(removeSkill({ profileId: p.id, name: '../escape' }, profiles), /name/);
});
test('a skill linked from two places lists once and Remove clears both links', async () => {
  const codex = await fake('codex', '-twice'), system = join(sandbox, 'system-skills/crash');
  await mkdir(system, { recursive: true }); await writeFile(join(system, 'SKILL.md'), '---\nname: crash\ndescription: From the system\n---');
  await mkdir(join(codex.env.CODEX_HOME, 'skills'), { recursive: true }); await mkdir(join(sandbox, '.agents/skills'), { recursive: true });
  await symlink(system, join(codex.env.CODEX_HOME, 'skills/crash')); await symlink(system, join(sandbox, '.agents/skills/crash'));
  const rows = (await listAccount(codex)).skills.filter((s) => s.name === 'crash');
  assert.equal(rows.length, 1); assert.equal(rows[0].links.length, 2);
  await removeSkill({ profileId: codex.id, name: 'crash', folder: 'crash' }, [codex]);
  for (const link of [join(codex.env.CODEX_HOME, 'skills/crash'), join(sandbox, '.agents/skills/crash')]) await assert.rejects(lstat(link), /ENOENT/);
  assert.ok(await lstat(join(system, 'SKILL.md')), 'the folder both links pointed at stays');
});
test('unsupported engines are explicit and never spawn their CLIs', async () => {
  const p = { id: 'gemini', engine: 'gemini', label: 'Gemini' };
  assert.equal((await listIntegrations({}, [p])).accounts[0].support.mcp, false);
  await assert.rejects(addMcp({ profileId: p.id, name: 'x' }, [p]), /not supported/);
});

test('skill copies roll back when a repository link escapes its folder', async () => {
  const p = await fake('claude', '-rollback');
  const source = join(sandbox, 'escaping-skill'); await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '---\nname: escaping-skill\ndescription: >\n  A description\n  across lines.\n---');
  const privateFile = join(sandbox, 'private'); await writeFile(privateFile, 'private-value');
  await symlink(privateFile, join(source, 'external-file'));
  await assert.rejects(addSkills({ source }, [p]), /inside the skill folder/);
  await assert.rejects(lstat(join(sandbox, '.agents/skills/escaping-skill')), /ENOENT/);
  await assert.rejects(lstat(join(p.env.CLAUDE_CONFIG_DIR, 'skills/escaping-skill')), /ENOENT/);
});
test('simultaneous account mutations preserve both additions', async () => {
  const p = await fake('codex', '-concurrent');
  await Promise.all(['one', 'two'].map((name) => addMcp({ profileId: p.id, name, transport: 'stdio', command: 'node' }, [p])));
  assert.deepEqual((await listAccount(p)).mcp.map((r) => r.name), ['one', 'two']);
});
test('the session manager puts secrets only in a fresh terminal environment', async () => {
  const { EventEmitter } = await import('node:events');
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  class Terminals extends EventEmitter {
    opened = []; written = [];
    async ensure() { return true; }
    async open(id, options) { this.opened.push({ id, options }); }
    async write(id, text) { this.written.push({ id, text }); }
  }
  const terminals = new Terminals();
  const sessions = new Sessions(new EventEmitter(), { terminals, nativeDiscovery: false });
  try {
    const first = await sessions.integrationTerminal({ cwd: sandbox, title: 'Existing terminal', env: {}, command: 'echo first' });
    const second = await sessions.integrationTerminal({ cwd: sandbox, title: 'Connect account', env: { API_TOKEN: 'private-token' }, command: 'codex mcp login remote --no-browser' });
    assert.notEqual(first.id, second.id);
    assert.equal(terminals.opened.at(-1).options.env.API_TOKEN, 'private-token');
    assert.deepEqual(terminals.written.at(-1), { id: second.id, text: 'codex mcp login remote --no-browser\r' });
    assert.doesNotMatch(JSON.stringify(sessions.get(second.id)), /private-token/);
    assert.doesNotMatch(await readFile(join(process.env.HELM_DIR, 'sessions.json'), 'utf8'), /private-token/);
  } finally { await sessions.stop(); }
});
