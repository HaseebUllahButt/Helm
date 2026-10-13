import { PeerHub } from '../../packages/connect/src/peer.js';
import { directPeer } from '../../packages/connect/src/direct-rpc.js';
import { cleanup } from 'node-datachannel';
let sender;
const receiver = new PeerHub((_id, payload) => void sender.receive(payload), async () => 'ok');
try {
  sender = directPeer({ signal: payload => void receiver.signal('malformed', payload, null, 'device'), onMessage() {} });
  await sender.ready;
  await sender.send(null);
  await new Promise(resolve => setTimeout(resolve, 50));
} finally { sender?.close(); receiver.stop(); cleanup(); }
