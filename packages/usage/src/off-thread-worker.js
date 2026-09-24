import { parentPort, workerData } from 'node:worker_threads';

const { moduleUrl, name, args } = workerData;
try {
  const mod = await import(moduleUrl);
  parentPort.postMessage({ ok: true, value: await mod[name](...args) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message || String(err) });
}
