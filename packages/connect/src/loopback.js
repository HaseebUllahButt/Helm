import { connect } from 'node:net';

/** Dial both loopback families, without relying on the machine's DNS order. */
export function connectLoopback(port) {
  const socket = connect({
    host: 'localhost', port, autoSelectFamily: true,
    lookup: (_host, _options, done) => done(null, [
      { address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 },
    ]),
  });
  let connected = false;
  socket.once('connect', () => { connected = true; });
  socket.prependListener('error', (error) => {
    if (!connected) error.message = `Nothing answered at 127.0.0.1:${port} or [::1]:${port}. Start the app on port ${port}, then try again.`;
  });
  return socket;
}

/** Check before publishing; never leave a probe connected to the app. */
export async function checkSharePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('give the local port to share, e.g. 3000');
  await new Promise((resolve, reject) => {
    const socket = connectLoopback(port);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
}
