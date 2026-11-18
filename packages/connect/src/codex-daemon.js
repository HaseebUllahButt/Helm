import { execFile } from 'node:child_process';
import { expand } from './paths.js';
import { ENGINES } from './engines.js';

/**
 * Codex's shared daemon runs its own copy of Codex, apart from the `codex`
 * the owner installs, and updates that copy by itself. When its updates
 * stop, every chat on it runs an old Codex without a word, and OpenAI can
 * refuse newer models from it (2026-11-18: a 0.165 daemon under a 0.170
 * CLI, "The 'gpt-6.2-sol' model is not supported"). Like T3 Code, which
 * runs the Codex the owner installed, Helm keeps the daemon on the
 * installed CLI's version: `update --from-cli` copies and pins that CLI,
 * then restarts the daemon. A restart ends what the daemon runs, so it
 * waits until no Codex chat, in Helm or a terminal, is busy.
 */
export const DAEMON_CHECK_MS = 60_000;

const parts = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))?.slice(1).map(Number) ?? null;

/** True only when both are versions and `a` is older than `b`. */
export function olderVersion(a, b) {
  const pa = parts(a), pb = parts(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
}

/** A running daemon on an older Codex than the CLI that asked. */
export const daemonBehind = (v) => v?.status === 'running' && olderVersion(v.appServerVersion, v.cliVersion);

function runCodex(cmd, args, env, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout, encoding: 'utf8', maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

/** The daemon's own report: the last line `codex app-server daemon version` prints. */
const lastJson = (out) => {
  const line = String(out ?? '').trim().split('\n').pop();
  try { return line ? JSON.parse(line) : null; } catch { return null; }
};

export class CodexDaemonSync {
  /** Codex home -> { at, behind }: when it was last read, and the report while it is behind. */
  #homes = new Map();
  #updating = new Set();

  constructor({ log = () => {}, run = runCodex, now = Date.now, everyMs = DAEMON_CHECK_MS } = {}) {
    Object.assign(this, { log, run, now, everyMs });
  }

  /** The background read of this account's daemon, for tests to wait on. */
  reading(profile) {
    return this.#homes.get(expand(profile.env?.CODEX_HOME || ENGINES.codex.defaultHome))?.reading ?? null;
  }

  /**
   * Read the account's daemon at most once a minute, in the background:
   * the caller's check of every chat must not wait for it. While the daemon
   * is behind, `busy()` is asked at every call, so the update comes at the
   * first moment nothing runs.
   */
  async sync(profile, busy) {
    const home = expand(profile.env?.CODEX_HOME || ENGINES.codex.defaultHome);
    if (this.#updating.has(home)) return null;
    const cmd = profile.cmd || 'codex';
    const env = profile.env || {};
    const state = this.#homes.get(home) ?? { at: -Infinity, behind: null, reading: null };
    this.#homes.set(home, state);
    if (!state.reading && this.now() - state.at >= this.everyMs) {
      state.at = this.now();
      state.reading = this.run(cmd, ['app-server', 'daemon', 'version'], env, 15_000).then((out) => {
        const report = lastJson(out);
        state.behind = daemonBehind(report) ? report : null;
      }).finally(() => { state.reading = null; });
    }
    if (!state.behind || busy()) return null;
    const { appServerVersion: from, cliVersion: to } = state.behind;
    this.#updating.add(home);
    try {
      this.log(`codex daemon: ${from} is older than the installed Codex ${to}; updating it while no chat is busy`);
      const done = lastJson(await this.run(cmd, ['app-server', 'daemon', 'update', '--from-cli', '--yes'], env, 120_000));
      this.log(done?.status === 'updated'
        ? `codex daemon: now runs ${done.runningVersion ?? to}`
        : `codex daemon: the update from ${from} to ${to} did not finish; trying again in a minute`);
      return done;
    } finally {
      // Read it again next time round, whatever happened.
      state.at = this.now();
      state.behind = null;
      this.#updating.delete(home);
    }
  }
}
