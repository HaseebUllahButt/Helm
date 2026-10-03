import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { directSshAddresses, connectDirectSsh, bridgeDirectSsh } from '../packages/connect/src/direct-ssh.js';

test('direct SSH uses only live peer literal addresses from the roster', () => {
  const net = { self: 'a', machines: {
    a: { id: 'a', name: 'local', endpoints: ['http://127.0.0.1'] },
    b: { id: 'b', name: 'target', endpoints: ['http://192.168.1.3:8787', 'https://[fd00::2]', 'https://attacker.example', 'file:///tmp/a', 'http://192.168.1.3'] },
  }, revoked: {} };
  assert.deepEqual(directSshAddresses(net, 'target'), ['192.168.1.3', 'fd00::2']);
  assert.deepEqual(directSshAddresses(net, 'TARGET'), ['192.168.1.3', 'fd00::2']);
  assert.deepEqual(directSshAddresses(net, 'local'), []);
  assert.deepEqual(directSshAddresses(net, 'unknown'), []);
  net.revoked.b = 1;
  assert.deepEqual(directSshAddresses(net, 'target'), []);
});

test('direct SSH retains the greeting and pipes bytes with backpressure', async t => {
  const server = createServer(socket => {
    socket.write('SSH-2.0-test\r\n');
    socket.on('data', data => socket.end(data));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const socket = await connectDirectSsh('127.0.0.1', server.address().port);
  const input = new PassThrough(); const output = new PassThrough(); const received = [];
  output.on('data', c => received.push(c));
  input.write('payload');
  await bridgeDirectSsh(socket, input, output);
  assert.equal(Buffer.concat(received).toString(), 'SSH-2.0-test\r\npayload');
});

test('a listening port with no greeting times out for hub fallback', async t => {
  const sockets = new Set();
  const server = createServer(socket => sockets.add(socket));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  await assert.rejects(connectDirectSsh('127.0.0.1', server.address().port, 50), /timed out/);
});
