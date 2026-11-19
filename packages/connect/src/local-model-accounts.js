import { join } from 'node:path';
import { M } from '@helm/protocol';
import { cliVersion } from './drivers/index.js';
import { expand } from './paths.js';
import { forwardId, hash, hosts, modelDir, modelName, modelUrl, readModelState, validPort, writeModelState } from './local-model-state.js';

const PROVIDER = 'helm-local';
const LOOKUP_MS = 5000;
const CATALOG_MS = 15_000;
const accountFile = (dir) => join(dir, 'accounts.json');
const readAccounts = (dir) => {
  try { return readModelState(accountFile(dir), {}); }
  catch { return {}; } // A fresh catalog can rebuild this cache.
};

function distinct(profiles, base) {
  const seen = new Set(base.map((p) => p.id));
  return profiles.flat().filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

export function cachedModelProfiles(base, dir = modelDir) {
  const saved = readAccounts(dir);
  return distinct(Object.entries(saved).sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => rows), base);
}

export function localProfileCatalog(profile) {
  if (profile?.source !== 'local-model') return null;
  const { selector, model, images } = profile.localModel;
  return {
    default: selector, models: [selector], labels: { [selector]: model },
    images, imagesByModel: { [selector]: images }, efforts: [],
  };
}

function installedClients(profiles) {
  const installed = (engine) => profiles.find((p) => p.id === engine && !p.disabled)
    ?? profiles.find((p) => p.engine === engine && !p.disabled && p.source !== 'local-model' && !p.wraps);
  return [installed('opencode') ?? installed('opencode2'), installed('pi')].filter(Boolean);
}

function checkedCatalog(result) {
  if (!result || !Array.isArray(result.models)) throw new Error('This machine did not send a model list.');
  if (!result.models.length) return { gateway: null, models: [] };
  const { gateway } = result;
  if (!validPort(gateway?.port) || !/^[a-f0-9]{32}$/.test(gateway.generation ?? '')) {
    throw new Error('The model address on this machine is unavailable.');
  }
  const models = result.models.map((row) => ({
    model: modelName(row.model), tools: row.tools === true, images: row.images === true,
    context: Number.isSafeInteger(row.context) && row.context > 0 ? row.context : 4096,
  }));
  return { gateway, models };
}

/** These files belong to the local account. Keep the owner's CLI files and logins in place. */
export function modelProfile(client, id, row, baseURL, dir, version) {
  const { model, tools, images, context } = row;
  const { engine } = client;
  const home = join(dir, 'accounts', hash(JSON.stringify([model, engine])));
  const selector = `${PROVIDER}/${model}`;
  const profile = {
    id, label: `${model} · ${engine === 'pi' ? 'Pi' : 'OpenCode'}`, engine, source: 'local-model',
    cmd: client.cmd, args: [], env: {}, localModel: { model, selector, images },
  };
  const input = images ? ['text', 'image'] : ['text'];
  const output = Math.min(1024, Math.floor(context / 2)) || 1;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (engine === 'pi') {
    profile.env.PI_CODING_AGENT_DIR = home;
    if (!tools) profile.args = ['--no-tools'];
    writeModelState(join(home, 'models.json'), {
      providers: { [PROVIDER]: {
        baseUrl: baseURL, apiKey: 'ollama', api: 'openai-completions',
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        models: [{ id: model, name: model, input, contextWindow: context, maxTokens: output, cost }],
      } },
    });
  } else {
    const v2 = engine === 'opencode2' || Number(version?.split('.')[0]) >= 2;
    const file = join(home, 'opencode', 'opencode.json');
    profile.env = {
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      OPENCODE_CONFIG: file,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    };
    const spec = { name: model, limit: { context, output } };
    const provider = v2 ? {
      name: 'Helm local model',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL, apiKey: 'ollama' },
      models: { [model]: { ...spec, capabilities: { tools, input, output: ['text'] } } },
    } : {
      name: 'Helm local model',
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL, apiKey: 'ollama' },
      models: { [model]: { ...spec, tool_call: tools, attachment: images, modalities: { input, output: ['text'] } } },
    };
    writeModelState(file, {
      model: selector,
      // On small windows OpenCode can try to summarize its own prompt
      // before the model receives any task. Manual compaction stays available.
      ...(context < 8192 ? { compaction: { auto: false } } : {}),
      ...(v2 ? { providers: { [PROVIDER]: provider } } : {
        small_model: selector, enabled_providers: [PROVIDER], provider: { [PROVIDER]: provider },
      }),
    });
  }
  return profile;
}

export class LocalModelAccounts {
  #catalogs = new Map();
  #endpoints = new Map();
  #syncing = null;

  constructor({ dir = modelDir, network, rpc, host, forwards, version = cliVersion, log = () => {} }) {
    Object.assign(this, { dir, network, rpc, host, forwards, version, log });
  }

  async #read(host, fresh) {
    if (host === this.network().self) return checkedCatalog(this.host.catalog());
    const before = this.#catalogs.get(host);
    if (before && (!before.at || (!fresh && Date.now() - before.at < CATALOG_MS))) return before.result;
    const entry = { at: null };
    entry.result = this.rpc(host, M.LOCAL_MODELS_CATALOG, {}, LOOKUP_MS).then(checkedCatalog).finally(() => { entry.at = Date.now(); });
    this.#catalogs.set(host, entry);
    return entry.result;
  }

  /** Open the same saved forward on repeat requests and across a restart. */
  async endpoint(host, gateway) {
    const net = this.network();
    if (!hosts(net).some((m) => m.id === host)) throw new Error('That machine is not in this network.');
    gateway ??= (await this.#read(host, true)).gateway;
    if (!gateway) throw new Error('This machine has no model address.');
    if (host === net.self) return modelUrl(gateway.port);
    const id = forwardId(host, net.self, gateway.generation);
    const existing = this.forwards.list().find((f) => f.id === id && f.side === 'in' && f.peer === host && f.port === gateway.port);
    if (existing?.listening) return modelUrl(existing.localPort);
    let job = this.#endpoints.get(id);
    if (!job) {
      job = (async () => {
        const opened = await this.rpc(host, M.LOCAL_MODELS_OPEN, { generation: gateway.generation }, 15_000);
        if (opened?.id !== id || opened?.port !== gateway.port) throw new Error('The model address changed. Try again.');
        const forward = await this.forwards.add({ id, side: 'in', peer: host, port: gateway.port, localPort: existing?.localPort ?? 0 });
        return modelUrl(forward.localPort);
      })().finally(() => this.#endpoints.delete(id));
      this.#endpoints.set(id, job);
    }
    return job;
  }

  sync(base, { fresh = false } = {}) {
    if (this.#syncing) return this.#syncing;
    this.#syncing = this.#sync(base, fresh).finally(() => { this.#syncing = null; });
    return this.#syncing;
  }

  async #sync(base, fresh) {
    const clients = installedClients(base);
    if (!clients.length) return [];
    const saved = readAccounts(this.dir);
    const machines = hosts(this.network()).sort((a, b) => a.id.localeCompare(b.id));
    const catalogs = await Promise.all(machines.map(async ({ id }) => {
      try {
        const { models, gateway } = await this.#read(id, fresh);
        return { id, models, url: models.length ? await this.endpoint(id, gateway) : null };
      } catch (error) {
        if (!/offline|unknown method|unreachable|timed out/i.test(error.message)) this.log(`Model accounts on ${id}. ${error.message}`);
        return { id, models: null };
      }
    }));
    const versions = catalogs.some(({ models }) => models?.length)
      ? await Promise.all(clients.map((c) => c.engine === 'opencode' ? this.version(expand(c.cmd)) : null))
      : [];
    // A model can move to another host. Keep its client home so old chats
    // keep their CLI history. Choose one host before writing the config.
    const claimed = new Set(base.map((p) => p.id));
    const results = catalogs.map(({ id, models, url }) => ({
      id,
      profiles: models?.flatMap((row) => clients.flatMap((client, index) => {
        const name = `local-${row.model}${index === 0 ? '' : '@pi'}`;
        if (claimed.has(name)) return [];
        claimed.add(name);
        return [modelProfile(client, name, row, url, this.dir, versions[index])];
      })),
    }));
    const active = distinct(results.map(({ profiles }) => profiles ?? []), base);
    const activeIds = new Set(active.map((p) => p.id));
    const next = Object.fromEntries(results.flatMap(({ id, profiles }) => {
      const rows = profiles ?? saved[id]?.filter((p) => !activeIds.has(p.id));
      return rows?.length ? [[id, rows]] : [];
    }));
    if (JSON.stringify(next) !== JSON.stringify(saved)) writeModelState(accountFile(this.dir), next);
    // Keep the last settings on disk for old chats if a host is away. Offer
    // new chats only on machines that answered and have a working forward.
    return active;
  }
}
