import { createPublicKey, sign, verify } from 'node:crypto';
import { codeSigningInfo } from './code-transfer.js';

// Bind the machine identity to the DTLS fingerprint in its offer. Older
// hubs forward opaque payloads but allow a daemon to choose the introduced
// machine id; that introduction alone is not proof of machine identity.
const PREFIX = 'helm-direct-offer-v1:';
const body = (net, source, target, payload) => Buffer.from(PREFIX + JSON.stringify([
  net.id, source, target, payload.negotiation, payload.sdp,
]));

export function signDirectOffer(net, target, payload) {
  if (!net?.self || !target) return payload;
  return { ...payload, machineAuth: {
    source: net.self, target,
    signature: sign(null, body(net, net.self, target, payload), codeSigningInfo().privateKey).toString('base64url'),
  } };
}

export function allowDirectSignal(net, device, payload, enabled = true) {
  if (!net || !device || net.revoked?.[device] || net.revoked?.[net.self]) return false;
  if (!Object.hasOwn(net.machines ?? {}, device)) return Object.hasOwn(net.devices ?? {}, device);
  if (!enabled) return false;
  if (payload?.type !== 'offer') return true;
  const auth = payload.machineAuth;
  const key = net.machines[device].codeSignPubkey;
  if (auth?.source !== device || auth.target !== net.self || typeof payload.sdp !== 'string'
      || typeof payload.negotiation !== 'string' || typeof key !== 'string'
      || typeof auth.signature !== 'string' || auth.signature.length > 128) return false;
  try {
    return verify(null, body(net, device, net.self, payload),
      createPublicKey({ key: Buffer.from(key, 'base64url'), type: 'spki', format: 'der' }),
      Buffer.from(auth.signature, 'base64url'));
  } catch { return false; }
}
