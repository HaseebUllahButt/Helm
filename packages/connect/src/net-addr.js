import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';

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

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

/**
 * Is the address we advertise on the local network one we could answer on?
 *
 * A full-tunnel VPN says yes to both questions that matter separately. The
 * interface still holds 192.168.x.y, so con advertises it and a phone on the
 * same wifi sends packets there - but the machine's *route* for that subnet
 * points into the tunnel, so the replies leave through an exit node in
 * another country and never come back. The pairing fails, WebRTC falls back
 * to relaying through the hub, and the terminal goes from three milliseconds
 * to over a second with nothing anywhere saying why.
 *
 * That is not hypothetical: it is exactly what the owner's laptop was doing
 * on 2026-09-15, with a Tailscale exit node and `--exit-node-allow-lan-access`
 * off. `ip route get <our own LAN address's gateway>` came back
 * `dev tailscale0`, and a ping to the router got 100% loss.
 *
 * Best effort and Linux-shaped: anything unexpected answers `null`, which
 * means "no opinion", never "broken".
 */
export async function lanIsRoutable() {
  const lan = lanAddresses().find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  if (!lan) return null;
  // Something else in our own subnet: the .1 is nearly always the gateway,
  // and we only care which interface the kernel would send it out of.
  const probe = lan.address.replace(/\.\d+$/, '.1');
  const route = await run('ip', ['route', 'get', probe]);
  const dev = /\bdev\s+(\S+)/.exec(route)?.[1];
  if (!dev) return null;
  return { address: lan.address, via: dev, ok: dev === lan.name, expected: lan.name };
}
