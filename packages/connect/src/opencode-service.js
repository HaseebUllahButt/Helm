import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './paths.js';
import { processArgv, processList, processCwd, processTty } from './procinfo.js';
import { isInteractiveProc } from './engines.js';

let latest = new Map();
let pending;
let checkedAt = 0;
let profile;

/** V2's service owns many chats; its cwd and pid cannot identify one of them. */
export function opencodeServiceActive(id) { return latest.get(id) === 'working'; }
export function opencodeServiceStatus(id) { return latest.get(id); }
export function opencodeServiceProfile() { return profile; }

// V2 is also distributed as `opencode` and as an npm `opencode2.exe` binary.
const serviceName = /(?:^|\/)\.?opencode(?:2)?(?:-helm-native|\.exe)?$/;

function openTabs(root, active) {
  try {
    const saved = JSON.parse(readFileSync(join(root, 'opencode/latest/tui/tabs.json'), 'utf8'));
    const folders = new Set();
    for (const { pid, argv } of processList()) {
      const normalized = argv.map((arg) => arg.replace(/\.exe$/, ''));
      if (!isInteractiveProc('opencode', normalized) && !isInteractiveProc('opencode2', normalized)) continue;
      if (processTty(pid)) folders.add(processCwd(pid));
    }
    // Tabs survive closing the CLI. Only a live terminal in that folder makes
    // them open now; a background service alone must not revive old tabs.
    const groups = [...folders].map((cwd) => saved.cwd?.[cwd]);
    if (folders.size) groups.push(saved.global);
    for (const group of groups) for (const tab of group?.tabs ?? []) {
      if (typeof tab.sessionID === 'string' && tab.sessionID.startsWith('ses_')) active.set(tab.sessionID, 'idle');
    }
  } catch { /* Older clients need not keep tab state. */ }
}

export async function opencodeServiceSessions({ fresh = false } = {}) {
  if (!fresh && Date.now() - checkedAt < 1000) return latest;
  if (pending) return pending;
  pending = readActive().finally(() => { pending = null; checkedAt = Date.now(); });
  return pending;
}

async function readActive() {
  const active = new Map();
  profile = null;
  try {
    const root = process.env.XDG_STATE_HOME || join(HOME, '.local', 'state');
    const service = JSON.parse(readFileSync(join(root, 'opencode', 'service.json'), 'utf8'));
    const url = new URL(service.url);
    // Never send the local service password to a remote address from a stale record.
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return latest = active;
    if (!Number.isSafeInteger(service.pid) || service.pid <= 0) return latest = active;
    const argv = processArgv(service.pid);
    if (!argv?.some((v) => serviceName.test(v)) || !argv.includes('serve')) return latest = active;
    const at = argv.findIndex((v) => serviceName.test(v));
    profile = { id: 'opencode2-service', label: 'OpenCode 2', engine: 'opencode2',
      cmd: argv[0], args: argv.slice(1, at + 1), env: {}, source: 'service' };
    active.running = true;
    openTabs(root, active);
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
