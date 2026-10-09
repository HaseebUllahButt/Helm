import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { T } from '@helm/protocol';
import { requireNetwork, hubCredential, allEndpoints } from '@helm/protocol/network';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { verifyHandoffSignature } from './code-transfer.js';
import { cleanCopyFolder, createCopyRequest } from './copy-transport.js';
import { directPeer } from './direct-rpc.js';
import { TunnelSender, TunnelReceiver } from './tunnel-flow.js';

const SERVER_FLAGS = /^-s[A-Za-z.]{0,126}$/;
const MACHINE_ID = /^[a-f0-9]{1,64}$/;
const KEY_B64 = /^[A-Za-z0-9_-]{40,512}$/;
const HELLO_MS = 2_000;
const HANDSHAKE_MS = 2_000;
const ICE_MS = 5_000;
const READY_MS = 10_000;
const CONNECT_BUDGET_MS = 20_000;
const MAX_ENDPOINT_ROUTES = 8;
const MAX_HUB_ROUTES = 16;

const USAGE = 'usage: helm copy-proxy --machine <id> --target-folder <path> [--direct|--relay] -- <rsync args>';

export function parseCopyProxyArgs(args) {
  const sep = args.indexOf('--');
  if (sep === -1) throw new Error(USAGE);
  const flags = args.slice(0, sep);
  const suffix = args.slice(sep + 1);
  let machine, targetFolder, mode = null;
  for (let i = 0; i < flags.length; i++) {
    const arg = flags[i];
    if (arg === '--direct' || arg === '--relay') {
      if (mode) throw new Error('--direct and --relay are mutually exclusive');
      mode = arg.slice(2);
      continue;
    }
    if (arg === '--machine' || arg === '--target-folder') {
      const value = flags[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--machine') {
        if (machine !== undefined) throw new Error('one --machine only');
        machine = value;
      } else {
        if (targetFolder !== undefined) throw new Error('one --target-folder only');
        targetFolder = value;
      }
      i += 1;
      continue;
    }
    throw new Error(`unknown flag ${arg}`);
  }
  if (!machine || !targetFolder) throw new Error(USAGE);
  if (!MACHINE_ID.test(machine)) throw new Error('--machine names a machine id');
  if (suffix.length !== 4 || suffix[1] !== 'rsync' || suffix[2] !== '--server' || !SERVER_FLAGS.test(suffix[3] ?? '')) {
    throw new Error('copy-proxy carries only an rsync server handshake');
  }
  return { machine, targetFolder, mode, hostname: suffix[0], serverArgs: ['--server', suffix[3]] };
}

function connectSocket(url, token, ms) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: ms,
    });
    let settled = false;
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      finish(new Error('the hub did not answer in time'));
    }, ms + 2_000);
    const onOpen = () => finish();
    const onError = (err) => finish(err);
    const onEarlyClose = () => finish(new Error('the hub socket closed before opening'));
    const onResponse = (_req, res) => {
      try { res.resume?.(); } catch {}
      try { ws.terminate(); } catch {}
      finish(Object.assign(new Error(`hub answered ${res.statusCode}`), { status: res.statusCode }));
    };
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onEarlyClose);
      ws.off('unexpected-response', onResponse);
      if (err) {
        ws.on('error', () => {});
        try { ws.terminate(); } catch {}
        reject(err);
      } else {
        resolve(ws);
      }
    }
    ws.on('open', onOpen);
    ws.once('error', onError);
    ws.once('close', onEarlyClose);
    ws.once('unexpected-response', onResponse);
  });
}

function socketTransport(ws) {
  const transport = {
    onFrame: null,
    onClose: null,
    send: (t, extra = {}) => ws.send(JSON.stringify({ t, ...extra })),
    close: () => { try { ws.close(); } catch {} },
  };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    transport.onFrame?.(msg);
  });
  ws.on('close', () => transport.onClose?.());
  ws.on('error', () => transport.onClose?.());
  return transport;
}

function runSession(transport, { request, cipher, sid, peer, input, output, stderr, readyMs, extra, onReady }) {
  return new Promise((resolve, reject) => {
    let ready = false;
    let finished = false;
    let sender = null;
    let receiver = null;
    let release = null;
    const readyTimer = setTimeout(() => fail(new Error('the target did not answer the copy in time')), readyMs);
    readyTimer.unref?.();

    function cleanup() {
      clearTimeout(readyTimer);
      try { sender?.stop(); } catch {}
      try { receiver?.stop(); } catch {}
      try { release?.(); } catch {}
      try { input.pause?.(); } catch {}
      input.removeListener?.('end', onInputEnd);
      input.removeListener?.('error', onStreamError);
      output.removeListener?.('error', onStreamError);
      try { transport.close(); } catch {}
    }
    function fail(err) {
      if (finished) return;
      finished = true;
      cleanup();
      const error = err instanceof Error ? err : new Error('copy failed');
      if (!('established' in error)) error.established = ready;
      reject(error);
    }
    function succeed(code) {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(code);
    }
    function sendPacket(packet) {
      try {
        Promise.resolve(transport.send(T.TUNNEL_DATA, { sid, data: cipher.seal(packet) }))
          .catch(() => fail(new Error('copy channel write failed')));
      } catch {
        fail(new Error('copy channel write failed'));
      }
    }
    function onInputEnd() {
      try {
        sender?.finish(() => sendPacket({ type: 'end' }));
      } catch {
        fail(new Error('copy input failed'));
      }
    }
    function onStreamError(err) {
      fail(err instanceof Error ? err : new Error('copy stream failed'));
    }

    transport.onFrame = (msg) => {
      if (finished || msg?.sid !== sid) return;
      if (!ready) {
        if (msg.t === T.TUNNEL_CLOSE) {
          const err = new Error(msg.reason ? `copy refused: ${msg.reason}` : 'the target refused the copy');
          if (msg.copyError === 'permanent') err.permanent = true;
          return fail(err);
        }
        if (msg.t !== T.TUNNEL_READY) return;
        if (msg.copy === undefined) {
          return fail(Object.assign(new Error(
            'the target answered without a signed copy proof - update the target and relay for signed copies, or use --ssh with an SSH server',
          ), { permanent: true }));
        }
        try {
          const proof = cipher.open(msg.copy);
          if (proof?.type !== 'ready' || proof.requestDigest !== request.requestDigest
              || !verifyHandoffSignature(peer.codeSignPubkey, proof.requestDigest, proof.signature)) {
            throw new Error('bad proof');
          }
        } catch {
          return fail(Object.assign(new Error(
            'the target did not prove it holds its signing key - refusing to send data',
          ), { permanent: true }));
        }
        ready = true;
        try { onReady?.(); } catch {}
        clearTimeout(readyTimer);
        release = beginTransferActivity();
        receiver = new TunnelReceiver(output, (bytes) => sendPacket({ type: 'ack', bytes }), fail);
        sender = new TunnelSender(input, (chunk) => sendPacket({ type: 'data', data: chunk.toString('base64') }), fail);
        input.on('end', onInputEnd);
        input.on('error', onStreamError);
        output.on('error', onStreamError);
        return;
      }
      if (msg.t === T.TUNNEL_CLOSE) {
        return fail(new Error(msg.reason ? `copy ended: ${msg.reason}` : 'copy channel closed'));
      }
      if (msg.t !== T.TUNNEL_DATA) return;
      let packet;
      try {
        packet = cipher.open(msg.data);
      } catch {
        return fail(new Error('copy packet failed authentication'));
      }
      if (packet.type === 'data') receiver?.write(packet.data);
      else if (packet.type === 'ack') sender?.ack(packet.bytes);
      else if (packet.type === 'stderr') {
        try { stderr.write(String(packet.data).slice(0, 4 * 1024)); } catch {}
      } else if (packet.type === 'exit') {
        let code;
        if (Number.isInteger(packet.code) && packet.code >= 0 && packet.code <= 255) {
          code = packet.code;
        } else if (typeof packet.signal === 'string' && /^SIG[A-Z0-9]+$/.test(packet.signal)) {
          code = 30;
        } else {
          return fail(new Error('the copy ended without a valid exit status'));
        }
        try { Promise.resolve(transport.send(T.TUNNEL_CLOSE, { sid, reason: 'closed' })).catch(() => {}); } catch {}
        succeed(code);
      } else {
        fail(new Error('unexpected copy packet'));
      }
    };
    transport.onClose = () => fail(new Error(ready
      ? 'copy transport closed mid-transfer'
      : 'the link closed before the target answered'));
    try {
      Promise.resolve(transport.send(T.TUNNEL_OPEN, { sid, env: peer.id, copy: request, ...extra }))
        .catch(() => fail(new Error('copy channel write failed')));
    } catch (err) {
      fail(err);
    }
  });
}

export async function copyProxy(args, deps = {}) {
  const stderr = deps.stderr ?? process.stderr;
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const say = (line) => { try { stderr.write(`${line}\n`); } catch {} };

  let parsed, net, peer;
  try {
    parsed = parseCopyProxyArgs(args);
    net = deps.network ? (typeof deps.network === 'function' ? deps.network() : deps.network) : requireNetwork();
    if (!net) throw new Error('this machine is not in a network yet - run `helm up`');
    peer = net.machines?.[parsed.machine];
    if (!peer || peer.id === net.self || net.revoked?.[peer.id]) {
      throw new Error(`no current machine ${parsed.machine} - see helm machines`);
    }
    if (parsed.hostname !== peer.id && parsed.hostname !== peer.name) {
      throw new Error('the rsync remote does not match --machine');
    }
    cleanCopyFolder(parsed.targetFolder);
    if (!KEY_B64.test(peer.codePubkey ?? '') || !KEY_B64.test(peer.codeSignPubkey ?? '')) {
      throw new Error(`${peer.name || peer.id} runs an older helm without signed copy support - update it, or copy with --ssh`);
    }
  } catch (err) {
    say(`helm copy-proxy: permanent: ${err.message}`);
    try { input.pause?.(); } catch {}
    return 1;
  }

  const openSocket = deps.socket ?? connectSocket;
  const credential = deps.credential ?? ((n, base, opts) => hubCredential(n, base, opts));
  const peerFactory = deps.peer ?? directPeer;
  const readyMs = deps.readyTimeout ?? READY_MS;
  const iceMs = deps.iceTimeout ?? ICE_MS;
  const budgetMs = deps.connectBudget ?? CONNECT_BUDGET_MS;
  const started = Date.now();
  const remaining = () => budgetMs - (Date.now() - started);
  const bounded = (ms) => Math.max(1, Math.min(ms, remaining()));
  const newSid = () => `c${randomBytes(8).toString('hex')}`;
  const freshRequest = () => {
    try {
      return createCopyRequest(net, peer, parsed.targetFolder, parsed.serverArgs);
    } catch (err) {
      err.permanent = true;
      throw err;
    }
  };
  let iceTried = false;

  async function openWs(base) {
    const connect = async (path) => {
      const token = await credential(net, base, { timeout: bounded(HELLO_MS) });
      return await openSocket(`${base.replace(/\/+$/, '')}${path}?role=client`, token, bounded(HANDSHAKE_MS));
    };
    try {
      return await connect('/helm/ws');
    } catch (err) {
      if (err?.status === 404 || err?.status === 405) return await connect('/ws');
      throw err;
    }
  }

  async function overWebRtc(ws) {
    const { request, cipher } = freshRequest();
    const transport = { onFrame: null, onClose: null, send: null, close: null };
    const pc = peerFactory({
      signal: (payload) => {
        try { ws.send(JSON.stringify({ t: T.SIGNAL, env: peer.id, payload })); } catch {}
      },
      connectTimeout: bounded(iceMs),
      onMessage: (msg) => transport.onFrame?.(msg),
      onClose: () => transport.onClose?.(),
    });
    transport.send = (t, extra = {}) => pc.send({ t, ...extra });
    transport.close = () => { try { pc.close(); } catch {} };
    const onSignal = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg?.t === T.SIGNAL && msg.env === peer.id) pc.receive(msg.payload);
    };
    ws.on('message', onSignal);
    let wsDead;
    const wsGone = new Promise((_, reject) => {
      wsDead = () => reject(Object.assign(new Error('the signalling hub disconnected'), { established: false }));
      ws.once('close', wsDead);
      ws.once('error', wsDead);
    });
    const unwatch = () => {
      ws.removeListener('close', wsDead);
      ws.removeListener('error', wsDead);
    };
    try {
      await Promise.race([pc.ready, wsGone]);
    } catch (err) {
      unwatch();
      ws.removeListener('message', onSignal);
      transport.close();
      throw Object.assign(err instanceof Error ? err : new Error('direct connection failed'), { established: false });
    }
    unwatch();
    try {
      return await runSession(transport, {
        request, cipher, sid: newSid(), peer, input, output, stderr,
        readyMs: bounded(readyMs),
        onReady: () => { clearBudget(); say(`Direct WebRTC: ${peer.name ?? peer.id}`); },
      });
    } finally {
      ws.removeListener('message', onSignal);
    }
  }

  async function runRoute(route) {
    if (route.kind === 'peer') {
      const ws = await openWs(route.endpoint);
      try {
        const { request, cipher } = freshRequest();
        return await runSession(socketTransport(ws), {
          request, cipher, sid: newSid(), peer, input, output, stderr,
          readyMs: bounded(readyMs),
          extra: { targetOnly: true },
          onReady: () => { clearBudget(); say(`Direct device connection: ${route.endpoint}`); },
        });
      } finally {
        try { ws.close(); } catch {}
      }
    }
    // --direct permits a single bounded ICE attempt; after it has run there
    // is nothing a signalling hub can still legitimately carry for us.
    if (parsed.mode === 'direct' && iceTried) {
      throw new Error('a direct connection through this hub is unavailable');
    }
    const ws = await openWs(route.hub);
    try {
      if (parsed.mode !== 'relay' && !iceTried) {
        iceTried = true;
        try {
          return await overWebRtc(ws);
        } catch (err) {
          if (err.established || err.permanent || parsed.mode === 'direct') throw err;
        }
      }
      const { request, cipher } = freshRequest();
      return await runSession(socketTransport(ws), {
        request, cipher, sid: newSid(), peer, input, output, stderr,
        readyMs: bounded(readyMs),
        onReady: () => {
          clearBudget();
          say(parsed.mode === 'relay'
            ? `Relay: ${route.hub}`
            : `Relay fallback: ${route.hub} (direct connection unavailable)`);
        },
      });
    } finally {
      try { ws.close(); } catch {}
    }
  }

  let budgetTimer;
  const clearBudget = () => clearTimeout(budgetTimer);
  try {
    const endpoints = (peer.endpoints ?? []).slice(0, MAX_ENDPOINT_ROUTES);
    const hubs = [...new Set([
      `http://127.0.0.1:${net.port ?? 8787}`,
      ...allEndpoints(net).sort((a, b) => Number(b.startsWith('https://')) - Number(a.startsWith('https://'))),
    ])].slice(0, MAX_HUB_ROUTES);
    const routes = [];
    if (parsed.mode !== 'relay') {
      for (const endpoint of endpoints) routes.push({ kind: 'peer', endpoint });
    }
    for (const hub of hubs) routes.push({ kind: 'signal', hub });

    let lastError = null;
    const budgetDead = new Promise((_, reject) => {
      budgetTimer = setTimeout(() => {
        reject(Object.assign(new Error('no route answered inside the connection budget'), { budget: true }));
      }, Math.max(1, budgetMs));
    });
    try {
      for (const route of routes) {
        if (remaining() <= 0) {
          lastError = lastError ?? new Error('no route answered inside the connection budget');
          break;
        }
        try {
          return await Promise.race([runRoute(route), budgetDead]);
        } catch (err) {
          lastError = err;
          if (err.established || err.permanent || err.budget) throw err;
        }
      }
      throw lastError ?? new Error('no route to the target');
    } finally {
      clearTimeout(budgetTimer);
    }
  } catch (err) {
    const message = parsed.mode === 'direct' && !err.established && !err.permanent
      ? `${err.message} (a direct connection to ${peer.name ?? peer.id} is unavailable and --relay/--ssh were not requested)`
      : err.message;
    say(err.permanent ? `helm copy-proxy: permanent: ${message}` : `helm copy-proxy: ${message}`);
    try { input.pause?.(); } catch {}
    return 12;
  }
}
