import { txn } from './idb';

export interface HubTrust {
  network: string;
  revoked?: string[];
  machines: Record<string, { key: string; endpoints: string[] }>;
}
const encode = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
type Keys = { pair: CryptoKeyPair; key: string };
const memory = new Map<string, Keys>();
let creating: Promise<Keys> | undefined;
async function keys(expected?: string): Promise<Keys> {
  const slot = expected ? `helm.proof-key:${expected}` : 'helm.proof-key';
  const saved = memory.get(slot) ?? await txn<Keys | undefined>('kv', 'readonly', s => s.get(slot)).catch(() => undefined);
  if (saved && (!expected || saved.key === expected)) { memory.set(slot, saved); return saved; }
  if (expected) throw Object.assign(new Error('Sign in again to restore this browser key.'), { code: 'unauthorized' });
  if (creating) return creating;
  creating = (async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const value = { pair, key: encode(await crypto.subtle.exportKey('spki', pair.publicKey)) };
    memory.set(slot, value); memory.set(`helm.proof-key:${value.key}`, value);
    await txn('kv', 'readwrite', s => s.put(value, `helm.proof-key:${value.key}`)).catch(() => {});
    await txn('kv', 'readwrite', s => s.put(value, slot)).catch(() => {});
    return value;
  })();
  try { return await creating; } finally { creating = undefined; }
}
export const browserProofKey = async () => (await keys()).key;

export class HubAuth {
  private claims: { net?: string; sub?: string; proofKey?: string };
  constructor(private token: string, public trust?: HubTrust, private anchor = typeof location === 'undefined' ? '' : location.origin) {
    try { this.claims = JSON.parse(new TextDecoder().decode(decode(token.split('.')[1]))); }
    catch { this.claims = {}; }
  }
  get needsPairing() { return !!this.claims.sub && !this.claims.proofKey; }
  acceptTrust(trust?: HubTrust) {
    if (!trust || trust.network !== this.claims.net || !trust.machines) return;
    const revoked = [...new Set([...(this.trust?.revoked ?? []), ...(trust.revoked ?? [])])];
    const machines = Object.fromEntries(Object.entries(trust.machines).filter(([id, m]) =>
      !revoked.includes(id) && typeof m?.key === 'string' && Array.isArray(m.endpoints)
      && (!this.trust?.machines[id] || this.trust.machines[id].key === m.key)));
    this.trust = { network: trust.network, revoked, machines };
  }
  allowed(base: string) {
    return base === this.anchor || !!this.trust && Object.entries(this.trust.machines).some(([id, m]) => !this.trust?.revoked?.includes(id) && m.endpoints.includes(base));
  }
  private local(base: string) {
    try { return base === this.anchor && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname); }
    catch { return false; }
  }
  private async identity(base: string, signal?: AbortSignal) {
    if (!this.allowed(base)) throw new Error('This address is no longer in the network. Open Helm on a current machine.');
    const nonce = encode(crypto.getRandomValues(new Uint8Array(24)));
    const res = await fetch(`${base}/api/hub/identity`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }),
      signal: signal ?? AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error('Update Helm on this machine before connecting.');
    const proof = await res.json();
    const member = this.trust?.machines[proof.issuer];
    const key = member?.key ?? (base === this.anchor ? proof.key : undefined);
    if (this.trust?.revoked?.includes(proof.issuer) || proof.network !== this.claims.net || proof.nonce !== nonce || typeof proof.challenge !== 'string'
        || !key || (base !== this.anchor && !member?.endpoints.includes(base))) throw new Error('This machine did not prove its identity.');
    const publicKey = await crypto.subtle.importKey('spki', decode(key), { name: 'Ed25519' }, false, ['verify']);
    const body = bytes(['helm-proof-v3', proof.network, 'hub-identity',
      Object.entries(proof).filter(([k]) => k !== 'signature').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
    if (!await crypto.subtle.verify('Ed25519', publicKey, decode(proof.signature), body)) throw new Error('This machine did not prove its identity.');
    return proof;
  }
  async headers(base: string, method: string, path: string, signal?: AbortSignal): Promise<Record<string, string>> {
    if (this.local(base)) return {};
    if (!this.claims.proofKey) throw new Error('Sign in again to protect this browser with a device key.');
    const proof = await this.identity(base, signal);
    const signing = await keys(this.claims.proofKey);
    const p = { aud: proof.issuer, sub: this.claims.sub, ch: proof.challenge, method: method.toUpperCase(), path: new URL(path, base).pathname, exp: Date.now() + 60_000 };
    const signature = encode(await crypto.subtle.sign('Ed25519', signing.pair.privateKey,
      bytes(['helm-device-request-v1', this.claims.net, p.aud, p.sub, p.ch, p.method, p.path, p.exp])));
    return { 'x-helm-proof': encode(bytes({ ...p, signature })) };
  }
  async protocols(base: string) {
    const proof = await this.headers(base, 'GET', '/ws');
    return ['helm', this.token, ...(proof['x-helm-proof'] ? [`helmproof.${proof['x-helm-proof']}`] : [])];
  }
  async offer(target: string, payload: { negotiation: string; sdp: string }) {
    if (!this.claims.proofKey) throw new Error('Sign in again to protect this direct connection.');
    const signing = await keys(this.claims.proofKey);
    const signature = encode(await crypto.subtle.sign('Ed25519', signing.pair.privateKey,
      bytes(['helm-device-offer-v1', this.claims.net, this.claims.sub, target, payload.negotiation, payload.sdp])));
    return { ...payload, credential: this.token, deviceProof: signature };
  }
}
