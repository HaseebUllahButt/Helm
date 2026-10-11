import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { startWork, WORK_TIMEOUT_MS } from './work-command.js';

const OUTPUT_BYTES = 256 * 1024;
const PAGE_BYTES = 64 * 1024;
const RETAIN_MS = 10 * 60_000;
const MAX_JOBS = 64;

/** Commands use the existing authenticated machine RPC, without SSH or a login shell. */
export class ExecutionJobs {
  #jobs = new Map();
  #closed = false;
  constructor({ launch = startWork, retainMs = RETAIN_MS } = {}) { this.launch = launch; this.retainMs = retainMs; }

  #forget(id) { clearTimeout(this.#jobs.get(id)?.expiry); this.#jobs.delete(id); }
  #expire(job) {
    job.expiry = setTimeout(() => this.#forget(job.id), this.retainMs);
    job.expiry.unref?.();
  }

  start(params, owner) {
    if (this.#closed) throw new Error('Helm is stopping; no command was started.');
    const { id, argv, heavy = false, timeout = WORK_TIMEOUT_MS, env = {} } = params;
    const cwd = params.cwd ?? homedir();
    if (!/^[a-f0-9]{32}$/.test(id ?? '')) throw new Error('invalid command id');
    if (!Array.isArray(argv) || !argv.length || argv.length > 256 || argv.some(a => typeof a !== 'string' || a.includes('\0')) || !argv[0] || argv.join('').length > 64 * 1024) throw new Error('invalid command arguments');
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw new Error('command cwd must be an absolute path');
    if (typeof heavy !== 'boolean' || !Number.isInteger(timeout) || timeout < 1 || timeout > 24 * 60 * 60_000) throw new Error('invalid command timeout or heavy flag');
    if (!env || typeof env !== 'object' || Array.isArray(env) || Object.entries(env).length > 128 || Object.entries(env).some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')) || JSON.stringify(env).length > 64 * 1024) throw new Error('invalid command environment');
    const spec = { argv, cwd, heavy, timeout, env };
    const fingerprint = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    const existing = this.#jobs.get(id);
    if (existing) {
      if (existing.owner !== owner || existing.fingerprint !== fingerprint) throw new Error('command id already belongs to another request');
      return { id, status: existing.status };
    }
    for (const [key, job] of this.#jobs) if (job.finishedAt && Date.now() - job.finishedAt > this.retainMs) this.#forget(key);
    if (this.#jobs.size >= MAX_JOBS) {
      const oldest = [...this.#jobs.values()].find(job => job.finishedAt);
      if (!oldest) throw new Error('too many commands are already pending');
      this.#forget(oldest.id);
    }
    const job = { id, owner, fingerprint, status: heavy ? 'queued' : 'starting', seq: 0, chunks: [], bytes: 0, waiters: new Set(), exitCode: null };
    this.#jobs.set(id, job);
    const wake = () => { for (const waiter of job.waiters) waiter(); job.waiters.clear(); };
    try {
      const child = this.launch(spec); job.child = child;
      child.stdout.on('data', data => this.#append(job, 'stdout', data, wake));
      child.stderr.on('data', data => this.#append(job, 'stderr', data, wake));
      child.on('message', message => { Object.assign(job, { ...(message.status ? { status: message.status, reason: message.reason } : {}), ...(message.error ? { error: message.error } : {}), ...(message.signal ? { signal: message.signal } : {}) }); wake(); });
      child.on('error', error => { job.error = error.message; wake(); });
      job.done = new Promise(resolve => child.on('close', code => {
        job.status = 'exited'; job.exitCode = code ?? 1; job.finishedAt = Date.now(); this.#expire(job); wake(); resolve();
      }));
      // Remote commands are noninteractive. A shell can be explicitly passed
      // as argv for pipelines; no terminal or shell startup is implicit.
      child.stdin.end();
    } catch (error) { job.status = 'exited'; job.error = error.message; job.exitCode = 1; job.finishedAt = Date.now(); this.#expire(job); }
    return { id, status: job.status };
  }

  #append(job, stream, data, wake) {
    for (let offset = 0; offset < data.length; offset += 16 * 1024) {
      const chunk = data.subarray(offset, offset + 16 * 1024);
      job.chunks.push({ seq: ++job.seq, stream, data: chunk.toString('base64'), bytes: chunk.length });
      job.bytes += chunk.length;
      while (job.bytes > OUTPUT_BYTES) job.bytes -= job.chunks.shift().bytes;
    }
    wake();
  }

  #get(id, owner) {
    const job = this.#jobs.get(id);
    if (!job || job.owner !== owner) throw new Error('command not found; it may have expired or Helm restarted. Do not automatically rerun it.');
    return job;
  }

  async read({ id, since = 0, wait = 0 }, owner) {
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(wait) || wait < 0 || wait > 10_000) throw new Error('invalid command cursor or wait');
    const job = this.#get(id, owner);
    if (wait && job.seq <= since && job.status !== 'exited') await new Promise(resolve => {
      const done = () => { clearTimeout(timer); job.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, wait); job.waiters.add(done);
    });
    const chunks = []; let bytes = 0;
    for (const chunk of job.chunks) {
      if (chunk.seq <= since) continue;
      if (bytes + chunk.bytes > PAGE_BYTES) break;
      bytes += chunk.bytes; chunks.push({ seq: chunk.seq, stream: chunk.stream, data: chunk.data });
    }
    const last = chunks.at(-1)?.seq ?? since;
    return { id, status: job.status, reason: job.reason, exitCode: job.exitCode, signal: job.signal, error: job.error,
      chunks, last, more: job.seq > last, truncated: since < (job.chunks[0]?.seq ?? 1) - 1 };
  }

  cancel({ id }, owner) {
    const job = this.#get(id, owner);
    if (job.status !== 'exited' && job.child?.connected) job.child.send({ cancel: true });
    return { id, status: job.status };
  }

  async stop() {
    this.#closed = true;
    for (const job of this.#jobs.values()) this.cancel({ id: job.id }, job.owner);
    await Promise.all([...this.#jobs.values()].map(job => job.done));
    for (const id of this.#jobs.keys()) this.#forget(id);
  }
}
