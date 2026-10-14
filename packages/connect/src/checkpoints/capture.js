import { Worker } from 'node:worker_threads';
import { rm } from 'node:fs/promises';

export const CAPTURE_TIMEOUT_MS = 15_000;

/** Only file data crosses the worker boundary; session state stays in the daemon. */
export function captureFilesAsync(cwd, destination, { blobDir, timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./capture-worker.js', import.meta.url), { workerData: { cwd, destination, blobDir } });
    let settled = false;
    const finish = (error, snapshot) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        // Timeout must release the caller even if the worker is in a slow
        // filesystem syscall. Late output cannot publish a file checkpoint.
        worker.unref();
        void worker.terminate().then(() => rm(destination, { recursive: true, force: true })).catch(() => {});
        reject(error);
      } else resolve(snapshot);
    };
    const timer = setTimeout(() => finish(new Error('File checkpoint capture timed out; conversation rewind remains available.')), timeoutMs);
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.snapshot));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`File checkpoint worker exited (${code}).`)); });
  });
}
