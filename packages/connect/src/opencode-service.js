import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './paths.js';
import { processArgv } from './procinfo.js';

let latest = new Map();
let pending;
let checkedAt = 0;

/** V2's service owns many chats; its cwd and pid cannot identify one of them. */
export function opencodeServiceActive(id) { return latest.has(id); }

export async function opencodeServiceSessions({ fresh = false } = {}) {
  if (!fresh && Date.now() - checkedAt < 1000) return latest;
  if (pending) return pending;
  pending = readActive().finally(() => { pending = null; checkedAt = Date.now(); });
  return pending;
}

async function readActive() {
  const active = new Map();
  try {
    const root = process.env.XDG_STATE_HOME || join(HOME, '.local', 'state');
    const service = JSON.parse(readFileSync(join(root, 'opencode', 'service.json'), 'utf8'));
    const url = new URL(service.url);
    // Never send the local service password to a remote address from a stale record.
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return latest = active;
    if (!Number.isSafeInteger(service.pid) || service.pid <= 0) return latest = active;
    const argv = processArgv(service.pid);
    if (!argv?.some((v) => /(?:^|\/)\.?opencode2(?:-helm-native)?$/.test(v)) || !argv.includes('serve')) return latest = active;
    active.running = true;
    const response = await fetch(new URL('/api/session/active', url), {
      headers: service.password ? { Authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}` } : {},
      signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    if (response.ok) {
      const body = await response.json();
      active.available = !!body?.data && typeof body.data === 'object' && !Array.isArray(body.data);
      for (const [id, value] of Object.entries(body?.data ?? {})) {
        if (id.startsWith('ses_') && value?.type === 'running') active.set(id, 'working');
      }
    }
  } catch { /* A stopped or older service still leaves saved history readable. */ }
  latest = active;
  return active;
}
