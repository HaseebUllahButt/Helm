import { networkInterfaces } from 'node:os';

/** Addresses another device on the same network could actually reach us at. */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Docker and friends advertise addresses nothing else can route to.
      if (/^(docker|br-|veth|virbr|tun|tap)/.test(name)) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}
