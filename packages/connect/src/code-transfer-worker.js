import { parentPort, workerData } from 'node:worker_threads';
import { createCodeSnapshot, sealCodeSnapshot } from './code-transfer.js';

// Only workspace files and plain transfer data enter this worker.
try {
  if (workerData.operation === 'capture') {
    const snapshot = createCodeSnapshot(...workerData.args);
    // Review and permission checks need paths and metadata, never file bytes.
    parentPort.postMessage({ value: {
      ...snapshot, files: snapshot.files.map(({ data, ...file }) => file),
    } });
    parentPort.once('message', message => {
      try {
        parentPort.postMessage({ value: sealCodeSnapshot(snapshot, ...message.args) });
      } catch (error) {
        parentPort.postMessage({ error: error.message });
      } finally {
        parentPort.close();
      }
    });
  } else {
    const operation = workerData.operation === 'snapshot' ? createCodeSnapshot
      : workerData.operation === 'seal' ? sealCodeSnapshot : null;
    if (!operation) throw new Error('Unknown code transfer operation.');
    parentPort.postMessage({ value: operation(...workerData.args) });
  }
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
