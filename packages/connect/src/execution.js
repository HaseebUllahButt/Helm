import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { HELM_DIR } from './paths.js';
import { startDurableWork, WORK_TIMEOUT_MS } from './work-command.js';
import { readExecution, writeExecution } from './execution-store.js';

const PAGE_BYTES = 64 * 1024;
const RETAIN_MS = 60 * 60_000;
const ID = /^[a-f0-9]{32}$/;
const MISSING = 'command not found; it may have expired. Do not automatically rerun it.';

function alive(pid, directory) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    // On Linux, a reused process id or a zombie is not our supervisor.
    if (process.platform === 'linux') {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      return cmd.includes(directory) && cmd.some(part => part.endsWith('/helm-work.js'));
    }
    return true;
  } catch (error) { return error.code === 'EPERM'; }
}

/** The detached supervisor owns each command and its saved output. */
export class ExecutionJobs {
  #closed = false;
  #waiters = new Set();
  constructor({ launch = startDurableWork, directory = join(HELM_DIR, 'execution-jobs'), retainMs = RETAIN_MS } = {}) {
    Object.assign(this, { launch, directory, retainMs });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.sweep = setInterval(() => this.#sweep(), Math.max(1, Math.min(retainMs, 60_000)));
    this.sweep.unref?.();
    this.#sweep();
  }

  #dir(id) { if (!ID.test(id ?? '')) throw new Error('invalid command id'); return join(this.directory, id); }
  #expire(dir, job) {
    if (job.finishedAt && Date.now() - job.finishedAt >= this.retainMs && !job.expired) {
      // Keep the identity, so an old id can never start the command again.
      job = { id: job.id, owner: job.owner, fingerprint: job.fingerprint, status: 'exited',
        finishedAt: job.finishedAt, expired: true };
      writeExecution(dir, job);
    }
    return job;
  }
  #sweep() {
    try {
      for (const id of readdirSync(this.directory)) {
        if (!ID.test(id)) continue;
        const dir = this.#dir(id);
        try { this.#expire(dir, readExecution(dir)); } catch { /* Leave an incomplete record in place. */ }
      }
    } catch { /* The next read or sweep can try again. */ }
  }
  #load(id, owner) {
    const dir = this.#dir(id);
    let job;
    try { job = readExecution(dir); } catch { throw new Error(MISSING); }
    if (job.owner !== owner) throw new Error(MISSING);
    job = this.#expire(dir, job);
    if (job.expired) throw new Error(MISSING);
    return job;
  }
  #status(id, job) {
    if (job.status === 'exited') return job;
    const dir = this.#dir(id);
    let pid;
    try { pid = Number(readFileSync(join(dir, 'supervisor.pid'), 'utf8')); } catch { /* Worker may still be starting. */ }
    if (pid && !alive(pid, dir)) {
      // Re-read after the process exits, in case it saved its result meanwhile.
      try { const latest = readExecution(dir); if (latest.status === 'exited') return latest; } catch {}
      return { ...job, status: 'exited', exitCode: 1, error: 'Command status is unknown. Do not rerun it.' };
    }
    if (!pid && Date.now() - job.createdAt > 10_000) {
      return { ...job, status: 'exited', exitCode: 1, error: 'Command status is unknown. Do not rerun it.' };
    }
    return job;
  }

  start(params, owner) {
    if (this.#closed) throw new Error('Helm is stopping; no command was started.');
    const { id, argv, heavy = false, timeout = WORK_TIMEOUT_MS, env = {} } = params;
    const dir = this.#dir(id), cwd = params.cwd ?? homedir();
    if (!Array.isArray(argv) || !argv.length || argv.length > 256 || argv.some(a => typeof a !== 'string' || a.includes('\0')) || !argv[0] || argv.join('').length > 64 * 1024) throw new Error('invalid command arguments');
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw new Error('command cwd must be an absolute path');
    if (typeof heavy !== 'boolean' || !Number.isInteger(timeout) || timeout < 1 || timeout > 24 * 60 * 60_000) throw new Error('invalid command timeout or heavy flag');
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.entries(env).length > 128 || Object.entries(env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')) || JSON.stringify(env).length > 64 * 1024) throw new Error('invalid command environment');
    const spec = { argv, cwd, heavy, timeout, env };
    const fingerprint = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = readExecution(dir); } catch { throw new Error('command record is incomplete; do not rerun it'); }
      if (existing.owner !== owner || existing.fingerprint !== fingerprint) throw new Error('command id already belongs to another request');
      if (existing.expired || (existing.finishedAt && Date.now() - existing.finishedAt >= this.retainMs)) throw new Error(MISSING);
      return { id, status: this.#status(id, existing).status };
    }
    const job = { id, owner, fingerprint, status: 'starting', createdAt: Date.now(), seq: 0, chunks: [], bytes: 0, exitCode: null };
    writeExecution(dir, job);
    const specFile = join(dir, 'spec.json');
    const failed = error => {
      try { rmSync(specFile, { force: true }); } catch {}
      try { writeExecution(dir, { ...job, status: 'exited', error: error.message, exitCode: 1, finishedAt: Date.now() }); } catch {}
    };
    try { writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600, flag: 'wx' }); }
    catch (error) { failed(error); throw error; }
    let child;
    try {
      child = this.launch(spec, { directory: dir });
      child.on('error', failed);
    } catch (error) { failed(error); }
    // The worker may already be running. A failed pid write must not remove
    // its command file or claim that it did not start; the worker writes it too.
    if (child?.pid) try { writeFileSync(join(dir, 'supervisor.pid'), String(child.pid), { mode: 0o600 }); } catch {}
    return { id, status: 'starting' };
  }

  async read({ id, since = 0, wait = 0 }, owner) {
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(wait) || wait < 0 || wait > 10_000) throw new Error('invalid command cursor or wait');
    let job = this.#status(id, this.#load(id, owner));
    if (wait && job.seq <= since && job.status !== 'exited' && !this.#closed) {
      await new Promise(resolve => {
        let watcher, timer;
        const done = () => { clearTimeout(timer); watcher?.close(); this.#waiters.delete(done); resolve(); };
        this.#waiters.add(done);
        try { watcher = watch(this.#dir(id), (_event, file) => { if (!file || String(file) === 'state.json') done(); }); }
        catch { /* The timeout still returns the current state. */ }
        timer = setTimeout(done, wait);
        try {
          const current = this.#status(id, this.#load(id, owner));
          if (current.seq > since || current.status === 'exited' || this.#closed) done();
        } catch { done(); }
      });
      job = this.#status(id, this.#load(id, owner));
    }
    const chunks = []; let bytes = 0;
    for (const chunk of job.chunks ?? []) {
      if (chunk.seq <= since) continue;
      if (bytes + chunk.bytes > PAGE_BYTES) break;
      bytes += chunk.bytes; chunks.push({ seq: chunk.seq, stream: chunk.stream, data: chunk.data });
    }
    const last = chunks.at(-1)?.seq ?? since;
    return { id, status: job.status, reason: job.reason, exitCode: job.exitCode, signal: job.signal, error: job.error,
      chunks, last, more: job.seq > last, truncated: since < (job.chunks?.[0]?.seq ?? 1) - 1 };
  }

  cancel({ id }, owner) {
    const job = this.#status(id, this.#load(id, owner));
    if (job.status !== 'exited') writeFileSync(join(this.#dir(id), 'cancel'), '', { mode: 0o600 });
    return { id, status: job.status };
  }

  async stop() {
    this.#closed = true;
    clearInterval(this.sweep);
    for (const done of [...this.#waiters]) done();
  }
}
