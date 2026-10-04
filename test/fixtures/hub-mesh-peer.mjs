import WebSocket from 'ws';
import { saveNetwork, loadNetwork, machineToken, revoke } from '@helm/protocol/network';
import { startRelay } from '@helm/relay';

let hub;
let target;
let base;
let bridgeId;

async function connectTarget() {
  target = new WebSocket(base.replace('http:', 'ws:') + '/ws?role=self&info=%7B%22version%22%3A%22mesh-test%22%7D', {
    headers: { authorization: `Bearer ${machineToken(loadNetwork())}` },
  });
  target.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.t !== 'rpc') return;
    process.send({ call: frame });
    if (frame.method === 'hang') return;
    const result = frame.method === 'session.list'
      ? { sessions: Array.from({ length: 120 }, (_, index) => ({ id: `done-${index}`, adopted: true, turns: 1 })) }
      : { method: frame.method, sub: frame.sub, params: frame.params };
    target.send(JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result }));
    if (frame.method === 'session.watch') {
      target.send(JSON.stringify({ t: 'event', kind: 'session.events', env: 'forged', payload: { id: frame.params.id } }));
    }
  });
  await new Promise((resolve, reject) => { target.once('message', resolve); target.once('error', reject); });
}

process.on('message', async message => {
  try {
    if (message.command === 'start') {
      saveNetwork(message.network);
      bridgeId = message.bridgeId;
      hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB, openLogin: false });
      base = `http://127.0.0.1:${hub.server.address().port}`;
      await connectTarget();
      hub.attachMesh({
        machines: () => new Map([['indirect', { id: 'indirect', info: {} }]]),
        watch() {},
        call() { throw new Error('must never forward a forwarded request'); },
      });
      process.send({ ready: base });
    } else if (message.command === 'dropBridge') hub.online.get(bridgeId)?.terminate();
    else if (message.command === 'dropTarget') target.terminate();
    else if (message.command === 'connectTarget') await connectTarget();
    else if (message.command === 'revoke') revoke(loadNetwork(), message.id);
    if (message.command !== 'start') process.send({ acknowledged: message.command });
  } catch (error) {
    process.send({ error: error.stack });
  }
});
