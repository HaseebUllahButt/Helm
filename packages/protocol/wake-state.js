import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { HELM_DIR, checkNetworkProof, signNetworkProof } from './network.js';

const PURPOSE = 'machine-wake';
const MAX_LINKS = 32;
const idPattern = /^[0-9a-f]{1,64}$/;
const signaturePattern = /^[\w-]{86}$/;
export const WAKE_EXEC = '@helm/wake';

export const ipv4Number = ip => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
export const ipv4Text = n => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');
export const ipv4Mask = prefix => (0xffffffff << (32 - prefix)) >>> 0;
export const validMac = mac => typeof mac === 'string' && /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac)
  && mac !== '00:00:00:00:00:00' && (Number.parseInt(mac.slice(0, 2), 16) & 1) === 0;

function validLink(link) {
  if (!link || typeof link !== 'object' || Array.isArray(link)
      || Object.keys(link).sort().join() !== 'mac,network,prefix,router') return false;
  const { network, prefix, router, mac } = link;
  return typeof network === 'string' && isIPv4(network)
    && Number.isInteger(prefix) && prefix >= 1 && prefix <= 30
    && ((ipv4Number(network) & ipv4Mask(prefix)) >>> 0) === ipv4Number(network)
    && (router === null || validMac(router)) && (mac === null || validMac(mac));
}

function sameNetwork(a, b) {
  return a.router !== null && a.router === b.router && a.network === b.network && a.prefix === b.prefix;
}

export function wakeLinks(target, sender) {
  return (target?.receivers ?? []).filter(link => (sender?.links ?? []).some(other => sameNetwork(link, other)));
}

export function possibleWakers(records, target, first) {
  return Object.keys(records).filter(id => id !== target && wakeLinks(records[target], records[id]).length)
    .sort((a, b) => Number(b === first) - Number(a === first) || a.localeCompare(b));
}

function validRecord(net, record, now) {
  return record && typeof record === 'object' && Object.keys(record).sort().join() === 'at,issuer,links,receivers,signature'
    && typeof record.issuer === 'string' && idPattern.test(record.issuer)
    && Number.isSafeInteger(record.at) && record.at > 0 && record.at <= now + 86400_000
    && Array.isArray(record.links) && record.links.length <= MAX_LINKS && record.links.every(validLink)
    && Array.isArray(record.receivers) && record.receivers.length <= MAX_LINKS
    && record.receivers.every(link => validLink(link) && link.mac && link.router)
    && typeof record.signature === 'string' && signaturePattern.test(record.signature)
    && checkNetworkProof(net, PURPOSE, record);
}

/**
 * Wake details have their own signature and files. An older Helm can still
 * verify and share the regular machine record without knowing about wake.
 */
export class WakeState {
  constructor(directory = join(HELM_DIR, 'wake-machines')) {
    this.directory = directory;
  }

  #read(id) {
    try { return JSON.parse(readFileSync(join(this.directory, id + '.json'), 'utf8')); }
    catch { return null; }
  }

  #save(record) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, record.issuer + '.json');
    const temp = path + '.' + randomBytes(6).toString('hex');
    try {
      writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
  }

  records(net) {
    const out = {};
    const now = Date.now();
    for (const id of Object.keys(net?.machines ?? {})) {
      if (!idPattern.test(id) || net.revoked?.[id]) continue;
      const record = this.#read(id);
      if (record?.issuer === id && validRecord(net, record, now)) out[id] = record;
    }
    return out;
  }

  publish(net, links) {
    if (net.revoked?.[net.self] || !idPattern.test(net.self)) return null;
    const unique = [...new Map(links.filter(validLink).map(link => [JSON.stringify(link), link])).values()];
    const current = this.#read(net.self);
    const now = Date.now();
    const previous = validRecord(net, current, now) ? current : null;
    const order = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    const sorted = unique.sort(order).slice(0, MAX_LINKS);
    const learned = sorted.filter(link => link.mac && link.router);
    const remembered = (previous?.receivers ?? []).filter(link => !sorted.some(other => other.mac === link.mac
      && (other.router || other.network !== link.network || other.prefix !== link.prefix)));
    // A card can lose its IP address just before sleep. Keep its last known
    // network for receiving, but use only current links for sending.
    const receivers = [...learned, ...remembered].slice(0, MAX_LINKS).sort(order);
    if (previous && JSON.stringify([previous.links, previous.receivers]) === JSON.stringify([sorted, receivers])) return null;
    if (!previous && !sorted.length) return null;
    const record = signNetworkProof(net, PURPOSE, { at: Math.max(now, (previous?.at ?? 0) + 1), links: sorted, receivers });
    this.#save(record);
    return record;
  }

  merge(net, records) {
    if (!net || net.revoked?.[net.self] || !Array.isArray(records)) return false;
    let changed = false;
    const now = Date.now();
    // A roster holds up to 256 machines. Process at most one record per member.
    const seen = new Set();
    for (const record of records.slice(0, 256)) {
      const id = record?.issuer;
      if (typeof id !== 'string' || id === net.self || !Object.hasOwn(net.machines, id) || seen.has(id)) continue;
      if (!validRecord(net, record, now)) continue;
      seen.add(id);
      const previous = this.#read(id);
      if (validRecord(net, previous, now) && previous.at >= record.at) continue;
      this.#save(record);
      changed = true;
    }
    return changed;
  }
}

export const wakeState = new WakeState();

export function wakeHash(records) {
  return createHash('sha256').update(JSON.stringify(Object.keys(records).sort().map(id => records[id].signature)))
    .digest('base64url').slice(0, 16);
}
