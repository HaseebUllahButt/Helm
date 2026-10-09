import { spawn } from 'node:child_process';
import {
  createCipheriv, createDecipheriv, createHash, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';
import { resolve } from 'node:path';
import { T } from '@helm/protocol';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { codeKeyInfo, signHandoffDigest, verifyHandoffSignature } from './code-transfer.js';
import { TunnelSender, TunnelReceiver } from './tunnel-flow.js';

const MACHINE_ID = /^[a-f0-9]{1,64}$/;
const COPY_ID = /^[a-f0-9]{24}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const SERVER_FLAGS = /^-s[A-Za-z.]{0,126}$/;
const MAX_REQUEST = 8 * 1024;
const MAX_FOLDER = 1024;
const MAX_STREAMS = 8;
const MAX_STDERR = 4 * 1024;
const MAX_PACKET = 160 * 1024;
const MAX_PLAIN = 96 * 1024;
const KILL_GRACE_MS = 3000;
const CTRL = /[\u0000-\u001f\u007f]/;
const KEY_B64 = /^[A-Za-z0-9_-]{40,512}$/;

const refuse = (link, sid, reason, permanent = false) => {
  try {
    const sent = link.send(T.TUNNEL_CLOSE, {
      sid,
      reason: String(reason).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200),
      ...(permanent ? { copyError: 'permanent' } : {}),
    });
    sent?.catch?.(() => {});
  } catch {}
};

export function cleanCopyFolder(folder) {
  if (typeof folder !== 'string' || !folder.startsWith('/') || folder.length > MAX_FOLDER || CTRL.test(folder)) {
    throw new Error('a copy target must be an absolute folder, not a device or url');
  }
  const resolved = resolve(folder);
  if (resolved === '/') throw new Error('a copy target must be a folder, not the filesystem root');
  return resolved;
}

export function validateCopyServerArgs(args) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--server'
      || typeof args[1] !== 'string' || !SERVER_FLAGS.test(args[1])) {
    throw new Error('a copy only runs a receiving rsync (--server -s<flags>)');
  }
  return ['--server', args[1]];
}

export function copyRequestDigest(request) {
  return createHash('sha256').update(JSON.stringify({
    v: request.v,
    copyId: request.copyId,
    sourceMachineId: request.sourceMachineId,
    targetMachineId: request.targetMachineId,
    targetFolder: request.targetFolder,
    serverArgs: request.serverArgs,
    epk: request.epk,
    salt: request.salt,
  })).digest('hex');
}

export function createCopyCipher(privateKey, remotePubkey, salt, copyId, side) {
  if (side !== 'source' && side !== 'target') throw new Error(`unknown copy side ${side}`);
  if (!COPY_ID.test(copyId ?? '')) throw new Error('invalid copy id');
  if (!B64URL.test(salt ?? '')) throw new Error('invalid copy salt');
  const saltBytes = Buffer.from(salt, 'base64url');
  if (saltBytes.length !== 32) throw new Error('invalid copy salt');
  const remote = createPublicKey({ key: Buffer.from(String(remotePubkey ?? ''), 'base64url'), type: 'spki', format: 'der' });
  if (remote.asymmetricKeyType !== 'x25519') throw new Error('the copy peer key is not x25519');
  const shared = diffieHellman({ privateKey, publicKey: remote });
  const sendDirection = side === 'source' ? 'source-to-target' : 'target-to-source';
  const receiveDirection = side === 'source' ? 'target-to-source' : 'source-to-target';
  const sendKey = Buffer.from(hkdfSync('sha256', shared, saltBytes, `helm-copy-v1:${copyId}:${sendDirection}`, 32));
  const receiveKey = Buffer.from(hkdfSync('sha256', shared, saltBytes, `helm-copy-v1:${copyId}:${receiveDirection}`, 32));
  const sendAad = Buffer.from(`helm-copy-v1:${copyId}:${sendDirection}`);
  const receiveAad = Buffer.from(`helm-copy-v1:${copyId}:${receiveDirection}`);
  let sent = 0n;
  let received = 0n;
  const ivFor = (seq) => {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(seq, 4);
    return iv;
  };
  return {
    seal(packet) {
      const plain = Buffer.from(JSON.stringify(packet));
      if (plain.length > MAX_PLAIN) throw new Error('copy packet exceeds the size limit');
      const seq = sent;
      const aes = createCipheriv('aes-256-gcm', sendKey, ivFor(seq));
      aes.setAAD(sendAad);
      const body = Buffer.concat([aes.update(plain), aes.final()]);
      sent += 1n;
      const head = Buffer.alloc(8);
      head.writeBigUInt64BE(seq);
      return Buffer.concat([head, aes.getAuthTag(), body]).toString('base64');
    },
    open(encoded) {
      if (typeof encoded !== 'string' || encoded.length > MAX_PACKET
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new Error('invalid copy packet encoding');
      }
      const raw = Buffer.from(encoded, 'base64');
      if (raw.length < 8 + 16 + 1) throw new Error('truncated copy packet');
      const seq = raw.readBigUInt64BE(0);
      if (seq !== received) throw new Error('unexpected copy packet sequence');
      const aes = createDecipheriv('aes-256-gcm', receiveKey, ivFor(seq));
      aes.setAAD(receiveAad);
      aes.setAuthTag(raw.subarray(8, 24));
      const plain = Buffer.concat([aes.update(raw.subarray(24)), aes.final()]);
      if (plain.length > MAX_PLAIN) throw new Error('copy packet exceeds the size limit');
      const packet = JSON.parse(plain.toString('utf8'));
      if (typeof packet !== 'object' || packet === null || Array.isArray(packet)) {
        throw new Error('invalid copy packet');
      }
      received += 1n;
      return packet;
    },
  };
}

export function createCopyRequest(net, peer, targetFolder, serverArgs) {
  if (!net || !MACHINE_ID.test(net.self ?? '')) {
    throw new Error('this machine is not in a network yet - run `helm up`');
  }
  if (!peer || !MACHINE_ID.test(peer.id ?? '') || peer.id === net.self || net.revoked?.[peer.id]) {
    throw new Error('choose another current machine from `helm machines`');
  }
  if (!KEY_B64.test(peer.codePubkey ?? '') || !KEY_B64.test(peer.codeSignPubkey ?? '')) {
    throw new Error(`${peer.name || peer.id} runs an older helm without signed copy support - update it, or copy with --ssh`);
  }
  const folder = cleanCopyFolder(targetFolder);
  const args = validateCopyServerArgs(serverArgs);
  const copyId = randomBytes(12).toString('hex');
  const ephemeral = generateKeyPairSync('x25519');
  const request = {
    v: 1,
    copyId,
    sourceMachineId: net.self,
    targetMachineId: peer.id,
    targetFolder: folder,
    serverArgs: args,
    epk: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    salt: randomBytes(32).toString('base64url'),
  };
  request.requestDigest = copyRequestDigest(request);
  request.sourceSignature = signHandoffDigest(request.requestDigest);
  if (JSON.stringify(request).length > MAX_REQUEST) throw new Error('copy request is too large');
  const cipher = createCopyCipher(ephemeral.privateKey, peer.codePubkey, request.salt, copyId, 'source');
  return { request, cipher };
}

export class CopyReceiver {
  constructor({ network, spawnProcess = spawn, keyInfo = codeKeyInfo, signer = signHandoffDigest } = {}) {
    this.network = network;
    this.spawnProcess = spawnProcess;
    this.keyInfo = keyInfo;
    this.signer = signer;
    this.streams = new Map();
    this.closing = new Map();
  }

  handle(link, frame, caller) {
    if (frame?.t === T.TUNNEL_OPEN) {
      if (frame.copy === undefined) return false;
      this.#open(link, frame, caller);
      return true;
    }
    const stream = this.streams.get(`${link.id} ${frame?.sid}`);
    if (!stream) return false;
    if (frame.t === T.TUNNEL_DATA) {
      const net = this.#roster();
      if (!net || !net.machines[stream.source] || net.revoked?.[stream.source]
          || net.revoked?.[net.self] || !net.machines[net.self]) {
        this.#teardown(stream, 'the copy source is no longer a machine of this network', true, true);
        return true;
      }
      this.#data(stream, frame);
    } else if (frame.t === T.TUNNEL_CLOSE) {
      this.#teardown(stream, null, false);
    }
    return true;
  }

  dropLink(link) {
    for (const stream of [...this.streams.values()]) {
      if (stream.link === link) this.#teardown(stream, null, false);
    }
  }

  dropRevoked(revoked = {}) {
    const net = this.#roster();
    for (const stream of [...this.streams.values()]) {
      if (revoked[stream.source] || (net?.self && revoked[net.self])) {
        this.#teardown(stream, 'the copy source is no longer a machine of this network', true, true);
      }
    }
  }

  stop() {
    for (const stream of [...this.streams.values()]) this.#teardown(stream, null, false);
    return Promise.all([...this.closing.values()].map((c) => c.done));
  }

  #roster() {
    return typeof this.network === 'function' ? this.network() : this.network;
  }

  #open(link, frame, caller) {
    const fail = (reason, permanent = true) => refuse(link, frame.sid, reason, permanent);
    if (typeof frame.sid !== 'string' || !frame.sid || frame.sid.length > 64) return;
    const request = frame.copy;
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || JSON.stringify(request).length > MAX_REQUEST) return fail('invalid copy request');
    if (request.v !== 1) return fail('the other machine runs a different helm - update both and retry');
    if (!COPY_ID.test(request.copyId ?? '')) return fail('invalid copy request');
    const net = this.#roster();
    if (!net || !net.machines?.[net.self]) return fail('this machine is not in a network');
    if (typeof caller !== 'string' || caller !== request.sourceMachineId
        || !net.machines[caller] || net.revoked?.[caller] || caller === net.self) {
      return fail('a copy comes from another machine of this network only');
    }
    if (request.targetMachineId !== net.self || net.revoked?.[net.self]) {
      return fail('this machine is not the signed copy target');
    }
    if (!DIGEST.test(request.requestDigest ?? '') || copyRequestDigest(request) !== request.requestDigest) {
      return fail('copy request digest does not match its contents');
    }
    const source = net.machines[caller];
    if (!KEY_B64.test(source.codeSignPubkey ?? '')
        || !verifyHandoffSignature(source.codeSignPubkey, request.requestDigest, request.sourceSignature ?? '')) {
      return fail('invalid copy source signature');
    }
    let cipher;
    try {
      cleanCopyFolder(request.targetFolder);
      validateCopyServerArgs(request.serverArgs);
      cipher = createCopyCipher(this.keyInfo().privateKey, request.epk ?? '', request.salt ?? '', request.copyId, 'target');
    } catch (err) {
      return fail(`invalid copy request: ${err.message}`);
    }
    const key = `${link.id} ${frame.sid}`;
    if (this.streams.has(key) || this.closing.has(key)) return fail('a copy stream with this id is already active', false);
    if (this.streams.size + this.closing.size >= MAX_STREAMS) {
      return fail('too many copies in progress on this machine', false);
    }
    for (const stream of this.streams.values()) {
      if (stream.copyId === request.copyId) return fail('duplicate copy id', false);
    }
    let child;
    try {
      child = this.spawnProcess('rsync', request.serverArgs, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return fail(`could not start rsync on this machine: ${err.message}`);
    }
    const stream = {
      key,
      link,
      sid: frame.sid,
      copyId: request.copyId,
      source: caller,
      requestDigest: request.requestDigest,
      cipher,
      child,
      release: beginTransferActivity(),
      sender: null,
      receiver: null,
      ready: false,
      ended: false,
      exited: false,
      stderrSent: 0,
      onError: null,
      onSpawn: null,
      onClose: null,
    };
    stream.onError = (err) => {
      this.#teardown(stream, `rsync is not available on this machine (${err.code ?? err.message}); install rsync 3.2.3 or newer`, true, true);
    };
    stream.onSpawn = () => this.#ready(stream);
    stream.onClose = (code, signal) => this.#childClosed(stream, code, signal);
    this.streams.set(stream.key, stream);
    child.on('error', stream.onError);
    child.on('spawn', stream.onSpawn);
    child.on('close', stream.onClose);
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
  }

  #ready(stream) {
    if (!this.streams.has(stream.key)) return;
    stream.ready = true;
    try {
      const sent = stream.link.send(T.TUNNEL_READY, {
        sid: stream.sid,
        copy: stream.cipher.seal({
          type: 'ready',
          requestDigest: stream.requestDigest,
          signature: this.signer(stream.requestDigest),
        }),
      });
      sent?.catch?.(() => this.#teardown(stream, 'copy channel write failed'));
    } catch {
      this.#teardown(stream, 'copy channel write failed');
      return;
    }
    const fail = (err) => this.#teardown(stream, err?.message || 'copy stream failed');
    stream.receiver = new TunnelReceiver(
      stream.child.stdin,
      (bytes) => this.#send(stream, { type: 'ack', bytes }),
      fail,
    );
    stream.sender = new TunnelSender(
      stream.child.stdout,
      (chunk) => this.#send(stream, { type: 'data', data: chunk.toString('base64') }),
      fail,
    );
    stream.child.stderr.on('data', (chunk) => {
      if (stream.stderrSent >= MAX_STDERR) return;
      const text = String(chunk).slice(0, MAX_STDERR - stream.stderrSent);
      stream.stderrSent += text.length;
      this.#send(stream, { type: 'stderr', data: text });
    });
  }

  #send(stream, packet) {
    try {
      const sent = stream.link.send(T.TUNNEL_DATA, { sid: stream.sid, data: stream.cipher.seal(packet) });
      sent?.catch?.(() => this.#teardown(stream, 'copy channel write failed'));
    } catch {
      this.#teardown(stream, 'copy channel write failed');
    }
  }

  #data(stream, frame) {
    if (!stream.ready) return this.#teardown(stream, 'copy data arrived before the receiver was ready');
    let packet;
    try {
      packet = stream.cipher.open(frame.data);
    } catch {
      return this.#teardown(stream, 'copy packet failed authentication');
    }
    if (packet.type === 'data') {
      stream.receiver?.write(packet.data);
    } else if (packet.type === 'ack') {
      stream.sender?.ack(packet.bytes);
    } else if (packet.type === 'end') {
      if (stream.ended) return this.#teardown(stream, 'unexpected copy packet');
      stream.ended = true;
      try { stream.child.stdin.end(); } catch {}
    } else {
      this.#teardown(stream, 'unexpected copy packet');
    }
  }

  #childClosed(stream, code, signal) {
    if (!this.streams.has(stream.key) || stream.exited) return;
    stream.exited = true;
    const sendExit = () => {
      this.#send(stream, { type: 'exit', code: code ?? null, signal: signal ?? null });
      this.#teardown(stream, 'closed');
    };
    if (stream.ready && stream.sender && !stream.sender.stopped) stream.sender.finish(sendExit);
    else sendExit();
  }

  #teardown(stream, reason, notify = true, permanent = false) {
    if (!this.streams.delete(stream.key)) return;
    try { stream.sender?.stop(); } catch {}
    try { stream.receiver?.stop(); } catch {}
    const child = stream.child;
    if (stream.onError) child.removeListener('error', stream.onError);
    if (stream.onSpawn) child.removeListener('spawn', stream.onSpawn);
    if (stream.onClose) child.removeListener('close', stream.onClose);
    for (const std of [child.stdin, child.stdout, child.stderr]) {
      try { std?.destroy(); } catch {}
    }
    if (notify && reason) refuse(stream.link, stream.sid, reason, permanent);
    if (stream.exited || child.exitCode != null || child.signalCode != null) {
      try { stream.release?.(); } catch {}
      return;
    }
    const done = new Promise((resolve) => {
      const finish = () => {
        clearTimeout(killer);
        clearTimeout(hard);
        this.closing.delete(stream.key);
        try { stream.release?.(); } catch {}
        resolve();
      };
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS);
      const hard = setTimeout(finish, KILL_GRACE_MS + 2000);
      killer.unref?.();
      hard.unref?.();
      child.once('close', finish);
      try { child.kill('SIGTERM'); } catch {}
    });
    this.closing.set(stream.key, { done });
  }
}
