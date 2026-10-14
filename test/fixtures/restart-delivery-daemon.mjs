// A real replaceable daemon process. The relay and proc host have separate
// lifetimes, just as they do when Helm's service is upgraded.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Sessions } from '../../packages/connect/src/sessions.js';
import { Daemon } from '../../packages/connect/src/agent.js';
import { InputDelivery } from '../../packages/connect/src/input-delivery.js';
import { requireNetwork, machineToken } from '@helm/protocol/network';
import { M, T } from '@helm/protocol';

class Runtime extends EventEmitter {
  async listLive() { return new Map(); }
  async read() { return { text: '' }; }
  watch() {}
}
const net = requireNetwork();
const sessions = new Sessions(new Runtime(), { nativeDiscovery: false, log: text => process.stderr.write(text + '\n') });
await sessions.adoptTerminals();
await sessions.resume();
const daemon = new Daemon({ port: net.port, advertiseLan: false });
daemon.sessions = sessions;
daemon.inputDelivery = new InputDelivery(sessions);
daemon.inputDelivery.resume();
daemon.describe = async () => ({ name: 'restart-test' });
let drop = false;
const ws = new WebSocket(`ws://127.0.0.1:${net.port}/helm/ws?role=self`, {
  headers: { authorization: `Bearer ${machineToken(net)}` },
});
ws.on('message', async raw => {
  const frame = JSON.parse(raw);
  if (frame.t === T.WELCOME) { process.send({ ready: true }); return; }
  if (frame.t !== T.RPC) return;
  try {
    const result = await daemon.dispatch(frame.method, frame.params, frame.sub);
    if (drop && frame.method === M.SESSION_DELIVER) {
      drop = false;
      process.send({ acceptedWithoutReply: true });
      return;
    }
    ws.send(JSON.stringify({ t: T.RPC_RESULT, id: frame.id, ok: true, result }));
  } catch (error) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: T.RPC_RESULT, id: frame.id, ok: false,
      error: { message: error.message, code: error.code } }));
  }
});
process.on('message', async command => {
  if (command === 'drop') { drop = true; process.send({ dropping: true }); }
  if (command === 'setup') {
    const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'test' });
    const helper = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'test' });
    sessions.get(helper.id).delegation = { parentId: parent.id, status: 'working' };
    sessions.rename(helper.id, 'Restart test helper');
    process.send({ helper: helper.id, parent: parent.id });
  }
});
process.on('SIGTERM', async () => {
  daemon.inputDelivery.stop();
  ws.terminate();
  await sessions.stop();
  process.exit(0);
});
