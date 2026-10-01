import { createHash } from 'node:crypto';

/** Codex holds account threads in one app-server; other drivers use session ids. */
export function codexProcId(cmd, env = {}) {
  return `codex-server-${createHash('sha256').update(`${cmd}|${env.CODEX_HOME ?? ''}`).digest('hex').slice(0, 20)}`;
}

export function hostedProcId(session, spec) {
  if (session.driver === 'codex') return spec ? codexProcId(spec.cmd, spec.env) : null;
  return session.id;
}
