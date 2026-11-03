import { sign, verify, createPublicKey } from 'node:crypto';
let proofSigner = () => { throw new Error('Load the local machine identity before signing.'); };
export const setProofSigner = (signer) => { proofSigner = signer; };

/** Sign separate kinds of network proof with this machine's private key. */
export function signNetworkProof(net, purpose, claims) {
  if (!net?.self || net.revoked?.[net.self] || !net.machines?.[net.self]) throw new Error('This machine is not a current network member.');
  const value = { ...claims, issuer: net.self };
  value.signature = sign(null, proofBody(net.id, purpose, value), proofSigner()).toString('base64url');
  return value;
}
export const proofBody = (network, purpose, value) => Buffer.from(JSON.stringify([
  'helm-proof-v3', network, purpose, Object.entries(value).filter(([key]) => key !== 'signature').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
]));
export function checkNetworkProof(net, purpose, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.issuer !== 'string'
      || typeof value.signature !== 'string' || net.revoked?.[value.issuer]) return false;
  const key = net.machines?.[value.issuer]?.codeSignPubkey;
  try { return !!key && verify(null, proofBody(net.id, purpose, value), createPublicKey({ key: Buffer.from(key, 'base64url'), type: 'spki', format: 'der' }), Buffer.from(value.signature, 'base64url')); }
  catch { return false; }
}
