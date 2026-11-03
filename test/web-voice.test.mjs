import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps/web/src/session/voice.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'cjs', target: 'node22' });

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function mount(transcribe = async () => 'words') {
  const pending = [];
  const recorders = [];
  const effects = [];
  const texts = [];
  const react = {
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useRef(value) { return { current: value }; },
    useCallback(fn) { return fn; },
    useEffect(fn) { effects.push(fn); },
  };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const navigator = { mediaDevices: { getUserMedia() { const item = deferred(); pending.push(item); return item.promise; } } };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require: name => name === 'react' ? react : { errorMessage: () => 'error' },
    window: { MediaRecorder: Recorder }, navigator, MediaRecorder: Recorder, Blob,
    setInterval: () => 1, clearInterval() {}, requestAnimationFrame() {},
  });
  const dictation = module.exports.useDictation({ transcribe, onText: text => texts.push(text) });
  const cleanup = effects.map(fn => fn());
  return { dictation, pending, recorders, texts, unmount() { cleanup.forEach(fn => fn?.()); } };
}

function stream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, getTracks: () => [track] };
}

test('a microphone request resolved after leaving stops its track', async () => {
  const view = mount();
  const started = view.dictation.start();
  assert.equal(view.pending.length, 1);
  view.unmount();
  const mic = stream();
  view.pending[0].resolve(mic);
  await started;
  assert.equal(mic.track.stopped, true);
  assert.equal(view.recorders.length, 0);
});

test('repeated start while permission is pending makes one microphone request', async () => {
  const view = mount();
  const first = view.dictation.start();
  const second = view.dictation.start();
  assert.equal(view.pending.length, 1);
  const mic = stream();
  view.pending[0].resolve(mic);
  await Promise.all([first, second]);
  assert.equal(view.recorders.length, 1);
  view.unmount();
  assert.equal(mic.track.stopped, true);
});

test('a recording does not add text after leaving', async () => {
  const reply = deferred();
  const view = mount(() => reply.promise);
  const started = view.dictation.start();
  const mic = stream();
  view.pending[0].resolve(mic);
  await started;
  const recorder = view.recorders[0];
  recorder.ondataavailable({ data: new Blob(['speech']) });
  recorder.stop();
  view.unmount();
  reply.resolve('old words');
  await reply.promise;
  await Promise.resolve();
  assert.deepEqual(view.texts, []);
});
