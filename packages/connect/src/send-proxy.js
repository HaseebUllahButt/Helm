// Tiny rsync remote-shell shim. It has no Helm imports or network/key setup.
import { connect } from 'node:net';
const [socket, jobId, ...args] = process.argv.slice(2);
const client = connect(socket);
client.on('connect', () => {
  client.write(`${JSON.stringify({ jobId, args })}\n`);
  process.stdin.pipe(client); client.pipe(process.stdout);
});
client.on('error', e => { process.stderr.write(`send tunnel: ${e.message}\n`); process.exitCode = 12; });
client.on('end', () => process.stdin.destroy());
process.on('SIGTERM', () => { client.destroy(); process.exit(143); });
