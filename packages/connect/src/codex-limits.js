import { spawn } from 'node:child_process';
import { LineBuffer } from './line-buffer.js';

/**
 * One `account/rateLimits/read` from a private Codex app-server, closed at
 * once. Only this read names the account's banked resets; the rolling
 * updates a chat receives never carry them. A private process, not a
 * chat's shared server: a read sent there would take the place of the
 * chat's own requests in a replayed recording, and an idle account has no
 * server at all. Null on any failure: the last reading stays.
 */
export function readCodexLimits(cmd, env = {}, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, ['app-server', '--stdio'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* closed */ }
      child.kill('SIGTERM');
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin.on('error', () => finish(null));
    const send = (m) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`); } catch { finish(null); } };
    const lines = new LineBuffer();
    child.stdout.on('data', (chunk) => {
      lines.write(chunk);
      let line;
      while ((line = lines.read()) !== null) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m?.id === 1) {
          if (m.error) return finish(null);
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: null });
        } else if (m?.id === 2) {
          return finish(m.result && typeof m.result === 'object' ? m.result : null);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'helm', title: 'Helm', version: '0.1.0' } } });
  });
}

/**
 * What Helm keeps of `rateLimitResetCredits`: how many are banked and, when
 * Codex sent the details, when each one ends (Unix seconds, soonest first).
 * Null when the summary is missing or malformed.
 */
export function resetCredits(summary) {
  const available = summary?.availableCount;
  if (!Number.isInteger(available) || available < 0) return null;
  if (!Array.isArray(summary.credits)) return { available };
  const endsAt = summary.credits
    .filter((c) => c?.status === 'available' && Number.isFinite(c.expiresAt) && c.expiresAt > 0)
    .map((c) => c.expiresAt).sort((a, b) => a - b);
  return { available, endsAt };
}
