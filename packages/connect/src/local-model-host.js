import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { forwardId, modelDir, modelName, readModelState, writeModelState } from './local-model-state.js';
import { ensureOllamaService, MODEL_WORK_MS, OLLAMA_CONTEXT, ollamaJson } from './ollama-service.js';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function runningModel(rows, name) {
  return rows?.find((row) => {
    try { return modelName(row.model ?? row.name) === name; }
    catch { return false; }
  });
}

function answer(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

export class LocalModelHost {
  #file;
  #state;
  #gateway = null;
  #work = Promise.resolve();
  #active = new Map();
  #closed = false;
  #loadError = null;

  constructor({ dir = modelDir, network, forwards, service = ensureOllamaService, fetcher = fetch, log = () => {} }) {
    Object.assign(this, { network, forwards, service, fetcher, log });
    this.#file = join(dir, 'host.json');
    try {
      this.#state = readModelState(this.#file, { models: [] });
      if (!Array.isArray(this.#state.models)) throw new Error('Bad model list.');
    } catch (error) {
      this.#state = { models: [] };
      this.#loadError = new Error(`Could not read the shared model settings in ${this.#file}.`, { cause: error });
      this.log(this.#loadError.message);
    }
  }

  #serial(fn) {
    const job = this.#work.then(fn);
    this.#work = job.catch(() => {});
    return job;
  }

  #save(state) {
    writeModelState(this.#file, state);
    this.#state = state;
  }

  #ollama(path, body, timeout) {
    return ollamaJson(this.#state.ollamaPort, path, body, { fetcher: this.fetcher, timeout });
  }

  begin() {
    return this.#serial(async () => {
      if (this.#state.models.some((m) => !m.stopping)) await this.#openGateway();
      if (!this.#state.models.length && this.#state.generation) await this.#retireGateway();
    });
  }

  async close() {
    this.#closed = true;
    const gateway = this.#gateway;
    this.#gateway = null;
    if (gateway) await close(gateway);
  }

  catalog() {
    return {
      gateway: this.#gateway ? { port: this.#state.port, generation: this.#state.generation } : null,
      models: this.#state.models.filter((m) => !m.stopping),
    };
  }

  async list() {
    if (this.#loadError) throw this.#loadError;
    const { models } = this.#state;
    if (!models.length) return { models: [] };
    const status = await this.#ollama('/api/ps').catch(() => null);
    return { models: models.map(({ model, stopping }) => {
      const loaded = runningModel(status?.models, model);
      return {
        model,
        state: stopping ? 'stopping' : !status || !this.#gateway ? 'unavailable' : loaded ? 'loaded' : 'ready',
        gpu: loaded ? loaded.size_vram ?? null : status ? 0 : null,
        memory: loaded
          ? Number.isFinite(loaded.size) && Number.isFinite(loaded.size_vram) ? Math.max(0, loaded.size - loaded.size_vram) : null
          : status ? 0 : null,
      };
    }) };
  }

  serve(value) {
    const model = modelName(value);
    return this.#serial(async () => {
      if (this.#loadError) throw this.#loadError;
      if (this.#closed) throw new Error('Helm is stopping. Try again after it starts.');
      if (!this.#state.ollamaPort) {
        const probe = createServer();
        const ollamaPort = await listen(probe, 0);
        await close(probe);
        this.#save({ ...this.#state, ollamaPort });
      }
      await this.service(this.#state.ollamaPort);
      let info = await this.#ollama('/api/show', { model }).catch((error) => {
        if (error.status !== 404) throw error;
        return null;
      });
      if (!info) {
        await this.#ollama('/api/pull', { model, stream: false }, MODEL_WORK_MS);
        info = await this.#ollama('/api/show', { model });
      }
      if (info.remote_host || info.remote_model) throw new Error('Choose a model that Ollama can run on this machine.');
      if (Array.isArray(info.capabilities) && !info.capabilities.includes('completion')) {
        throw new Error('Choose an Ollama model that can answer chat messages.');
      }
      await this.#openGateway();
      try { await this.#ollama('/api/generate', { model, stream: false, keep_alive: -1 }, MODEL_WORK_MS); }
      catch (error) {
        if (!this.#state.models.length) await this.#retireGateway();
        throw error;
      }
      const row = { model, tools: !!info.capabilities?.includes('tools'), images: !!info.capabilities?.includes('vision') };
      const maxContext = Object.entries(info.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1];
      row.context = Number.isSafeInteger(maxContext) && maxContext > 0 ? Math.min(maxContext, OLLAMA_CONTEXT) : OLLAMA_CONTEXT;
      this.#save({ ...this.#state, models: [...this.#state.models.filter((m) => m.model !== model), row] });
      return (await this.list()).models.find((m) => m.model === model);
    });
  }

  stop(value) {
    const model = modelName(value);
    return this.#serial(async () => {
      if (this.#loadError) throw this.#loadError;
      const row = this.#state.models.find((m) => m.model === model);
      if (!row) return { stopped: false };
      this.#save({
        ...this.#state,
        models: this.#state.models.map((m) => m === row ? { ...row, stopping: true } : m),
      });
      await this.#finishStop(model);
      return { stopped: true };
    });
  }

  async #finishStop(model) {
    await Promise.all(this.#active.get(model) ?? []);
    const { models } = await this.#ollama('/api/ps');
    if (runningModel(models, model)) await this.#ollama('/api/generate', { model, stream: false, keep_alive: 0 }, MODEL_WORK_MS);
    this.#save({ ...this.#state, models: this.#state.models.filter((m) => m.model !== model) });
    if (!this.#state.models.length) await this.#retireGateway();
  }

  /** Grant one joined machine access to the model port using a Helm forward. */
  async open(peer, generation) {
    const { gateway, models } = this.catalog();
    if (!gateway || !models.length || gateway.generation !== generation) throw new Error('This machine has no matching model service.');
    const { self } = this.network();
    if (self === peer) return { port: gateway.port };
    const id = forwardId(self, peer, generation);
    await this.forwards.add({ id, side: 'out', peer, port: gateway.port });
    if (this.catalog().gateway?.generation !== generation || !this.catalog().models.length) {
      await this.forwards.remove(id, { notify: true });
      throw new Error('The model service stopped.');
    }
    return { id, port: gateway.port };
  }

  async #openGateway() {
    if (this.#gateway) return;
    if (this.#closed) throw new Error('Helm is stopping. Try again after it starts.');
    const server = createServer((req, res) => {
      this.#request(req, res).catch(() => {
        if (res.headersSent) res.destroy();
        else answer(res, 502, { error: { message: 'The Ollama user service did not answer.' } });
      });
    });
    const port = await listen(server, this.#state.port ?? 0);
    try {
      if (this.#closed) throw new Error('Helm is stopping. Try again after it starts.');
      if (!this.#state.port) this.#save({ ...this.#state, port, generation: randomBytes(16).toString('hex') });
      this.#gateway = server;
    } catch (error) {
      await close(server);
      throw error;
    }
  }

  async #retireGateway() {
    const { generation, ollamaPort } = this.#state;
    const { self } = this.network();
    for (const { id, side, peer } of this.forwards.list()) {
      if (side === 'out' && id === forwardId(self, peer, generation)) {
        await this.forwards.remove(id, { notify: true });
      }
    }
    const gateway = this.#gateway;
    this.#gateway = null;
    if (gateway) await close(gateway);
    this.#save({ ollamaPort, models: [] });
  }

  async #request(req, res) {
    const { models } = this.catalog();
    if (req.method === 'GET' && req.url === '/v1/models') {
      return answer(res, 200, { object: 'list', data: models.map(({ model }) => ({ id: model, object: 'model', owned_by: 'ollama' })) });
    }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/completions'].includes(req.url)) {
      return answer(res, 404, { error: { message: 'This address serves OpenAI model requests.' } });
    }
    if (!/^application\/json\s*(?:;|$)/i.test(req.headers['content-type'] ?? '') || req.headers.origin) {
      return answer(res, 415, { error: { message: 'Send a JSON request from an API client.' } });
    }
    let body;
    try {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      body = JSON.parse(Buffer.concat(chunks));
      body.model = modelName(body.model);
    } catch {
      if (!res.destroyed) answer(res, 400, { error: { message: 'Send valid JSON with an Ollama model name.' } });
      return;
    }
    if (!this.catalog().models.some(({ model }) => model === body.model)) {
      return answer(res, 404, { error: { message: 'Helm does not serve that model on this machine.' } });
    }
    // Let a reply finish before stop unloads the model. A closed client
    // also closes its Ollama request, including a response that streams.
    const abort = new AbortController();
    const completed = Promise.withResolvers();
    const active = this.#active.get(body.model) ?? new Set();
    active.add(completed.promise);
    this.#active.set(body.model, active);
    res.once('close', () => abort.abort());
    try {
      const reply = await this.fetcher(`http://127.0.0.1:${this.#state.ollamaPort}${req.url}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: abort.signal, redirect: 'error',
      });
      res.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') ?? 'application/json' });
      if (reply.body) await pipeline(reply.body, res);
      else res.end();
    } finally {
      active.delete(completed.promise);
      if (!active.size) this.#active.delete(body.model);
      completed.resolve();
    }
  }
}
