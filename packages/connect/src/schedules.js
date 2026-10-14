import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { HELM_DIR } from './paths.js';

const MAX_BODY = 16384, MAX_TASKS = 128, MAX_DELIVERIES = 32;
const token = () => randomBytes(24).toString('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const secretName = /authorization|cookie|token|secret|signature|password|key/i;
export function renderWebhookPrompt(prompt, { body, headers = {}, query = {} }) {
  let parsed; try { parsed = JSON.parse(body); } catch { parsed = Object.fromEntries(new URLSearchParams(body)); }
  const clean = values => Object.fromEntries(Object.entries(values).filter(([key]) => !secretName.test(key)));
  const roots = { body: parsed, headers: clean(headers), query: clean(query) };
  return prompt.replace(/\{\{\s*(body|headers|query)([\w.-]*)\s*\}\}/g, (_, root, path) => {
    if (root === 'body' && !path) return body;
    let value = roots[root];
    for (const key of path.replace(/^\./, '').split('.').filter(Boolean)) value = value && Object.hasOwn(value, key) ? value[key] : undefined;
    return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  });
}

// Minute resolution, IANA zone and weekdays (Sunday=0). Scanning real minutes
// handles DST gaps and repeated hours without inventing a nonexistent local time.
export function nextScheduledRun(record, from) {
  if (record.type === 'webhook') return null;
  if (record.type !== 'fixed_time') return from + record.intervalMinutes * 60000;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: record.timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const fromParts = Object.fromEntries(format.formatToParts(from).map(p => [p.type, p.value]));
  const dateKey = parts => `${parts.year}-${parts.month}-${parts.day}`;
  const passedToday = `${fromParts.hour}:${fromParts.minute}` >= record.timeOfDay;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let at = Math.floor(from / 60000) * 60000 + 60000, end = at + 8 * 86400000; at <= end; at += 60000) {
    const parts = Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value]));
    if (passedToday && dateKey(parts) === dateKey(fromParts)) continue;
    if (`${parts.hour}:${parts.minute}` === record.timeOfDay && (!record.weekdays?.length || record.weekdays.includes(days.indexOf(parts.weekday)))) return at;
  }
  throw new Error('could not find the next scheduled time');
}

export class Schedules {
  constructor({ sessions, directory = HELM_DIR, now = Date.now, shareName, publicOrigin = () => null } = {}) {
    this.sessions = sessions; this.directory = directory; this.filename = join(directory, 'schedules.json');
    this.now = now; this.shareName = shareName; this.publicOrigin = publicOrigin;
    this.records = []; this.running = new Set(); this.generation = 0; this.rates = new Map();
    if (existsSync(this.filename)) {
      const data = JSON.parse(readFileSync(this.filename, 'utf8'));
      if (!Array.isArray(data) || data.length > MAX_TASKS) throw new Error('saved schedules are invalid');
      this.records = data;
    }
  }
  persist() {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(`${this.filename}.tmp`, JSON.stringify(this.records), { mode: 0o600 });
    renameSync(`${this.filename}.tmp`, this.filename);
  }
  view(record) {
    const { webhookToken, hmacSecret, deliveries, ...visible } = record;
    const path = webhookToken ? `/hooks/${record.id}/${webhookToken}` : null;
    return { ...visible, ...(path ? { webhook: { path, url: this.port && this.publicOrigin() ? `${this.publicOrigin()}${path}` : null, hasSecret: !!hmacSecret, error: this.listenerError || null },
      deliveries: (deliveries || []).map(({ prompt, ...receipt }) => receipt) } : {}) };
  }
  list(sessionId) {
    return { schedules: this.records.filter(r => !sessionId || r.sessionId === sessionId).map(r => this.view(r)), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, error: this.backgroundError || null };
  }
  save(input) {
    const current = input.id ? this.records.find(r => r.id === input.id) : null;
    if (input.id && !current) throw new Error('schedule not found');
    if (!current && this.records.length >= MAX_TASKS) throw new Error('too many scheduled tasks');
    if (current && this.running.has(current.id)) throw new Error('wait for the current dispatch to finish');
    const next = { ...current, ...input };
    const session = this.sessions.get(next.sessionId);
    if (!session.driver || session.external || session.archived || session.delegation || session.nativeChat || session.nativeCli) throw new Error('choose an active Helm thread for scheduled work');
    if (typeof next.prompt !== 'string' || !next.prompt.trim() || next.prompt.length > 32000) throw new Error('a scheduled task needs 1–32000 characters');
    const type = next.type || 'interval';
    if (!['interval', 'fixed_time', 'webhook'].includes(type)) throw new Error('invalid trigger');
    if (type === 'interval' && (!Number.isInteger(next.intervalMinutes) || next.intervalMinutes < 5 || next.intervalMinutes > 525600)) throw new Error('choose an interval between 5 minutes and one year');
    if (type === 'fixed_time') {
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next.timeOfDay)) throw new Error('choose a time in HH:MM format');
      try { new Intl.DateTimeFormat('en-US', { timeZone: next.timeZone }).format(); } catch { throw new Error('choose an IANA time zone'); }
      if (next.weekdays != null && (!Array.isArray(next.weekdays) || next.weekdays.length > 7 || next.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error('invalid weekdays');
    }
    for (const key of ['enabled', 'freshThread', 'rotateToken']) if (next[key] != null && typeof next[key] !== 'boolean') throw new Error(`${key} must be true or false`);
    if (next.nextRunAt != null && (!Number.isFinite(next.nextRunAt) || next.nextRunAt <= 0)) throw new Error('invalid next run time');
    if (input.hmacSecret != null && (typeof input.hmacSecret !== 'string' || input.hmacSecret.length > 256 || input.hmacSecret && input.hmacSecret.length < 16)) throw new Error('HMAC secret needs 16–256 characters');
    const record = {
      id: current?.id ?? randomBytes(8).toString('hex'), sessionId: session.id,
      name: String(next.name || 'Scheduled task').slice(0, 100), prompt: next.prompt.trim(), type,
      intervalMinutes: next.intervalMinutes, timeOfDay: next.timeOfDay,
      timeZone: next.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone, weekdays: [...new Set(next.weekdays || [])],
      freshThread: next.freshThread ?? false, enabled: next.enabled ?? true,
      createdAt: current?.createdAt ?? this.now(), lastRunAt: current?.lastRunAt, lastSessionId: current?.lastSessionId,
      lastTurnId: current?.lastTurnId, lastError: current?.lastError, dispatching: current?.dispatching,
      ...(type === 'webhook' ? { webhookToken: input.rotateToken ? token() : current?.webhookToken || token(), hmacSecret: input.hmacSecret ?? current?.hmacSecret ?? '',
        deliveries: input.rotateToken ? [] : current?.deliveries || [] } : {}),
    };
    const changed = !current || ['type', 'intervalMinutes', 'timeOfDay', 'timeZone', 'weekdays'].some(key => JSON.stringify(record[key]) !== JSON.stringify(current[key] ?? (key === 'type' ? 'interval' : key === 'weekdays' ? [] : undefined)));
    record.nextRunAt = type === 'webhook' ? null : input.nextRunAt ?? (!changed ? current.nextRunAt : nextScheduledRun(record, this.now()));
    // Edits invalidate queued webhook payloads rendered against the previous template.
    if (current && (current.prompt !== record.prompt || current.sessionId !== record.sessionId || current.freshThread !== record.freshThread || input.hmacSecret != null)) record.deliveries = [];
    this.records = [...this.records.filter(r => r.id !== record.id), record]; this.persist();
    return { schedule: this.view(record) };
  }
  remove(id) {
    if (this.running.has(id)) throw new Error('wait for the current dispatch to finish');
    this.records = this.records.filter(r => r.id !== id); this.rates.delete(id); this.persist(); return { ok: true };
  }
  async run(id, manual = true, delivery = null) {
    const record = this.records.find(r => r.id === id);
    if (!record) throw new Error('schedule not found');
    if (this.running.has(id)) return { skipped: true, reason: 'This task is already dispatching.' };
    if (record.type === 'webhook' && !delivery) {
      delivery = record.deliveries?.find(d => d.status === 'pending' || d.status === 'error');
      if (!delivery) throw new Error('Webhook tasks need a delivery. POST to the secret URL.');
    }
    const source = this.sessions.get(record.sessionId);
    let last; try { last = record.lastSessionId && this.sessions.get(record.lastSessionId); } catch { /* deleted result */ }
    if (source.archived || source.stoppedAt || source.recovery || (record.freshThread ? last && !last.archived && (last.stoppedAt || last.recovery || !this.sessions.canReturnTask(last.id)) : !this.sessions.canReturnTask(source.id))) {
      return { skipped: true, reason: 'The thread is busy, stopped, or needs attention.' };
    }
    this.running.add(id);
    const generation = this.generation;
    const stopGeneration = source.stopGeneration ?? 0;
    const turnId = delivery?.turnId || record.dispatching || `local-schedule-${id}-${this.now()}-${randomBytes(3).toString('hex')}`;
    record.dispatching = turnId; this.persist();
    try {
      let session = source;
      if (record.freshThread) {
        session = this.sessions.findAutomationSession?.(turnId) || await this.sessions.start({
          cwd: source.quick ? undefined : source.cwd, quick: !!source.quick, profileId: source.profileId, model: source.model,
          mode: source.mode, effort: source.effort, speed: source.speed, title: record.name, originAutomationId: turnId,
        });
      }
      if (generation !== this.generation || source.stoppedAt || source.archived || (source.stopGeneration ?? 0) !== stopGeneration) throw new Error('automation cancelled before dispatch');
      const accepted = this.sessions.events?.turnState(session.id, turnId);
      if (record.freshThread && (session.archived || session.stoppedAt || session.recovery || !accepted && !this.sessions.canReturnTask(session.id))) return { skipped: true, reason: 'The execution thread is waiting for startup or approval.' };
      await this.sessions.input(session.id, delivery?.prompt || record.prompt, { turnId, delivery: 'queue', source: 'schedule' });
      record.lastTurnId = turnId; record.lastSessionId = session.id; record.lastRunAt = this.now();
      record.nextRunAt = nextScheduledRun(record, this.now()); delete record.lastError; delete record.dispatching;
      if (delivery) { delivery.status = 'sent'; delivery.sessionId = session.id; delete delivery.prompt; }
      this.persist(); return { ok: true, sessionId: session.id, turnId };
    } catch (error) {
      record.lastError = error.message; record.enabled = false;
      // Retain the durable dispatch identity: resuming after uncertain delivery
      // must reuse the same turn/thread rather than duplicate the work.
      if (delivery) delivery.status = 'error';
      const target = record.freshThread ? this.sessions.findAutomationSession?.(turnId) : source;
      const state = target && this.sessions.events?.turnState(target.id, turnId);
      if (state === 'failed' || state === 'removed') {
        delete record.dispatching;
        if (delivery) delivery.turnId = `local-hook-${record.id}-${randomBytes(12).toString('hex')}`;
      }
      this.persist(); throw error;
    } finally { this.running.delete(id); }
  }
  async receive(id, suppliedToken, { body = '', rawBody, headers = {}, query = {} } = {}) {
    const record = this.records.find(r => r.id === id && r.type === 'webhook');
    if (!record || !same(record.webhookToken, suppliedToken)) return { status: 404, error: 'Webhook not found' };
    if (!record.enabled) return { status: 409, error: 'Automation is paused' };
    if (Buffer.byteLength(body) > MAX_BODY) return { status: 413, error: 'Webhook body exceeds 16 KiB' };
    if (record.hmacSecret) {
      const expected = `sha256=${createHmac('sha256', record.hmacSecret).update(rawBody || body).digest('hex')}`;
      if (!same(expected, headers['x-hub-signature-256'])) return { status: 401, error: 'Invalid signature' };
    }
    const deliveryId = String(headers['x-github-delivery'] || headers['idempotency-key'] || token());
    if (deliveryId.length > 128) return { status: 400, error: 'Delivery ID exceeds 128 characters' };
    const prior = record.deliveries?.find(d => d.id === deliveryId);
    if (prior) return { status: 202, deliveryId, state: prior.status, duplicate: true };
    const rate = this.rates.get(id);
    const bucket = rate && rate.at > this.now() - 60000 ? rate : { at: this.now(), count: 0 };
    this.rates.set(id, bucket);
    if (++bucket.count > 30 || (record.deliveries || []).filter(d => d.status === 'pending').length >= 8) return { status: 429, error: 'Webhook queue is full; retry later' };
    const prompt = renderWebhookPrompt(record.prompt, { body, headers, query });
    if (!prompt.trim() || prompt.length > 32000) return { status: 413, error: 'Rendered task exceeds 32000 characters' };
    const delivery = { id: deliveryId, at: this.now(), status: 'pending', prompt, turnId: `local-hook-${record.id}-${randomBytes(12).toString('hex')}` };
    record.deliveries = [...(record.deliveries || []).slice(-(MAX_DELIVERIES - 1)), delivery]; this.persist();
    this.backgroundTick(); return { status: 202, deliveryId, state: 'pending' };
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    const generation = this.generation;
    try {
      for (const record of [...this.records]) {
        if (generation !== this.generation) break;
        if (!record.enabled || this.running.has(record.id)) continue;
        const delivery = record.type === 'webhook' ? record.deliveries?.find(d => d.status === 'pending' || d.status === 'error') : null;
        if (record.type === 'webhook' ? !delivery : record.nextRunAt > this.now()) continue;
        if (record.type === 'fixed_time' && !record.dispatching && this.now() - record.nextRunAt > 600000) {
          record.nextRunAt = nextScheduledRun(record, this.now()); this.persist(); continue;
        }
        try { await this.run(record.id, false, delivery); }
        catch (error) { record.lastError = error.message; record.enabled = false; this.persist(); }
      }
    } finally { this.ticking = false; }
  }
  share() {
    return this.port && this.records.some(r => r.type === 'webhook') ? { name: this.shareName, port: this.port, automation: true, createdAt: 0 } : null;
  }
  async listen() {
    if (this.server || !this.shareName) return;
    this.server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 }, (req, res) => {
      const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
      let url; try { url = new URL(req.url, 'http://localhost'); } catch { reply(400, { error: 'Invalid URL' }); return; }
      const match = /^\/hooks\/([a-f0-9]{16})\/([a-f0-9]{48})$/.exec(url.pathname);
      if (!match) { reply(404, { error: 'Webhook not found' }); return; }
      if (req.method !== 'POST') { reply(405, { error: 'Use POST' }); return; }
      const record = this.records.find(r => r.id === match[1]);
      if (!record || !same(record.webhookToken, match[2])) { reply(404, { error: 'Webhook not found' }); return; }
      const chunks = []; let bytes = 0, rejected = false;
      req.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BODY) { if (!rejected) reply(413, { error: 'Webhook body exceeds 16 KiB' }); rejected = true; } else chunks.push(chunk); });
      req.on('error', () => { if (!res.headersSent) reply(400, { error: 'Incomplete request' }); });
      req.on('end', () => {
        if (rejected) return;
        const rawBody = Buffer.concat(chunks), body = rawBody.toString('utf8');
        this.receive(match[1], match[2], { body, rawBody, headers: req.headers, query: Object.fromEntries(url.searchParams) })
          .then(({ status, ...data }) => reply(status, data)).catch(() => reply(503, { error: 'Automation unavailable' }));
      });
    });
    const server = this.server;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (this.server !== server) { server.close(); return; }
    this.port = server.address().port; server.unref();
  }
  backgroundTick() { void this.tick().then(() => { this.backgroundError = null; }).catch(error => { this.backgroundError = error.message; }); }
  start() {
    if (this.timer) return;
    void this.listen().catch(error => { this.listenerError = error.message; });
    this.timer = setInterval(() => this.backgroundTick(), 15000); this.timer.unref?.(); this.backgroundTick();
  }
  stop() { this.generation += 1; clearInterval(this.timer); this.timer = null; this.server?.close(); this.server = null; this.port = null; }
}
