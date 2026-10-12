import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// "Compact at": the app edits one key of Claude's settings.json
// (modelSettings.<model>.autoCompactWindow) on every machine that has the
// account, and a chat that is already open uses the new size at its next reply.
const root = mkdtempSync(join(tmpdir(), 'helm-context-limit-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NO_SERVICE = '1';
delete process.env.INVOCATION_ID;
test.after(() => rmSync(root, { recursive: true, force: true }));

const { setCompactWindow, compactWindow, bareModel } = await import('../packages/connect/src/context-limit.js');

function setup(name, settings, raw) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const text = raw ?? JSON.stringify(settings, null, 2) + '\n';
  writeFileSync(file, text, { mode: 0o640 });
  return { dir, file, text };
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('setting a size changes only that key, keeps formatting, mode and a one-time backup', () => {
  const { dir, file, text } = setup('set', {
    model: 'opus', env: { KEEP: '1' }, hooks: { Stop: [] },
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'high', autoCompactWindow: 383_000 }, 'claude-fable-5-1': { effortLevel: 'medium' } },
  });
  assert.equal(setCompactWindow(dir, 'claude-opus-5-5[1m]', 500_000), true);
  const after = read(file);
  assert.equal(after.modelSettings['claude-opus-5-5'].autoCompactWindow, 500_000);
  assert.equal(after.modelSettings['claude-opus-5-5'].effortLevel, 'high');
  assert.deepEqual(after.modelSettings['claude-fable-5-1'], { effortLevel: 'medium' });
  assert.deepEqual([after.model, after.env, after.hooks], ['opus', { KEEP: '1' }, { Stop: [] }]);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(after, null, 2) + '\n', '2-space JSON with a trailing newline');
  assert.equal(statSync(file).mode & 0o777, 0o640, 'the file keeps its permissions');
  assert.equal(readFileSync(`${file}.backup-helm-compact`, 'utf8'), text, 'the first change keeps the original');
  // A second change does not overwrite that backup.
  setCompactWindow(dir, 'claude-opus-5-5', 350_000);
  assert.equal(readFileSync(`${file}.backup-helm-compact`, 'utf8'), text);
  assert.equal(compactWindow(dir, 'claude-opus-5-5'), 350_000, 'a reader sees the change at once');
  // The same value again writes nothing.
  assert.equal(setCompactWindow(dir, 'claude-opus-5-5', 350_000), false);
});

test('Full removes the key, and tidies away what was only there for it', () => {
  const { dir, file } = setup('full', {
    theme: 'dark',
    modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 383_000 }, 'claude-sonnet-5-5': { autoCompactWindow: 283_000, effortLevel: 'low' } },
  });
  setCompactWindow(dir, 'claude-opus-5-5', null);
  assert.deepEqual(read(file).modelSettings, { 'claude-sonnet-5-5': { autoCompactWindow: 283_000, effortLevel: 'low' } });
  setCompactWindow(dir, 'claude-sonnet-5-5', null);
  assert.deepEqual(read(file).modelSettings, { 'claude-sonnet-5-5': { effortLevel: 'low' } }, 'the owner\'s other model settings stay');
  setCompactWindow(dir, 'claude-opus-5-5', 750_000);
  setCompactWindow(dir, 'claude-opus-5-5', null);
  assert.equal(compactWindow(dir, 'claude-opus-5-5'), null);
  assert.equal(read(file).theme, 'dark');
  assert.equal(setCompactWindow(dir, 'claude-opus-5-5', null), false, 'nothing to remove, nothing written');
});

test('an emptied modelSettings is not left behind', () => {
  const { dir, file } = setup('empty', { theme: 'dark', modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 383_000 } } });
  setCompactWindow(dir, 'claude-opus-5-5', null);
  assert.deepEqual(read(file), { theme: 'dark' });
});

test('a model is found by its short name, whatever suffix the chat reports', () => {
  assert.equal(bareModel('Claude-Opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(bareModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  const { dir, file } = setup('bare', { modelSettings: { 'claude-haiku-4-5': { autoCompactWindow: 99_000 } } });
  setCompactWindow(dir, 'claude-haiku-4-5-20251001', 150_000);
  assert.deepEqual(read(file).modelSettings, { 'claude-haiku-4-5': { autoCompactWindow: 150_000 } }, 'edited in place, no second entry');
});

test('a missing file is created, a broken one is left alone, a symlink stays a symlink', () => {
  const dir = join(root, 'missing');
  mkdirSync(dir, { recursive: true });
  assert.equal(setCompactWindow(dir, 'claude-opus-5-5', null), false, 'Full on nothing writes nothing');
  assert.equal(existsSync(join(dir, 'settings.json')), false);
  setCompactWindow(dir, 'claude-opus-5-5', 750_000);
  assert.deepEqual(read(join(dir, 'settings.json')), { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 750_000 } } });

  const broken = setup('broken', null, '{ "model": "opus", // owner comment\n}');
  assert.throws(() => setCompactWindow(broken.dir, 'claude-opus-5-5', 500_000));
  assert.equal(readFileSync(broken.file, 'utf8'), broken.text);

  const real = setup('dotfiles', { model: 'opus' });
  const linked = join(root, 'linked');
  mkdirSync(linked);
  symlinkSync(real.file, join(linked, 'settings.json'));
  setCompactWindow(linked, 'claude-opus-5-5', 200_000);
  assert.ok(lstatSync(join(linked, 'settings.json')).isSymbolicLink());
  assert.equal(read(real.file).modelSettings['claude-opus-5-5'].autoCompactWindow, 200_000);
});

test('account.contextLimit finds the account by profile or by key, on every alias, and says when it has none', async () => {
  const personal = setup('personal', { model: 'opus' });
  const work = setup('work', { model: 'sonnet' });
  const home = (p) => ({ CLAUDE_CONFIG_DIR: p });
  mkdirSync(process.env.HELM_DIR, { recursive: true });
  writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
    { id: 'c', label: 'claude', engine: 'claude', cmd: 'claude', args: [], env: home(personal.dir), source: 'detected' },
    { id: 'cx', label: 'claude fast', engine: 'claude', cmd: 'claude', args: ['--x'], env: home(personal.dir), source: 'alias' },
    { id: 'w', label: 'work', engine: 'claude', cmd: 'claude', args: [], env: home(work.dir), source: 'alias' },
    { id: 'cod', label: 'codex', engine: 'codex', cmd: 'codex', args: [], env: { CODEX_HOME: personal.dir }, source: 'detected' },
  ] }));
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const { M } = await import('@helm/protocol');
  const N = await import('@helm/protocol/network');
  N.forgetNetwork();
  N.createNetwork({ name: 'testbox', port: 8999 });
  const d = new Daemon({ name: 'testbox', port: 8999, advertiseLan: false });
  test.after(() => d.stop());

  const a = await d.dispatch(M.CONTEXT_LIMIT, { profileId: 'cx', model: 'claude-opus-5-5[1m]', window: 500_000 });
  assert.equal(a.matched, 1, 'two aliases, one settings file');
  assert.equal(a.window, 500_000);
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(read(personal.file).modelSettings['claude-opus-5-5'].autoCompactWindow, 500_000);
  assert.equal(read(work.file).modelSettings, undefined, 'another account is untouched');

  // Another machine asks by the account key it learned from this one.
  const b = await d.dispatch(M.CONTEXT_LIMIT, { account: a.account, model: 'claude-opus-5-5', window: null });
  assert.equal(b.window, null);
  assert.equal(read(personal.file).modelSettings, undefined);
  const none = await d.dispatch(M.CONTEXT_LIMIT, { account: 'claude|~/.claude-nobody|', model: 'claude-opus-5-5', window: 500_000 });
  assert.equal(none.matched, 0);
  // A Codex login is never a Claude account, even with the same home folder.
  const codex = await d.dispatch(M.CONTEXT_LIMIT, { profileId: 'cod', model: 'claude-opus-5-5', window: 500_000 });
  assert.equal(codex.matched, 0);

  // Reading is the same call without a window.
  await d.dispatch(M.CONTEXT_LIMIT, { profileId: 'w', model: 'claude-sonnet-5-5', window: 350_000 });
  const reading = await d.dispatch(M.CONTEXT_LIMIT, { profileId: 'w', model: 'claude-sonnet-5-5' });
  assert.deepEqual([reading.window, reading.limits], [350_000, { 'claude-sonnet-5-5': 350_000 }]);

  await assert.rejects(() => d.dispatch(M.CONTEXT_LIMIT, { profileId: 'nope', model: 'claude-opus-5-5', window: 500_000 }), /unknown profile/);
  await assert.rejects(() => d.dispatch(M.CONTEXT_LIMIT, { profileId: 'c', model: 'claude-opus-5-5', window: 12 }), /whole number/);
  await assert.rejects(() => d.dispatch(M.CONTEXT_LIMIT, { profileId: 'c', model: '__proto__', window: 500_000 }), /unknown model/);
});

test('an open chat uses a size chosen after it started, at its next reply', async (t) => {
  const { ClaudeDriver } = await import('../packages/connect/src/drivers/claude.js');
  const { dir } = setup('live', { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 383_000 } } });
  let receive, exited;
  const pipe = { onData(fn) { receive = fn; }, onExit(fn) { exited = fn; }, write() {}, end() { exited({ code: 0 }); }, detach() {}, kill() { exited({ code: 0 }); } };
  const driver = new ClaudeDriver({ cmd: 'unused', env: { CLAUDE_CONFIG_DIR: dir }, cwd: '/tmp', mode: 'default',
    engineSessionId: 'existing', procId: 'hosted', procHost: { hasProc: () => false, openProc: async () => {}, procPipe: () => pipe } });
  await driver.start();
  t.after(() => driver.kill());
  const seen = [];
  let last;
  driver.on('event', (e) => { if (e.type === 'context') last = e; });
  const turn = () => {
    receive(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5[1m]', content: [], usage: { input_tokens: 1000, output_tokens: 0 } } }) + '\n');
    receive(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, modelUsage: { 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } } }) + '\n');
  };
  turn(); seen.push(last);
  setCompactWindow(dir, 'claude-opus-5-5', 500_000);
  turn(); seen.push(last);
  setCompactWindow(dir, 'claude-opus-5-5', null);
  turn(); seen.push(last);
  assert.deepEqual(seen.map((e) => e.window), [383_000, 500_000, 1_000_000]);
  assert.deepEqual(seen.at(-1), { type: 'context', used: 1000, window: 1_000_000, full: 1_000_000, model: 'claude-opus-5-5' });
});
