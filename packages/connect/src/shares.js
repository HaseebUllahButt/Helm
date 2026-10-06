import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';
import { shareName, randomShareName, hashSharePassword, NAME_RULE } from '@helm/protocol/share';

/**
 * What this machine shares publicly: `~/.helm/shares.json`.
 *
 * Kept on the machine that serves it, not on a hub. The hub only ever asks;
 * the list here is also what decides which local ports a tunnel may reach
 * (see `#allowedTunnelPorts`), so a hub cannot open anything that was not
 * shared on purpose, here.
 */
const FILE = () => join(HELM_DIR, 'shares.json');

export function listShares() {
  try {
    const list = JSON.parse(readFileSync(FILE(), 'utf8'));
    return Array.isArray(list) ? list.filter((s) => shareName(s?.name) && Number.isInteger(s?.port)) : [];
  } catch { return []; }
}

function save(list) {
  const tmp = `${FILE()}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, FILE());
}

/** Add or replace a share. The password, if any, is only kept as a hash. */
export function addShare({ name, port, password } = {}) {
  const wanted = Number(port);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) throw new Error('give the local port to share, e.g. 3000');
  const picked = name == null || name === '' ? randomShareName() : shareName(name);
  if (!picked) throw new Error(`a link name is ${NAME_RULE}`);
  const share = {
    name: picked, port: wanted, createdAt: Date.now(),
    ...(password ? { lock: hashSharePassword(password) } : {}),
  };
  save([...listShares().filter((s) => s.name !== picked), share]);
  return share;
}

export function removeShare(name) {
  const list = listShares();
  const left = list.filter((s) => s.name !== String(name ?? '').toLowerCase());
  if (left.length === list.length) return false;
  save(left);
  return true;
}

/** What a client may see: never the hash itself. */
export const publicShare = ({ lock, ...s }) => ({ ...s, password: !!lock });
