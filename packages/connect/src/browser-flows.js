import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const placeholder = /\{\{(\w+)\}\}/g;
export function flowName(name) { if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('flow names use lowercase letters, digits, - and _ (up to 64 characters)'); return name; }
export function fillParams(value, values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('flow values must be an object');
  if (typeof value === 'string') return value.replace(placeholder, (_, key) => { if (!Object.hasOwn(values, key)) throw new Error(`missing flow value: ${key}`); if (!['string', 'number', 'boolean'].includes(typeof values[key])) throw new Error(`flow value must be text, number or boolean: ${key}`); return String(values[key]); });
  if (Array.isArray(value)) return value.map(item => fillParams(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillParams(item, values)]));
  return value;
}
export function validateFlow(actions, name, note = '') {
  flowName(name);
  if (!Array.isArray(actions) || actions.length > 40 || actions.some(a => !a || typeof a !== 'object' || Array.isArray(a) || a.kind === 'batch' || 'actions' in a)) throw new Error('a flow holds at most 40 nonnested actions');
  if (typeof note !== 'string' || note.length > 2000 || JSON.stringify(actions).length > 100000) throw new Error('flow is too large');
}
export class BrowserFlows {
  constructor(directory) { this.directory = join(directory, 'flows'); }
  async load(name) { const flow = JSON.parse(await readFile(join(this.directory, `${flowName(name)}.json`), 'utf8')); validateFlow(flow.actions, name, flow.note); return flow; }
  async list() {
    const files = await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const flows = []; for (const file of files.sort()) if (/^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(file)) { const name = file.slice(0, -5), flow = await this.load(name); flows.push({ name, note: flow.note, params: flow.params }); } return { flows };
  }
  async save(name, actions, note, result) {
    validateFlow(actions, name, note);
    if (result.failedAt != null || result.error) return false;
    const params = [...new Set([...JSON.stringify(actions).matchAll(placeholder)].map(match => match[1]))].sort();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${name}-${randomBytes(8).toString('hex')}.tmp`);
    try { await writeFile(temporary, JSON.stringify({ actions, note: note || '', params }), { mode: 0o600, flag: 'wx' }); await rename(temporary, join(this.directory, `${name}.json`)); }
    finally { await rm(temporary, { force: true }); }
    return true;
  }
}
