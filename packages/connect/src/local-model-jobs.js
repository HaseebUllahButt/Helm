import { join } from 'node:path';
import { modelDir, modelName, readModelState, writeModelState } from './local-model-state.js';

export class LocalModelJobs {
  #file;
  #running = new Map();
  #jobs;
  #closed = false;
  #loadError = null;

  constructor({ dir = modelDir, host, log = () => {} }) {
    Object.assign(this, { host, log });
    this.#file = join(dir, 'jobs.json');
    try { this.#jobs = readModelState(this.#file, {}); }
    catch (error) {
      this.#jobs = {};
      this.#loadError = new Error(`Could not read the model requests in ${this.#file}.`, { cause: error });
      this.log(this.#loadError.message);
    }
  }

  begin() {
    for (const job of Object.values(this.#jobs)) {
      if (job.state === 'working') this.#run(job);
    }
  }

  close() { this.#closed = true; }

  async list() {
    const { models } = await this.host.list();
    const byName = new Map(models.map((row) => [row.model, row]));
    for (const job of Object.values(this.#jobs)) {
      if (job.state === 'working') {
        byName.set(job.model, { ...byName.get(job.model), model: job.model, state: job.action === 'serve' ? 'starting' : 'stopping' });
      }
    }
    return { models: [...byName.values()] };
  }

  #save(job) {
    // Keep failed and finished replies long enough for a caller to reconnect.
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const next = Object.fromEntries(Object.entries(this.#jobs).filter(([, j]) => j.state === 'working' || j.at > cutoff));
    next[job.id] = job;
    writeModelState(this.#file, next);
    this.#jobs = next;
  }

  submit({ id, action, model: value }) {
    if (this.#loadError) throw this.#loadError;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !['serve', 'stop'].includes(action)) {
      throw new Error('Send a model action with a valid request number.');
    }
    const model = modelName(value);
    const saved = this.#jobs[id];
    if (saved) {
      if (saved.action !== action || saved.model !== model) throw new Error('This request number belongs to another model action.');
      return saved;
    }
    const pending = Object.values(this.#jobs).filter((j) => j.model === model && j.state === 'working').at(-1);
    if (pending?.action === action) return pending;
    const job = { id, model, action, state: 'working', at: Date.now() };
    this.#save(job);
    this.#run(job);
    return job;
  }

  #run(job) {
    if (this.#closed || this.#running.has(job.id)) return;
    const work = Promise.resolve().then(() => this.host[job.action](job.model)).then(
      (result) => this.#finish(job, { state: 'done', result }),
      (error) => this.#finish(job, { state: 'failed', error: error.message }),
    ).catch((error) => this.log(error.message)).finally(() => this.#running.delete(job.id));
    this.#running.set(job.id, work);
  }

  #finish(job, result) {
    if (this.#closed) return;
    const done = { ...job, at: Date.now(), ...result };
    try { this.#save(done); }
    catch (error) {
      this.#jobs[job.id] = done;
      this.log(`Could not save the model request result. ${error.message}`);
    }
  }

  async read(id) {
    if (this.#loadError) throw this.#loadError;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Give a valid model request number.');
    const work = this.#running.get(id);
    if (work) {
      let timer;
      try { await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, 20_000); })]); }
      finally { clearTimeout(timer); }
    }
    return this.#jobs[id] ?? null;
  }
}
