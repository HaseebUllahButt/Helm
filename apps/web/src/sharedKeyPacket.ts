// The browser uses the machine's code-transfer key. Its save packet uses
// the same encryption without Brotli, which browsers cannot all write.
const encode = (value: string) => new TextEncoder().encode(value);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function sharedKeyPacket(name: string, value: string, machineKey: string) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Open Helm at a secure address to save a key.');
  const algorithm = { name: 'X25519' };
  const target = await subtle.importKey('spki', bytes(machineKey), algorithm, false, []);
  const pair = await subtle.generateKey(algorithm, true, ['deriveBits']) as CryptoKeyPair;
  const shared = await subtle.deriveBits({ ...algorithm, public: target }, pair.privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encode('helm-code-transfer-v1') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const handoffId = `shared-key-save-${name}`;
  const packed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encode(`helm-code-v1:${handoffId}`) }, key, encode(JSON.stringify({ value }))));
  const epk = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  return { v: 1, alg: 'X25519-A256GCM', zip: 'none', handoffId, epk: b64(epk), salt: b64(salt), iv: b64(iv),
    tag: b64(packed.subarray(-16)), data: b64(packed.subarray(0, -16)) };
}
