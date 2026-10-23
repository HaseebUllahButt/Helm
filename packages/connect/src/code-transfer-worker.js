import { parentPort, workerData } from 'node:worker_threads';
import { createCodeSnapshot, sealCodeSnapshot } from './code-transfer.js';

// Only workspace files and plain transfer data enter this worker.
try {
  const operation = workerData.operation === 'snapshot' ? createCodeSnapshot
    : workerData.operation === 'seal' ? sealCodeSnapshot : null;
  if (!operation) throw new Error('Unknown code transfer operation.');
  parentPort.postMessage({ value: operation(...workerData.args) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
