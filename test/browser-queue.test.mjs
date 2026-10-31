import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'helm-browser-queue-'));
process.env.HELM_DIR = root;
const { BrowserManager } = await import('../packages/connect/src/browser.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const manager = new BrowserManager({ directory: root, session: id => ({ id }), canWindow: false, actionTimeoutMs: 100 });
  manager.recover = async () => {};
  const tab = { id: 'tab', sessionId: 'chat', engine: 'chromium' };
  manager.tabs.set(tab.id, tab);
  return { manager, tab };
}

test('a timed out browser operation holds its place until it stops running', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = fixture(), started = deferred(), finished = deferred();
  const calls = [];
  manager.perform = async () => {
    calls.push('start');
    if (calls.length === 1) { started.resolve(); await finished.promise; }
    calls.push('end'); return {};
  };
  const first = manager.run('chat', 'tab', { kind: 'look' });
  const rejected = assert.rejects(first, /timed out/);
  await started.promise;
  t.mock.timers.tick(100); await rejected;
  const second = manager.run('chat', 'tab', { kind: 'look' });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['start']);
  finished.resolve(); await second;
  assert.deepEqual(calls, ['start', 'end', 'start', 'end']);
  assert.equal(manager.serial.size, 0);
});

test('an action that expires while its page loads never reaches the page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, tab } = fixture(), ready = deferred();
  tab.ready = ready.promise;
  let performed = false;
  manager.perform = async () => { performed = true; };
  const action = manager.run('chat', 'tab', { kind: 'look' });
  const rejected = assert.rejects(action, /timed out/);
  await new Promise(setImmediate);
  t.mock.timers.tick(100); await rejected;
  ready.resolve(); await new Promise(setImmediate);
  assert.equal(performed, false);
  assert.equal(manager.serial.size, 0);
});


test('a browser operation that never settles cannot block recovery forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = fixture(), started = deferred();
  manager.perform = () => { started.resolve(); return new Promise(() => {}); };
  const first = manager.run('chat', 'tab', { kind: 'look' });
  const rejected = assert.rejects(first, /timed out/);
  await started.promise;
  t.mock.timers.tick(100); await rejected;
  assert.equal(manager.serial.size, 1);
  t.mock.timers.tick(100); await new Promise(setImmediate);
  assert.equal(manager.serial.size, 0);
  manager.perform = async () => ({ recovered: true });
  assert.deepEqual(await manager.run('chat', 'tab', { kind: 'look' }), { recovered: true });
});

test('a timed out batch stops its later steps, and no page change starts while its step is still running', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = fixture(), started = deferred(), finished = deferred(), calls = [];
  manager.look = async () => ({ text: 'Page' }); manager.persistTabs = async () => {}; manager.persistSoon = () => {};
  const batch = manager.perform.bind(manager);
  manager.perform = async (tab, action, inBatch, op) => {
    if (action.kind === 'batch') return batch(tab, action, inBatch, op);
    calls.push(action.target ?? action.kind);
    if (action.target === 'Save') { started.resolve(); await finished.promise; }
    return {};
  };
  const first = manager.run('chat', 'tab', { actions: [{ click: 'Name' }, { click: 'Save' }, { click: 'Send' }, { click: 'Close' }] });
  const rejected = assert.rejects(first, error => {
    assert.equal(error.message, 'The browser action timed out during step 2 (click). That step may have landed. 1 of 4 steps finished. Steps 3–4 were not run. Read the page before you try again.');
    return true;
  });
  await started.promise;
  t.mock.timers.tick(100); await rejected;
  // The grace time ends while the Save click is still in flight.
  t.mock.timers.tick(100); await new Promise(setImmediate);
  assert.equal(manager.serial.size, 0);
  await assert.rejects(manager.run('chat', 'tab', { click: 'Delete' }), /earlier click step is still running in the page, so this action was not run/);
  assert.deepEqual(await manager.run('chat', 'tab', { kind: 'look' }), {}, 'a read still works');
  finished.resolve(); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.deepEqual(calls, ['Name', 'Save', 'look'], 'no later batch step and no other page change ran');
  await manager.run('chat', 'tab', { click: 'Delete' });
  assert.deepEqual(calls.at(-1), 'Delete', 'once the step ends, page changes run again');
});

test('a timeout says whether the step only read the page or never reached it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = fixture(), started = deferred();
  manager.perform = () => { started.resolve(); return new Promise(() => {}); };
  const reading = manager.run('chat', 'tab', { kind: 'look' });
  const rejected = assert.rejects(reading, { message: 'The browser action timed out during the look step. That step only reads the page. Read the page before you try again.' });
  await started.promise; t.mock.timers.tick(100); await rejected;
});

function stepFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, tab } = fixture();
  tab.page = { title: async () => 'Page', url: () => 'http://x/' };
  manager.look = async () => ({}); manager.metadata = () => ({}); manager.aim = async () => {}; manager.persistSoon = () => {};
  return { manager, tab };
}

test('a click whose control was still being found when the call timed out is never sent', async t => {
  const { manager } = stepFixture(t), finding = deferred(), found = deferred(); let clicks = 0;
  manager.find = async () => { finding.resolve(); await found.promise; return { ref: 1 }; };
  manager.target = async () => ({ click: async () => { clicks++; } });
  const rejected = assert.rejects(manager.run('chat', 'tab', { click: 'the Save button' }), /timed out during the click step/);
  await finding.promise; t.mock.timers.tick(100); await rejected;
  found.resolve(); await manager.serial.get('tab')?.catch(() => {});
  assert.equal(clicks, 0);
});

test('a step keeps one deadline from finding its control to its input, and a check seen late does not pass', async t => {
  const { manager } = stepFixture(t), timeouts = []; manager.actionTimeoutMs = 30000;
  manager.find = async () => { t.mock.timers.tick(1900); return { ref: 1 }; };
  manager.target = async () => ({ click: async ({ timeout }) => { timeouts.push(timeout); } });
  await manager.run('chat', 'tab', { click: 'the Save button' });
  assert.ok(timeouts[0] <= 100, `the click got ${timeouts[0]} ms after 1900 ms of finding`);
  manager.holds = async () => { t.mock.timers.tick(3000); return true; };
  const late = await manager.run('chat', 'tab', { check: 'Saved', timeout: 100 });
  assert.equal(late.check.pass, false); assert.equal(late.check.found, null);
});

test('files are not given to a file picker that opens after the call timed out', async t => {
  const { manager } = stepFixture(t), opening = deferred(), opened = deferred(); let given = 0;
  manager.uploads = async () => ({ paths: ['/tmp/a.txt'], cleanup: async () => {} });
  manager.target = async () => ({ evaluate: async () => false, click: async () => {} });
  manager.tabs.get('tab').page.waitForEvent = async () => { opening.resolve(); await opened.promise; return { setFiles: async () => { given++; } }; };
  const rejected = assert.rejects(manager.run('chat', 'tab', { kind: 'upload', selector: '#pick', files: ['/tmp/a.txt'] }), /timed out during the upload step/);
  await opening.promise; t.mock.timers.tick(100); await rejected;
  opened.resolve(); await manager.serial.get('tab')?.catch(() => {});
  assert.equal(given, 0);
});

test('a click whose control was found only after its step time is not sent, though the call has time left', async t => {
  const { manager } = stepFixture(t); let clicks = 0; manager.actionTimeoutMs = 30000;
  manager.find = async () => { t.mock.timers.tick(3000); return { ref: 1 }; };
  manager.target = async () => ({ click: async () => { clicks++; } });
  await assert.rejects(manager.run('chat', 'tab', { click: 'the Save button' }), /click: the step used its 2000 ms before this input was sent/);
  assert.equal(clicks, 0);
});

// A page whose main document says nothing, with one child frame.
function framedPage({ child, mainRead } = {}) {
  const main = { url: () => 'http://x/', childFrames: () => child ? [child] : [], isDetached: () => false,
    evaluate: async (fn, arg) => typeof arg === 'string' ? false : mainRead ? mainRead() : { title: 'Page', url: 'http://x/', text: '', elements: [], total: 0, doc: 'main' } };
  return { mainFrame: () => main, url: () => 'http://x/', title: async () => 'Page' };
}

test('a frame whose place could not be read is unknown, so text is not taken as gone', async () => {
  const { manager, tab } = fixture(); manager.actionTimeoutMs = 30000;
  tab.page = framedPage({ child: { url: () => 'http://y/', childFrames: () => [], isDetached: () => false, frameElement: async () => { throw new Error('Execution context was destroyed'); } } });
  const result = await manager.run('chat', 'tab', { check: 'Secret', expect: false, timeout: 200 });
  assert.equal(result.check.pass, false); assert.equal(result.check.found, null);
  assert.match(result.error, /could not be checked/);
});

test('a short check whose page cannot answer ends in its time with an unknown result', async () => {
  const { manager, tab } = fixture(); manager.actionTimeoutMs = 30000;
  tab.page = framedPage({ mainRead: () => new Promise(() => {}) });
  const result = await manager.run('chat', 'tab', { check: { target: 'Name', value: 'Ada' }, timeout: 100 });
  assert.equal(result.check.found, null); assert.match(result.text, /did not answer/);
});
