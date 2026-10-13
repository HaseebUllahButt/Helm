// One machine in its own process: a real hub, and a daemon attached to it
// as itself that answers requests over the hub and over direct channels with
// the same checks the real daemon uses (peer.js directCaller). `old` plays a
// machine on the previous Helm: it does not offer direct channels.
import { saveNetwork, loadNetwork, revoke } from '@helm/protocol/network';
import { startRelay } from '@helm/relay';
import { T } from '@helm/protocol';
import { Link } from '../../packages/connect/src/agent.js';
import { PeerHub, directCaller } from '../../packages/connect/src/peer.js';

let hub;
let link;
let old = false;

async function dispatch(method, params, caller, via) {
  process.send({ call: { method, params, caller, via } });
  if (method === 'ping') return { t: Date.now() };
  // Stands for work that takes a while: it is still running when the
  // channel under it goes away.
  if (params?.hang && via === 'direct') return new Promise(() => {});
  return { method, caller, via };
}

const peers = new PeerHub(
  (peer, payload, source) => (source ?? link).send(T.SIGNAL, { peer, payload }),
  (method, params, caller) => dispatch(method, params, caller, 'direct'),
  {
    authorize: (device, frame) => directCaller(loadNetwork(), device, frame.sub),
    events: (device) => !Object.hasOwn(loadNetwork().machines ?? {}, device),
  },
);

const daemon = {
  get net() { return loadNetwork(); },
  port: 0,
  name: 'far',
  describe: async () => ({ version: 'direct-test', ...(old ? {} : { directRpc: 1 }) }),
  onLinkUp() {},
  linkDown() {},
  async onFrame(source, frame) {
    if (frame.t === T.PONG) return source.onPong();
    if (frame.t === T.PING) return source.send(T.PONG);
    if (frame.t === T.SIGNAL) {
      // An older machine has no direct answer for other machines at all.
      if (!old) await peers.signal(frame.peer, frame.payload, source, frame.device).catch(() => {});
      return;
    }
    if (frame.t !== T.RPC) return;
    try {
      const result = await dispatch(frame.method, frame.params ?? {}, frame.sub, 'hub');
      source.send(T.RPC_RESULT, { id: frame.id, ok: true, result });
    } catch (error) {
      source.send(T.RPC_RESULT, { id: frame.id, ok: false, error: { code: error.code ?? 'error', message: error.message } });
    }
  },
};

process.on('message', async (message) => {
  try {
    if (message.command === 'start') {
      saveNetwork(message.network);
      old = !!message.old;
      hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB, openLogin: false });
      daemon.port = hub.server.address().port;
      link = new Link(daemon, `http://127.0.0.1:${daemon.port}`).start();
      const deadline = Date.now() + 8000;
      while (!hub.online.has(message.network.self) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      process.send({ ready: `http://127.0.0.1:${daemon.port}` });
      return;
    }
    if (message.command === 'dropChannels') peers.stop();
    else if (message.command === 'revoke') revoke(loadNetwork(), message.id);
    else if (message.command === 'dropRevoked') peers.dropRevoked(loadNetwork().revoked);
    process.send({ acknowledged: message.command, peers: peers.count });
  } catch (error) {
    process.send({ error: error.stack });
  }
});
