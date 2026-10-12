import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The state file lives under HELM_DIR; keep it out of the owner's.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-cli-updates-'));
const { CliUpdater, classifyInstall, parseVersion, isNewer } = await import('../packages/connect/src/cli-updates.js');
const { cliAutoUpdate, saveCliAutoUpdate } = await import('../packages/connect/src/settings.js');

const HOME = '/home/ada';
const yes = () => true;

test('version text from different tools is read the same way', () => {
  assert.equal(parseVersion('2.1.296 (Claude Code)'), '2.1.296');
  assert.equal(parseVersion('codex-cli 0.161.0'), '0.161.0');
  assert.equal(parseVersion('grok 1.0.50 (c58f321264ba)'), '1.0.50');
  assert.equal(parseVersion('opencode v2.0.14'), '2.0.14');
  assert.equal(parseVersion('2026.08.11-e8db854'), '2026.08.11-e8db854');
  assert.equal(parseVersion('\x1b[1mdevin\x1b[0m 3000.11.3'), '3000.11.3');
  assert.equal(parseVersion('no number here'), null);
  assert.equal(isNewer('1.1.0', '0.99.1'), true);
  assert.equal(isNewer('0.99.1', '0.99.1'), false);
  assert.equal(isNewer(null, '1.0.0'), false);
});

test('install kind: what is ours to update, and how', () => {
  const ctx = { npmRoot: `${HOME}/.local/lib/node_modules`, home: HOME, canWrite: yes, pkgNameOf: (dir) => dir.split('node_modules/')[1] };
  const plan = (engine, path, over = {}) => classifyInstall(engine, path, { ...ctx, ...over });

  // The native installers use the tool's own updater.
  const claude = plan('claude', `${HOME}/.local/share/claude/versions/2.1.296`);
  assert.deepEqual([claude.method, claude.canUpdate, claude.command.args], ['self', true, ['update']]);
  assert.equal(plan('codex', `${HOME}/.codex/packages/standalone/releases/0.161.0/bin/codex`).command.args[0], 'update');
  assert.equal(plan('opencode2', `${HOME}/.opencode/bin/opencode2`).command.args[0], 'upgrade');

  // npm: only the exact package, inside npm's own global folder.
  const codex = plan('codex', `${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js`);
  assert.deepEqual([codex.method, codex.canUpdate, codex.command], ['npm', true, { cmd: 'npm', args: ['install', '-g', '@openai/codex@latest'] }]);
  assert.equal(plan('pi', `${HOME}/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`).pkg, '@earendil-works/pi-coding-agent');
  assert.equal(plan('gemini', `${HOME}/.local/lib/node_modules/@google/gemini-cli/dist/index.js`).command.args[2], '@google/gemini-cli@latest');

  // A different package pretending to be a tool, or a folder we can not write.
  const wrong = plan('codex', `${HOME}/.local/lib/node_modules/some-other-thing/bin/codex.js`);
  assert.equal(wrong.canUpdate, false);
  assert.match(wrong.reason, /does not recognise/);
  assert.match(plan('codex', `${HOME}/.local/lib/node_modules/@openai/codex/bin/codex.js`, { canWrite: () => false }).reason, /can not write/);
  assert.match(plan('claude', `${HOME}/.nvm/versions/node/v20/lib/node_modules/@anthropic-ai/claude-code/cli.js`).reason, /another Node/);
  assert.match(plan('claude', `${HOME}/.nvm/versions/node/v20/lib/node_modules/@anthropic-ai/claude-code/cli.js`, { npmRoot: null }).reason, /can not find npm/);

  // Not ours: system packages, Homebrew, other package managers.
  for (const [path, words] of [
    ['/usr/bin/claude', /system/], ['/opt/claude/bin/claude', /system/], ['/usr/local/bin/claude', /system/],
    ['/opt/homebrew/Cellar/codex/1.0/bin/codex', /Homebrew/], ['/home/linuxbrew/.linuxbrew/bin/claude', /Homebrew/],
    [`${HOME}/.bun/install/global/node_modules/x/claude`, /bun/],
    [`${HOME}/.local/share/uv/tools/claude/bin/claude`, /Python/],
    ['/nix/store/abc-claude/bin/claude', /system/],
  ]) {
    const r = plan(path.includes('codex') ? 'codex' : 'claude', path);
    assert.equal(r.canUpdate, false, path);
    assert.match(r.reason, words, path);
    assert.equal(r.command, undefined, path);
  }

  // Own updater, but not in this user's home or not writable.
  assert.match(plan('claude', '/srv/tools/claude').reason, /outside your home/);
  assert.match(plan('claude', `${HOME}/.local/share/claude/versions/1`, { canWrite: () => false }).reason, /not writable/);
  // No updater known at all.
  assert.match(plan('kimi', `${HOME}/.local/bin/kimi`).reason, /no automatic updater/);
  assert.equal(plan('gemini', `${HOME}/bin/gemini`).canUpdate, false);
  // Windows paths and a lower-case drive are still "in the home folder".
  assert.equal(plan('claude', 'C:\\Users\\Ada\\AppData\\claude\\claude.exe', { home: 'c:\\Users\\Ada', platform: 'win32' }).canUpdate, true);
});

// ------------------------------------------------------- a fake machine

/** A scratch home with a bin folder of fake tools; PATH is that folder alone. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), 'helm-fake-machine-'));
  const home = join(root, 'home');
  const bin = join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const script = (path, body) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);

  // A tool with its own updater: `update` moves it from `from` to `to`.
  const selfTool = (name, label, from, to, dir = bin, sub = 'update') => {
    const vf = join(root, `${name}.version`);
    writeFileSync(vf, from);
    script(join(dir, name), `VF='${vf}'
case "$1" in
  --version) read -r v < "$VF"; echo "${label} $v";;
  ${sub}) echo "${name} $@" >> '${log}'; echo "fetching"; echo "${to}" > "$VF"; echo "now ${to}";;
esac`);
    return { version: () => readFileSync(vf, 'utf8').trim() };
  };

  // npm with a global folder, and one package in it linked onto PATH.
  const npmRoot = join(root, 'npm/lib/node_modules');
  mkdirSync(npmRoot, { recursive: true });
  const npm = (pkg, name, from, to) => {
    const dir = join(npmRoot, ...pkg.split('/'));
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg }));
    const vf = join(root, `${name}.version`);
    writeFileSync(vf, from);
    script(join(dir, 'bin', name), `read -r v < '${vf}'; echo "${name} $v"`);
    symlinkSync(join(dir, 'bin', name), join(bin, name));
    script(join(bin, 'npm'), `case "$1 $2" in
  "root -g") echo '${npmRoot}';;
  "view ${pkg}") echo "${to}";;
  "install -g") echo "npm $@" >> '${log}'; echo "${to}" > '${vf}'; echo "added 1 package";;
esac`);
    return { version: () => readFileSync(vf, 'utf8').trim() };
  };

  const updater = (extra = {}) => new CliUpdater({
    env: { PATH: bin }, home, log: () => {}, ...extra,
  });
  return { root, home, bin, calls, selfTool, npm, updater };
}

test('lists what is installed with version, install kind and the reason when it can not update', async () => {
  const m = machine();
  m.selfTool('claude', 'Claude', '2.1.0', '2.2.0');
  m.npm('@openai/codex', 'codex', '0.150.0', '0.160.0');
  // Outside the (fake) home: its own updater exists, but it is not ours to run.
  const elsewhere = join(m.root, 'system-bin');
  mkdirSync(elsewhere);
  m.selfTool('grok', 'grok', '1.0.1', '1.0.2', elsewhere);
  symlinkSync(join(elsewhere, 'grok'), join(m.bin, 'grok'));

  const { tools, auto, running } = await m.updater().versions({ refresh: true });
  const by = Object.fromEntries(tools.map((t) => [t.engine, t]));
  assert.equal(auto, true);
  assert.deepEqual(running, []);
  assert.deepEqual(Object.keys(by).sort(), ['claude', 'codex', 'grok']);
  assert.deepEqual([by.claude.version, by.claude.method, by.claude.canUpdate], ['2.1.0', 'self', true]);
  assert.deepEqual([by.codex.version, by.codex.method, by.codex.canUpdate, by.codex.latest, by.codex.outdated], ['0.150.0', 'npm', true, '0.160.0', true]);
  assert.equal(by.grok.canUpdate, false);
  assert.match(by.grok.reason, /outside your home/);
  assert.equal(by.claude.lastResult, undefined);
  assert.deepEqual(m.calls(), [], 'looking never updates');
});

test('update runs the safe command, records before and after, and leaves the rest alone', async () => {
  const m = machine();
  const claude = m.selfTool('claude', 'Claude', '2.1.0', '2.2.0');
  const codex = m.npm('@openai/codex', 'codex', '0.150.0', '0.160.0');
  const results = await m.updater().update();

  assert.deepEqual(m.calls().sort(), ['claude update', 'npm install -g @openai/codex@latest']);
  assert.equal(claude.version(), '2.2.0');
  assert.equal(codex.version(), '0.160.0');
  const by = Object.fromEntries(results.map((r) => [r.engine, r]));
  assert.deepEqual([by.claude.ok, by.claude.from, by.claude.to, by.claude.changed], [true, '2.1.0', '2.2.0', true]);
  assert.deepEqual([by.codex.from, by.codex.to], ['0.150.0', '0.160.0']);

  // It is remembered on disk and shown next time.
  const state = JSON.parse(readFileSync(join(process.env.HELM_DIR, 'cli-updates.json'), 'utf8'));
  assert.equal(state.engines.claude.lastResult.to, '2.2.0');
  assert.ok(state.engines.claude.lastResult.at > 0);
  const again = await m.updater().versions({ refresh: true });
  assert.equal(again.tools.find((t) => t.engine === 'claude').lastResult.changed, true);

  // Asking again when already current changes nothing and says so.
  const second = await m.updater().update({ engine: 'claude' });
  assert.equal(second.length, 1);
  assert.deepEqual([second[0].ok, second[0].changed, second[0].from, second[0].to], [true, false, '2.2.0', '2.2.0']);
});

test('a tool it can not update safely is never attempted', async () => {
  const m = machine();
  // Own updater, wrong place (not under the home folder).
  const away = join(m.root, 'usr-ish');
  mkdirSync(away);
  const codex = m.selfTool('codex', 'codex-cli', '0.1.0', '0.2.0', away);
  symlinkSync(join(away, 'codex'), join(m.bin, 'codex'));
  // Right place, but no updater is known for it.
  const kimi = m.selfTool('kimi', 'kimi', '1.0.0', '2.0.0');
  // npm package that is not the one this tool ships as.
  const odd = m.npm('totally-different-pkg', 'gemini', '1.0.0', '9.9.9');

  const updater = m.updater();
  const all = await updater.update();
  assert.deepEqual(m.calls(), [], 'no update command ran for any of them');
  assert.equal(codex.version(), '0.1.0');
  assert.equal(kimi.version(), '1.0.0');
  assert.equal(odd.version(), '1.0.0');
  assert.ok(all.length >= 3 && all.every((r) => r.skipped && r.ok === false && r.reason), JSON.stringify(all));

  // Asking for just that one by name is no different.
  const one = await updater.update({ engine: 'codex' });
  assert.equal(one[0].skipped, true);
  assert.deepEqual(m.calls(), []);
  assert.throws(() => updater.begin({ engine: 'not-a-tool' }), /unknown coding tool/);
});

test('a failed update is recorded and the old version stays', async () => {
  const m = machine();
  const vf = join(m.root, 'claude.version');
  writeFileSync(vf, '2.1.0');
  writeFileSync(join(m.bin, 'claude'), `#!/bin/sh
case "$1" in --version) echo "2.1.0 (Claude Code)";; update) echo "network is down" >&2; exit 3;; esac\n`);
  chmodSync(join(m.bin, 'claude'), 0o755);
  const [r] = await m.updater().update({ engine: 'claude' });
  assert.deepEqual([r.ok, r.changed, r.to, r.message], [false, false, '2.1.0', 'network is down']);
});

test('the schedule does nothing while automatic updating is off, and runs when it is on', async () => {
  const m = machine();
  const claude = m.selfTool('claude', 'Claude', '2.1.0', '2.2.0');
  let on = false;
  const updater = m.updater({ auto: () => on, firstRunMs: 10, everyMs: 3_600_000 });
  assert.equal(await updater.tick(), null);
  updater.start();
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(m.calls(), [], 'off: nothing ran');
  assert.equal(claude.version(), '2.1.0');
  updater.stop();

  // On: the first run comes by itself a moment after start.
  on = true;
  const live = m.updater({ auto: () => on, firstRunMs: 10, everyMs: 3_600_000 });
  live.start();
  const until = Date.now() + 5_000;
  while (!m.calls().length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  live.stop();
  assert.deepEqual(m.calls(), ['claude update']);
  assert.equal(claude.version(), '2.2.0');

  // A stopped schedule stays stopped.
  const stopped = m.updater({ firstRunMs: 10 });
  stopped.start();
  stopped.stop();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(m.calls().length, 1);
});

test('the setting is on by default and is saved per machine', () => {
  assert.equal(cliAutoUpdate(), true);
  assert.equal(saveCliAutoUpdate(false), false);
  assert.equal(cliAutoUpdate(), false);
  assert.equal(saveCliAutoUpdate(true), true);
  assert.equal(cliAutoUpdate(), true);
});

test('on Windows a tool in use is skipped now and updated once it is free', async () => {
  const m = machine();
  const claude = m.selfTool('claude', 'Claude', '2.1.0', '2.2.0');
  let inUse = true;
  const updater = m.updater({ platform: 'win32', busy: async () => inUse, retryMs: 30 });
  const first = await updater.update({ engine: 'claude' });
  assert.deepEqual([first[0].skipped, first[0].deferred], [true, true]);
  assert.deepEqual(m.calls(), []);
  assert.equal(claude.version(), '2.1.0');
  inUse = false;
  const until = Date.now() + 5_000;
  while (!m.calls().length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  updater.stop();
  assert.deepEqual(m.calls(), ['claude update']);
  assert.ok(existsSync(join(process.env.HELM_DIR, 'cli-updates.json')));
});
