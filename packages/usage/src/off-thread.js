import { Worker } from 'node:worker_threads';

/**
 * Run one exported function of a module on a worker thread.
 *
 * `node:sqlite` is synchronous, and the agent stores it reads are not small:
 * Devin's is 1.5GB here, and reading its usage took 9s. On the daemon's
 * thread that was 9s with every chat, terminal and RPC on the machine frozen.
 * A worker costs ~30ms to start, which is nothing next to the reads that come
 * here. If a worker cannot be had at all, the call runs inline - slow beats
 * missing.
 *
 * Arguments and the result cross by structured clone, so both must be plain
 * data. The worker is unref'd: a daemon that is stopping does not wait on it.
 */
export function offThread(moduleUrl, name, args = []) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./off-thread-worker.js', import.meta.url), {
        workerData: { moduleUrl: String(moduleUrl), name, args },
      });
    } catch {
      import(String(moduleUrl)).then((m) => m[name](...args)).then(resolve, reject);
      return;
    }
    worker.unref();
    worker.once('message', (m) => (m.ok ? resolve(m.value) : reject(new Error(m.error))));
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code) reject(new Error(`worker exited with ${code}`)); });
  });
}
