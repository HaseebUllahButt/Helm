import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../apps/web/src/Terminal.tsx', import.meta.url), 'utf8');

function mountTerminal() {
  const refs = [];
  const effects = [];
  const intervals = new Map();
  const calls = [];
  let nextInterval = 0;
  let sessionListener;

  class FakeXterm {
    static instance;
    constructor() {
      FakeXterm.instance = this;
      this.cols = 80;
      this.rows = 24;
      this.buffer = { active: { type: 'normal', baseY: 0, cursorX: 0 } };
      this.writes = [];
      this.disposed = false;
    }
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
    window: { addEventListener() {}, removeEventListener() {} },
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
        emitOutput(text) { sessionListener('machine-1', 'session.data', { id: 'session-1', text }); },
      }));
    });
}

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
