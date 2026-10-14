import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Preload before any Helm module, including dependencies with import-time paths.
const root = mkdtempSync(join(tmpdir(), 'helm-automation-tests-'));
for (const [key, name] of Object.entries({ HELM_DIR: 'helm', HELM_DB: 'db.sqlite', HELM_SSH_DIR: 'ssh', HELM_NATIVE_SOCKET: 'native.sock', HELM_TERMINALS_SOCKET: 'terminals.sock', HELM_PROCS_SOCKET: 'procs.sock' })) process.env[key] = join(root, name);
process.env.HELM_NO_SERVICE = '1';
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
