// Start one hub in its own process, so each gets its own CON_DIR/CON_DB.
import { startRelay } from '@con/relay';
import { createNetwork, loadNetwork } from '@con/protocol/network';

const port = Number(process.argv[2]);
const fresh = process.argv[3] === 'new';
if (fresh && !loadNetwork()) createNetwork({ name: process.env.NAME || 'machine', port });

const hub = await startRelay({
  port,
  dbFile: process.env.CON_DB,
  passwordTtlMs: 5 * 60 * 1000,
});
console.log(JSON.stringify({ ready: true, port, password: hub.password }));
