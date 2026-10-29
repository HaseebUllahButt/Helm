import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../apps/web/src/Terminal.tsx', import.meta.url), 'utf8');

function mountTerminal({ firstScreen } = {}) {
  const refs = [];
  const effects = [];
  const intervals = new Map();
  const calls = [];
  let nextInterval = 0;
  let sessionListener;
  const events = new Map();
  const documents = new Map();

  class FakeXterm {
    static instance;
    constructor(options) {
      this.options = options;
      FakeXterm.instance = this;
      this.cols = 80;
      this.rows = 24;
      this.buffer = { active: { type: 'normal', baseY: 0, cursorX: 0 } };
      this.writes = [];
      this.disposed = false;
    }
    registerLinkProvider(provider) { this.links = provider; }
    loadAddon() {}
    open() {}
    attachCustomWheelEventHandler() {}
    write(text) { this.writes.push(text); }
    reset() { this.writes.push('<reset>'); }
    onData(callback) { this.input = callback; return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    getSelection() { return ''; }
    dispose() { this.disposed = true; }
  }
  class FakeFitAddon { fit() {} }

  const react = {
    useRef(value) { const ref = { current: value }; refs.push(ref); return ref; },
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; },
    useEffect(effect) { effects.push(effect); },
  };
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  };
  const imported = {
    react,
    'react/jsx-runtime': jsxRuntime,
    '@xterm/xterm': { Terminal: FakeXterm },
    '@xterm/addon-fit': { FitAddon: FakeFitAddon },
    './terminalLinks': { localTerminalUrl: text => text.startsWith('http://localhost:') ? text : null, terminalLocalLinks: () => [{ text: 'localhost:5173', url: 'http://localhost:5173/', range: {} }] },
    './startingTerminals': { takeFirstScreen: () => firstScreen },
  };
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require: (name) => imported[name] ?? {},
    setInterval(callback, delay) {
      const id = ++nextInterval;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout: () => 1,
    clearTimeout() {},
    window: { addEventListener(k, fn) { events.set(k, fn); }, removeEventListener(k) { events.delete(k); } },
    document: { hidden: false, addEventListener(k, fn) { documents.set(k, fn); }, removeEventListener(k) { documents.delete(k); } },
    navigator: {},
  };

  const client = {
    rpc(env, method, params) {
      calls.push({ env, method, params });
      if (method === 'session.attach') return Promise.resolve({ text: '$ ', pty: true });
      return Promise.resolve({});
    },
    on(callback) { sessionListener = callback; return () => { sessionListener = undefined; }; },
    latency: () => 900,
    // The old implementation enabled periodic RTT probes only for terminal
    // predictive echo. It must not need that traffic anymore.
    watchLatency: () => () => {},
  };

  return transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic', target: 'node22' })
    .then(({ code }) => {
      vm.runInNewContext(code, context, { filename: 'Terminal.tsx' });
      const component = module.exports.Terminal;
      component({ client, env: 'machine-1', sessionId: 'session-1' });
      refs[0].current = {};
      const cleanup = effects[0]();
      return Promise.resolve().then(() => Promise.resolve()).then(() => ({
        xterm: FakeXterm.instance,
        calls,
        client,
        cleanup,
        wake() { documents.get('visibilitychange')?.(); },
        renew() { [...intervals.values()].find(i => i.delay === 25000).callback(); },
        emit(env, kind, payload) { sessionListener(env, kind, payload); },
        emitOutput(text) { sessionListener('machine-1', 'session.data', { id: 'session-1', text }); },
      }));
    });
}

test('a terminal opened from here draws the screen its start brought, without asking again', async () => {
  const firstScreen = { watcher: 'w-1', text: '$ ', position: 2, cols: 100, rows: 30, later: [{ text: 'hi', position: 4, reset: false }] };
  const { xterm, calls, cleanup } = await mountTerminal({ firstScreen });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(xterm.writes, ['<reset>', '$ ', 'hi']);
    assert.equal(calls.filter((call) => call.method === 'session.attach').length, 0);
    // It opened at a guess of the size; the real one follows.
    const resize = calls.find((call) => call.method === 'session.resize');
    assert.deepEqual({ ...resize?.params }, { id: 'session-1', cols: 80, rows: 24 });
  } finally {
    cleanup();
  }
  assert.equal(calls.find((call) => call.method === 'session.detach')?.params.watcher, 'w-1');
});

test('password-like PTY input is sent directly and never speculatively drawn', async () => {
  const { xterm, calls, emitOutput, cleanup } = await mountTerminal();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(xterm.writes.includes('$ '), 'the authoritative attach snapshot is displayed');

    // Establish the old predictive-echo precondition: the shell echoed a
    // command back after it was sent, then presented a password prompt.
    xterm.input('sudo -k\r');
    emitOutput('sudo -k\r\nPassword: ');
    const screenAfterPrompt = [...xterm.writes];

    for (const character of 's3cr3t-value') xterm.input(character);

    assert.deepEqual(xterm.writes, screenAfterPrompt, 'only PTY output may change terminal pixels');
    const sent = calls.filter((call) => call.method === 'session.input').map((call) => call.params.data);
    assert.deepEqual(sent, ['sudo -k\r', ...'s3cr3t-value']);
    assert.ok(calls.every((call) => call.env === 'machine-1'));
  } finally {
    cleanup();
  }
});


test('plain and OSC localhost links open the chat browser on its machine', async () => {
  const { xterm, calls, cleanup } = await mountTerminal();
  try {
    xterm.links.provideLinks(1, links => links[0].activate());
    xterm.options.linkHandler.activate({}, 'http://localhost:5173/path');
    await new Promise(resolve => setImmediate(resolve));
    const opens = calls.filter(call => call.method === 'browser.openApp');
    assert.equal(opens.length, 2);
    assert.ok(opens.every(call => call.env === 'machine-1' && call.params.id === 'session-1'));
    assert.equal(opens[0].params.url, 'http://localhost:5173/');
    assert.equal(opens[1].params.url, 'http://localhost:5173/path');
  } finally { cleanup(); }
});


test('a terminal catches up only when its own direct link lost events', async () => {
  const { calls, emit, cleanup } = await mountTerminal();
  try {
    const count = () => calls.filter(call => call.method === 'session.attach').length;
    const initial = count();
    emit('other', 'transport', { direct: false, gap: true });
    emit('machine-1', 'transport', { direct: true });
    assert.equal(count(), initial);
    emit('machine-1', 'transport', { direct: false, gap: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(count(), initial + 1);
  } finally { cleanup(); }
});


const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

for (const text of ['abc', '🙂é中']) {
  test(`a late terminal snapshot keeps only output after its position: ${text}`, async () => {
    const h = await mountTerminal();
    try {
      let release;
      h.client.rpc = (_env, method) => method === 'session.attach'
        ? new Promise(resolve => { release = resolve; }) : Promise.resolve({});
      h.emit('machine-1', 'transport', { gap: true });
      // This push partly overlaps the snapshot. Positions count UTF-16 units.
      h.emit('machine-1', 'session.data', { id: 'session-1', text: text + 'tail', position: 100 + text.length + 4 });
      release({ text: 'screen' + text, pty: true, position: 100 + text.length });
      await settle();
      const writes = h.xterm.writes;
      assert.deepEqual(writes.slice(writes.lastIndexOf('<reset>')), ['<reset>', 'screen' + text, 'tail']);
    } finally { h.cleanup(); }
  });
}

test('terminal reconnect reads cannot overlap or replace a newer screen', async () => {
  const h = await mountTerminal();
  try {
    const reads = [];
    h.client.rpc = (_env, method) => method === 'session.attach'
      ? new Promise(resolve => reads.push(resolve)) : Promise.resolve({});
    h.emit('machine-1', 'transport', { gap: true });
    h.emit('machine-1', 'connection', { online: true });
    assert.equal(reads.length, 1);
    reads[0]({ text: 'old', pty: true, position: 3 });
    await settle();
    assert.equal(reads.length, 2);
    reads[1]({ text: 'new', pty: true, position: 6 });
    await settle();
    assert.equal(h.xterm.writes.at(-1), 'new');
  } finally { h.cleanup(); }
});

test('showing a terminal reads the missing screen rather than only renewing it', async () => {
  const h = await mountTerminal();
  try {
    h.client.rpc = (_env, method, params) => {
      h.calls.push({ method, params });
      return Promise.resolve({ text: params.renew ? null : 'missed output', pty: true, position: 100 });
    };
    h.wake(); await settle();
    assert.equal(h.calls.at(-1).params.renew, false);
    assert.equal(h.xterm.writes.at(-1), 'missed output');
  } finally { h.cleanup(); }
});

test('an older host snapshot is reread after racing output without appending duplicate bytes', async () => {
  const h = await mountTerminal();
  try {
    let release, reads = 0;
    h.client.rpc = (_env, method) => {
      if (method !== 'session.attach') return Promise.resolve({});
      if (++reads === 1) return new Promise(resolve => { release = resolve; });
      return Promise.resolve({ text: '$ newer', pty: true });
    };
    h.emit('machine-1', 'transport', { gap: true });
    h.emitOutput('newer');
    release({ text: '$ new', pty: true });
    await settle();
    assert.equal(reads, 2);
    assert.deepEqual(h.xterm.writes.slice(-2), ['<reset>', '$ newer']);
  } finally { h.cleanup(); }
});


test('a first screen skips early output already included in its snapshot', async () => {
  const h = await mountTerminal({ firstScreen: { watcher: 'first', text: '$ 🙂é中', position: 6, cols: 80, rows: 24,
    later: [{ text: '🙂é中', position: 6 }, { text: '!', position: 7 }] } });
  try { assert.deepEqual(h.xterm.writes, ['<reset>', '$ 🙂é中', '!']); }
  finally { h.cleanup(); }
});
