import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from './paths.js';
import { isInteractiveProc } from './engines.js';
import { processArgv, processCwd, processStart, parentOf } from './procinfo.js';

/** Claude opens its transcript only for each append. Its session registry,
 * unlike a cwd guess, identifies multiple conversations in the same folder.
 * Never trust a stale registry PID: verify executable, cwd and process birth.
 */
export function claudeLiveSessions(home) {
  const live = new Map();
  const root = join(expand(home), 'sessions');
  let files;
  try { files = readdirSync(root); } catch { return live; }
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const rec = JSON.parse(readFileSync(join(root, file), 'utf8'));
      if (!Number.isSafeInteger(rec.pid) || rec.pid <= 0 || file !== `${rec.pid}.json`
        || !rec.sessionId || !rec.cwd || rec.kind !== 'interactive') continue;
      const argv = processArgv(rec.pid);
      if (!argv || !isInteractiveProc('claude', argv) || processCwd(rec.pid) !== rec.cwd) continue;
      const start = processStart(rec.pid);
      // Old versions omitted procStart. They can be monitored, but never
      // terminated automatically based on a PID that may have been reused.
      if (rec.procStart != null && String(rec.procStart) !== start) continue;
      const owners = live.get(rec.sessionId) ?? [];
      owners.push({ pid: rec.pid, status: rec.status, procStart: rec.procStart == null ? null : start });
      live.set(rec.sessionId, owners);
    } catch { /* stale, partial, or another user's registry entry */ }
  }
  return live;
}

export function claudeLiveStatus(owners) {
  // 'waiting' is a permission or question on screen: that needs you.
  if (owners.some((x) => x.status === 'waiting')) return 'blocked';
  if (owners.some((x) => x.status === 'busy')) return 'working';
  if (owners.length && owners.every((x) => x.status === 'idle')) return 'idle';
  return null;
}

/** A launcher (npm's node shim, say) runs the real CLI as its child, so the
 * process holding the conversation is a descendant of the one Helm started.
 */
export function descendsFrom(pid, ancestor, depth = 6) {
  for (let at = pid; at > 1 && depth-- > 0;) {
    if (at === ancestor) return true;
    at = parentOf(at);
    if (!at) return false;
  }
  return false;
}
