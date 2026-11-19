import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ipv4Mask, ipv4Number, ipv4Text, validMac, wakeLinks, wakeState } from '@helm/protocol/wake-state';
import { loadNetwork } from '@helm/protocol/network';
import { ownNode } from './own-node.js';

const command = promisify(execFile);
const adapterName = name => /^[A-Za-z0-9_.:@-]{1,15}$/.test(name) && !name.startsWith('-');

export function wakeExecArgs(args) {
  if (args.length !== 2) throw new Error('Choose one machine to wake.');
  return [ownNode(), fileURLToPath(new URL('../bin/helm-wake-send.js', import.meta.url)), args[1]];
}

function adapterFiles(name) {
  const path = '/sys/class/net/' + name;
  return {
    physical: existsSync(path + '/device'),
    wireless: existsSync(path + '/wireless') || existsSync(path + '/phy80211'),
  };
}

const readText = path => {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
};
const adapterNames = () => {
  try { return readdirSync('/sys/class/net'); } catch { return []; }
};

/** The router's hardware address distinguishes local networks with the same private IP range. */
export function routerAddresses(routes, arp) {
  const neighbors = new Map();
  for (const line of arp.trim().split('\n').slice(1)) {
    const [ip, , flags, address, , name] = line.trim().split(/\s+/);
    const mac = address?.toLowerCase();
    if (isIPv4(ip) && (Number(flags) & 2) && validMac(mac)) neighbors.set(name + ':' + ip, mac);
  }
  const defaults = routes.trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
    .filter(([, to, via, flags]) => to === '00000000' && /^[0-9A-F]{8}$/i.test(via) && (Number(flags) & 3) === 3)
    .sort((a, b) => Number(a[6]) - Number(b[6]));
  const out = new Map();
  for (const [name, , via] of defaults) {
    const gateway = via.match(/../g).reverse().map(n => Number.parseInt(n, 16)).join('.');
    if (!out.has(name)) out.set(name, neighbors.get(name + ':' + gateway) ?? null);
  }
  return out;
}

export function localWakeAdapters({
  platform = process.platform, interfaces = networkInterfaces(), adapter = adapterFiles,
  routers = platform === 'linux' ? routerAddresses(readText('/proc/net/route'), readText('/proc/net/arp')) : new Map(),
} = {}) {
  if (platform !== 'linux') return [];
  return Object.entries(interfaces).flatMap(([name, addresses]) => {
    if (!adapterName(name)) return [];
    const { physical, wireless } = adapter(name);
    if (!physical) return [];
    return (addresses ?? []).flatMap(entry => {
      const { family, address, cidr, internal } = entry;
      const mac = entry.mac?.toLowerCase();
      if (family !== 'IPv4' || internal || !isIPv4(address) || !validMac(mac)) return [];
      const prefix = Number(cidr?.split('/')[1]);
      if (!Number.isInteger(prefix) || prefix < 1 || prefix > 30) return [];
      const network = (ipv4Number(address) & ipv4Mask(prefix)) >>> 0;
      return [{ name, address, broadcast: ipv4Text(network | ~ipv4Mask(prefix)),
        link: { network: ipv4Text(network), prefix, router: routers.get(name) ?? null, mac: wireless ? null : mac } }];
    });
  });
}

export function magicPacket(mac) {
  if (!validMac(mac)) throw new Error('The saved network card address is invalid.');
  const address = Buffer.from(mac.replaceAll(':', ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 255), ...Array(16).fill(address)]);
}

export function broadcastWake(mac, { address, broadcast }) {
  const packet = magicPacket(mac);
  const socket = createSocket('udp4');
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.once('error', finish);
    socket.bind(0, address, () => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, 9, broadcast, finish);
      } catch (error) { finish(error); }
    });
  });
}

/** Recheck the sender's current network before broadcasting, even with a saved match. */
export async function sendWake(target, {
  net = loadNetwork(), state = wakeState, adapters = localWakeAdapters, broadcast = broadcastWake,
} = {}) {
  if (typeof target !== 'string' || target === net?.self || !Object.hasOwn(net?.machines ?? {}, target) || net.revoked?.[target]) {
    throw new Error('Choose another machine in this Helm network.');
  }
  const local = adapters();
  const record = state.records(net)[target];
  const sends = new Map();
  for (const adapter of local) {
    for (const { mac } of wakeLinks(record, { links: [adapter.link] })) {
      sends.set(adapter.address + ':' + mac, () => broadcast(mac, adapter));
    }
  }
  if (!sends.size) throw new Error('This machine no longer shares a saved local network with the target.');
  const result = await Promise.allSettled([...sends.values()].map(send => send()));
  if (!result.some(send => send.status === 'fulfilled')) throw new Error('This machine could not send the wake signal.');
  return { sent: true };
}

export async function wakeChecks({
  platform = process.platform, interfaces = adapterNames(), adapter = adapterFiles, run = command,
} = {}) {
  if (platform !== 'linux') return [{ id: 'wake', state: 'info', message: 'Helm checks Wake-on-LAN settings on Linux.' }];
  const names = interfaces.filter(name => {
    if (!adapterName(name)) return false;
    const { physical, wireless } = adapter(name);
    return physical && !wireless;
  });
  if (!names.length) return [{ id: 'wake', state: 'info', message: 'Helm found no wired network card to check for Wake-on-LAN.' }];
  const checks = await Promise.all(names.map(async (name, index) => {
    const id = 'wake-' + (index + 1);
    try {
      const { stdout } = await run('ethtool', [name], { timeout: 3000, maxBuffer: 64 * 1024,
        env: { ...process.env, LC_ALL: 'C' } });
      const settings = /^\s*Wake-on:\s*(\w+)/m.exec(stdout)?.[1];
      const supported = /^\s*Supports Wake-on:\s*(\w+)/m.exec(stdout)?.[1];
      if (settings?.includes('g')) return { id, state: 'ok', message: 'Wake-on-LAN is on for ' + name + '.' };
      if (supported && !supported.includes('g')) {
        return { id, state: 'info', message: name + ' does not support wake signals.' };
      }
      if (settings) {
        const action = 'Run helm sudo -- ethtool -s ' + name + ' wol g. Enable Wake-on-LAN in the firmware if needed.';
        return { id, state: 'warning', message: 'Wake-on-LAN is off for ' + name + '.', action };
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { id, state: 'info', message: 'Install ethtool to check Wake-on-LAN on ' + name + '.' };
    }
    return { id, state: 'info', message: 'Helm could not read Wake-on-LAN settings for ' + name + '.',
      action: 'Run helm sudo -- ethtool ' + name + ' to check with admin rights.' };
  }));
  return checks;
}
