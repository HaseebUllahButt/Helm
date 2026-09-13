// Start one hub in its own process, so each gets its own HELM_DIR/HELM_DB.
import { startRelay } from '@helm/relay';
import { createNetwork, loadNetwork } from '@helm/protocol/network';

const port = Number(process.argv[2]);
const fresh = process.argv[3] === 'new';
if (fresh && !loadNetwork()) createNetwork({ name: process.env.NAME || 'machine', port });

const hub = await startRelay({
  port,
  dbFile: process.env.HELM_DB,
  passwordTtlMs: 5 * 60 * 1000,
});
console.log(JSON.stringify({ ready: true, port, password: hub.password }));
