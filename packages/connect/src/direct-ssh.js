import { connect, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';

export function sshPeer(net, host) {
  const peers = Object.values(net.machines ?? {});
  const exact = peers.find(m => m.id === host || m.name === host);
  if (exact) return exact;
  // OpenSSH canonicalizes HostName before substituting %h in ProxyCommand.
  const folded = peers.filter(m => m.name?.toLowerCase() === host.toLowerCase());
  return folded.length === 1 ? folded[0] : undefined;
}

/** Only roster addresses; outer OpenSSH must already know this host's key. */
export function directSshAddresses(net, host) {
  const peer = sshPeer(net, host);
  if (!peer || peer.id === net.self || net.revoked?.[peer.id]) return [];
  return [...new Set((peer.endpoints ?? []).flatMap(endpoint => {
    try {
      const url = new URL(endpoint);
      const address = url.hostname.replace(/^\[|\]$/g, '');
      return ['http:', 'https:'].includes(url.protocol) && isIP(address) ? [address] : [];
    } catch { return []; }
  }))].slice(0, 4);
}

export async function hasPinnedSshHost(host, port) {
  const key = port === 22 ? host : `[${host}]:${port}`;
  return new Promise(resolve => execFile('ssh-keygen', ['-F', key, '-f', join(HELM_DIR, 'known_hosts')],
    { timeout: 2000 }, (err, out) => resolve(!err && !!out.trim())));
}

/** Probe without consuming SSH input; a black-holed port cannot hold up fallback. */
export function connectDirectSsh(host, port, timeout = 750) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const fail = err => { clearTimeout(timer); socket.destroy(); reject(err); };
    const ended = () => fail(new Error('direct SSH closed before its greeting'));
    const timer = setTimeout(() => fail(new Error('direct SSH timed out')), timeout);
    socket.once('error', fail);
    socket.once('data', first => {
      clearTimeout(timer);
      socket.off('error', fail);
      socket.off('end', ended);
      socket.pause();
      socket.unshift(first);
      resolve(socket);
    });
    socket.once('end', ended);
  });
}

export function bridgeDirectSsh(socket, input = process.stdin, output = process.stdout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = err => {
      if (settled) return;
      settled = true;
      input.unpipe(socket); socket.unpipe(output); input.pause();
      input.off('error', done); output.off('error', done);
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.on('error', done);
    socket.on('end', () => done());
    input.on('error', done); output.on('error', done);
    input.pipe(socket); socket.pipe(output, { end: false });
  });
}
