import { parentPort, workerData } from 'node:worker_threads';
import { captureFiles } from './files.js';

// No Sessions, EventLog, profiles, network, or provider imports in this worker.
// It reads workspace bytes and writes only into a private snapshot directory.
try {
  const snapshot = captureFiles(workerData.cwd, workerData.destination, { blobDir: workerData.blobDir });
  parentPort.postMessage({ snapshot: { root: snapshot.root, head: snapshot.head, files: snapshot.files.length } });
} catch (error) { parentPort.postMessage({ error: error.message }); }
