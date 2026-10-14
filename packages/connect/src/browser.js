import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { HELM_DIR } from './paths.js';

const id = () => randomBytes(8).toString('hex');
const cap = (rows, value, limit = 100) => { rows.push(value); if (rows.length > limit) rows.shift(); };
const text = (value, max = 20000) => { if (typeof value !== 'string' || value.length > max) throw new Error(`expected text up to ${max} characters`); return value; };
const integer = (value, min, max) => { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`expected integer ${min}–${max}`); return value; };
const httpUrl = value => { const u = new URL(String(value).includes('://') || String(value).startsWith('about:') ? value : `https://${value}`); if (!['http:', 'https:'].includes(u.protocol) && u.href !== 'about:blank') throw new Error('use an HTTP or HTTPS browser address'); return u.href; };
const executable = () => process.env.HELM_CHROMIUM_PATH || process.env.HELM_TEST_CHROMIUM || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
const LAUNCH = { headless: true, args: ['--disable-gpu', '--disk-cache-size=33554432'], timeout: 15000 };
// Playwright's headless shell starts ~3x faster and uses about half the memory of full Chromium; a pinned path or a missing shell falls back to the system browser.
async function launchChromium() {
  const { chromium } = await import('playwright'), pinned = process.env.HELM_CHROMIUM_PATH || process.env.HELM_TEST_CHROMIUM;
  if (pinned) return chromium.launch({ ...LAUNCH, executablePath: pinned });
  try { return await chromium.launch(LAUNCH); }
  catch (error) { const system = executable(); if (!system) throw error; return chromium.launch({ ...LAUNCH, executablePath: system }); }
}
const bowserBin = () => process.env.HELM_BOWSER_PATH || (process.env.PATH || '').split(':').map(p => join(p, 'bowser-computer')).find(existsSync);
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_THREAD_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const BROWSER_PREVIEWS = Object.freeze({
  low: { maxWidth: 640, maxHeight: 640, quality: 35, interval: 1000 },
  balanced: { maxWidth: 960, maxHeight: 960, quality: 50, interval: 500 },
  full: { maxWidth: 1280, maxHeight: 1200, quality: 60, interval: 200 },
  smooth: { maxWidth: 1280, maxHeight: 1200, quality: 60, interval: 33 },
});
const FRAME_WAIT_MS = 1500;

/** One persistent stdio bridge to the owner's Bowser. Closing it leaves Bowser intact. */
export class BowserBridge {
  constructor({ bin = bowserBin(), spawnProcess = spawn } = {}) { this.bin = bin; this.spawnProcess = spawnProcess; this.pending = new Map(); this.sequence = 0; }
  async call(name, args = {}) {
    if (!this.child) {
      if (!this.bin) throw new Error('Bowser Computer Use is not installed on this machine');
      this.child = this.spawnProcess(this.bin, ['browser-mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '';
      this.child.stdout.on('data', bytes => {
        buffer += bytes.toString();
        if (buffer.length > 12 * 1024 * 1024) { this.stop(); return; }
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { const reply = JSON.parse(line), waiter = this.pending.get(reply.id); if (waiter) { this.pending.delete(reply.id); clearTimeout(waiter.timer); reply.error ? waiter.reject(new Error(reply.error.message)) : waiter.resolve(reply.result); } } catch { /* nonprotocol diagnostic */ }
        }
      });
      this.child.stderr.on('data', () => {});
      const child = this.child;
      child.on('error', error => { if (this.child === child) this.stop(error); });
      child.on('exit', () => { if (this.child === child) this.stop(new Error('Bowser bridge closed')); });
      child.stdin.on?.('error', error => { if (this.child === child) this.stop(error); });
    }
    const requestId = ++this.sequence;
    const child = this.child;
    const result = await new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Bowser action timed out; inspect the browser before retrying')); }, 45000); timer.unref?.();
      this.pending.set(requestId, { resolve: resolveCall, reject, timer });
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }) + '\n', error => { if (error && this.child === child) this.stop(error); }); }
      catch (error) { this.stop(error); }
    });
    if (result?.isError) throw new Error(result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') || 'Bowser action failed');
    return result;
  }
  stop(error = new Error('Bowser bridge stopped')) { const child = this.child; this.child = null; child?.kill(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
}

/** Lazy, shared Chromium. No browser imports/processes or screenshot work while unused. */
export class BrowserManager {
  constructor({ directory = join(HELM_DIR, 'browser'), session = () => null, launch, now = Date.now, bowser = new BowserBridge(), idleMs = 10 * 60000, actionTimeoutMs = 45000 } = {}) {
    this.directory = directory; this.session = session; this.launch = launch; this.now = now; this.bowser = bowser; this.idleMs = idleMs; this.actionTimeoutMs = actionTimeoutMs; this.tabs = new Map(); this.contexts = new Map(); this.serial = new Map(); this.recovered = new Map(); this.suspending = new Set(); this.browser = null;
  }
  async start() {
    if (!this.starting) this.starting = (async () => {
      if (this.browser?.isConnected()) return this.browser;
      const launch = this.launch || launchChromium;
      try { this.browser = await launch(); } catch (error) { throw new Error(`Chromium could not start. Set HELM_CHROMIUM_PATH or install it with npx playwright install chromium. ${error.message}`); }
      const browser = this.browser;
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.browser = null;
        for (const tab of this.tabs.values()) if (tab.engine === 'chromium') { void this.clearStream(tab); this.tabs.delete(tab.id); this.recovered.delete(tab.sessionId); }
        this.contexts.clear();
      });
      this.timer ||= setInterval(() => void this.sweep().catch(() => {}), 2000); this.timer.unref?.();
      return this.browser;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
  owner(sessionId) {
    if (!/^[\w:-]{1,160}$/.test(sessionId || '')) throw new Error('a browser belongs to a Helm thread');
    const session = this.session(sessionId); if (!session) throw new Error('thread not found');
    return session;
  }
  async context(sessionId) {
    if (this.contexts.has(sessionId)) return this.contexts.get(sessionId);
    const browser = await this.start();
    // Concurrent open requests must not create two contexts for one thread.
    if (this.contexts.has(sessionId)) return this.contexts.get(sessionId);
    const pending = (async () => {
      let storageState; try { storageState = JSON.parse(await readFile(join(this.directory, sessionId, 'storage.json'), 'utf8')); } catch {}
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...(storageState ? { storageState } : {}) });
      context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
      context.on('page', page => this.register(sessionId, page));
      return context;
    })();
    this.contexts.set(sessionId, pending);
    try { return await pending; } catch (error) { this.contexts.delete(sessionId); throw error; }
  }
  register(sessionId, page) {
    const existing = [...this.tabs.values()].find(t => t.page === page); if (existing) return existing;
    const tab = { id: id(), sessionId, engine: 'chromium', page, title: '', console: [], network: [], downloads: [], lastUsed: this.now(), viewers: new Map(), sequence: 0, frame: null, control: null, dialog: null };
    this.tabs.set(tab.id, tab);
    page.on('close', () => {
      this.tabs.delete(tab.id); void this.clearStream(tab);
      if (!this.stopping && !this.suspending.has(sessionId)) this.discardDownloads(tab);
      if (!tab.explicitClose && !this.stopping && !this.suspending.has(sessionId)) void this.pageClosed(sessionId).catch(() => {});
    });
    page.on('console', msg => cap(tab.console, { level: msg.type(), text: msg.text().slice(0, 4000), at: this.now() }));
    page.on('pageerror', error => cap(tab.console, { level: 'error', text: error.message.slice(0, 4000), at: this.now() }));
    page.on('response', response => cap(tab.network, { url: response.url().slice(0, 2000), method: response.request().method(), status: response.status() }));
    page.on('requestfailed', request => cap(tab.network, { url: request.url().slice(0, 2000), method: request.method(), error: request.failure()?.errorText }));
    page.on('domcontentloaded', () => { void page.title().then(title => { tab.title = title; }).catch(() => {}); });
    page.on('dialog', dialog => { tab.dialog = dialog; });
    page.on('download', download => {
      const record = { id: id(), name: basename(download.suggestedFilename()), url: download.url(), status: 'pending', at: this.now() };
      if (tab.downloads.length >= 20) { const old = tab.downloads.shift(); old.discarded = true; if (old.path) void rm(old.path, { force: true }).catch(() => {}); }
      tab.downloads.push(record);
      const folder = join(this.directory, sessionId, 'downloads'); mkdirSync(folder, { recursive: true, mode: 0o700 });
      record.path = join(folder, `${record.id}-${record.name}`);
      void download.saveAs(record.path).then(() => this.finishDownload(tab, record)).catch(() => { record.status = 'failed'; void rm(record.path, { force: true }).catch(() => {}); });
    });
    return tab;
  }
  metadata(tab) { return { id: tab.id, engine: tab.engine, url: tab.page?.url() || tab.url || 'about:blank', title: tab.title, viewport: tab.page?.viewportSize() || { width: 1280, height: 800 }, control: tab.control, controlEpoch: tab.controlEpoch || 0, dialog: tab.dialog ? { type: tab.dialog.type(), message: tab.dialog.message().slice(0, 2000) } : null, downloads: tab.downloads.map(({ path, ...d }) => d) }; }
  discardDownloads(tab) { for (const record of tab.downloads) { record.discarded = true; if (record.path) void rm(record.path, { force: true }).catch(() => {}); } }
  async finishDownload(tab, record) {
    if (record.discarded || this.tabs.get(tab.id) !== tab) { await rm(record.path, { force: true }); return; }
    const size = (await stat(record.path)).size;
    if (size > MAX_DOWNLOAD_BYTES) { record.status = 'too large (128 MiB limit)'; await rm(record.path, { force: true }); return; }
    await chmod(record.path, 0o600); record.status = 'ready';
    const records = [...this.tabs.values()].filter(t => t.sessionId === tab.sessionId).flatMap(t => t.downloads.filter(d => d.status === 'ready')).sort((a, b) => (a.at || 0) - (b.at || 0));
    let total = 0; for (const item of records) { item.size = (await stat(item.path).catch(() => ({ size: 0 }))).size; total += item.size; }
    for (const item of records) { if (total <= MAX_THREAD_DOWNLOAD_BYTES) break; item.status = 'expired'; total -= item.size; await rm(item.path, { force: true }); }
    await this.persistTabs(tab.sessionId);
  }
  async recover(sessionId) {
    this.owner(sessionId);
    if (!this.recovered.has(sessionId)) this.recovered.set(sessionId, (async () => {
      let rows; try { rows = JSON.parse(await readFile(join(this.directory, sessionId, 'tabs.json'), 'utf8')); } catch { return; }
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(0, 24)) {
        if (row.engine !== 'chromium' || !/^[a-f0-9]{16}$/.test(row.id)) continue;
        if (this.tabs.has(row.id)) continue;
        const context = await this.context(sessionId), page = await context.newPage(), tab = this.register(sessionId, page);
        this.tabs.delete(tab.id); tab.id = row.id; tab.title = row.title || ''; this.tabs.set(tab.id, tab);
        if (row.viewport && Number.isInteger(row.viewport.width) && row.viewport.width >= 240 && row.viewport.width <= 1920 && Number.isInteger(row.viewport.height) && row.viewport.height >= 200 && row.viewport.height <= 1200) await page.setViewportSize(row.viewport);
        for (const download of (Array.isArray(row.downloads) ? row.downloads : []).slice(-20)) {
          if (!/^[a-f0-9]{16}$/.test(download.id || '') || typeof download.name !== 'string') continue;
          const path = join(this.directory, sessionId, 'downloads', `${download.id}-${basename(download.name)}`);
          tab.downloads.push({ ...download, name: basename(download.name), path, status: download.status === 'ready' && existsSync(path) ? 'ready' : 'failed' });
        }
        try { await page.goto(httpUrl(row.url), { waitUntil: 'domcontentloaded' }); } catch { /* keep the tab available to retry */ }
      }
    })().catch(error => { this.recovered.delete(sessionId); throw error; }));
    return this.recovered.get(sessionId);
  }
  /** Coalesce the tab-list write after busy bursts of actions; navigation, close, idle and stop still write at once. */
  persistSoon(sessionId) {
    const timers = this.persistTimers ||= new Map(); if (timers.has(sessionId)) return;
    const timer = setTimeout(() => { timers.delete(sessionId); if ([...this.tabs.values()].some(t => t.sessionId === sessionId && t.engine === 'chromium')) void this.persistTabs(sessionId).catch(() => {}); }, 1000); timer.unref?.(); timers.set(sessionId, timer);
  }
  async persistTabs(sessionId) { clearTimeout(this.persistTimers?.get(sessionId)); this.persistTimers?.delete(sessionId); const folder = join(this.directory, sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 }); await writeFile(join(folder, 'tabs.json'), JSON.stringify([...this.tabs.values()].filter(t => t.sessionId === sessionId).map(t => this.metadata(t))), { mode: 0o600 }); }
  async list(sessionId) { await this.recover(sessionId); return { tabs: [...this.tabs.values()].filter(t => t.sessionId === sessionId).map(t => this.metadata(t)), bowser: !!bowserBin(), running: !!this.browser }; }
  async open(sessionId, { url = 'about:blank', engine = 'chromium' } = {}) {
    await this.recover(sessionId); url = httpUrl(url);
    if (this.tabs.size >= 24) throw new Error('close a browser tab before opening another (24 tab limit)');
    if (engine === 'bowser') {
      if ([...this.tabs.values()].some(t => t.engine === 'bowser' && t.sessionId !== sessionId)) throw new Error('Bowser is shared; close its Helm tab in the other thread first');
      const existing = [...this.tabs.values()].find(t => t.engine === 'bowser' && t.sessionId === sessionId);
      const tab = existing || { id: id(), sessionId, engine, title: 'Bowser shared browser', console: [], network: [], downloads: [], viewers: new Map(), sequence: 0, control: null };
      // Reserve the shared browser before asynchronous startup/navigation.
      this.tabs.set(tab.id, tab);
      try {
        if (existing?.control && url !== 'about:blank') throw new Error('Release control before navigating the shared Bowser browser.');
        const result = url === 'about:blank' ? await this.bowser.call('look', { budget: 0 }) : await this.bowser.call('act', { actions: [...(!existing ? [{ tab: 'new' }] : []), { goto: url }], budget: 0 });
        tab.url = url; tab.lastUsed = this.now(); this.timer ||= setInterval(() => void this.sweep().catch(() => {}), 2000); this.timer.unref?.(); return { tab: this.metadata(tab), text: result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') };
      } catch (error) { if (!existing) this.tabs.delete(tab.id); throw error; }
    }
    if (engine !== 'chromium') throw new Error('unknown browser engine');
    const context = await this.context(sessionId), page = await context.newPage(), tab = this.register(sessionId, page);
    try { if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' }); tab.title = await page.title(); await this.persistTabs(sessionId); return { tab: this.metadata(tab), ...(await this.look(tab)) }; }
    catch (error) { await page.close(); throw error; }
  }
  get(sessionId, tabId) { this.owner(sessionId); const tab = this.tabs.get(tabId); if (!tab || tab.sessionId !== sessionId) throw new Error('browser tab not found in this thread'); return tab; }
  async run(sessionId, tabId, action, actor = 'agent', expectedEpoch) {
    await this.recover(sessionId);
    const tab = this.get(sessionId, tabId);
    const epoch = expectedEpoch ?? tab.controlEpoch ?? 0;
    // A modal dialog blocks the browser action that created it. Answering
    // must bypass that queue while retaining the same ownership check.
    if (action?.kind === 'dialog') {
      if (actor === 'agent' && ['read', 'readonly', 'plan'].includes(this.owner(sessionId).mode)) throw new Error('this thread is read-only; browser actions that change the page are disabled');
      this.checkControl(tab, action, actor, epoch); tab.lastUsed = this.now(); return this.perform(tab, action, actor, epoch);
    }
    const previous = this.serial.get(tab.id) || Promise.resolve();
    const deadline = Date.now() + this.actionTimeoutMs;
    let started = false, timer;
    const operation = previous.catch(() => {}).then(async () => {
      if (Date.now() >= deadline) throw new Error('Browser action expired before delivery.');
      started = true;
      const owner = this.owner(sessionId);
      if (actor === 'agent' && ['read', 'readonly', 'plan'].includes(owner.mode)) {
        const readOnly = step => ['look', 'console', 'network', 'screenshot', 'navigate', 'back', 'forward'].includes(step?.kind) || step?.kind === 'batch' && Array.isArray(step.actions) && step.actions.every(readOnly);
        if (!readOnly(action)) throw new Error('this thread is read-only; browser actions that change the page are disabled');
      }
      this.checkControl(tab, action, actor, epoch);
      tab.lastUsed = this.now(); const owned = actor !== 'agent' && tab.engine === 'chromium'; if (owned) this.boost(tab);
      const result = await this.perform(tab, action, actor, epoch); if (owned) this.boost(tab);
      if (!['look', 'console', 'network', 'screenshot'].includes(action?.kind)) { if (['navigate', 'back', 'forward', 'reload', 'batch'].includes(action?.kind)) await this.persistTabs(sessionId); else this.persistSoon(sessionId); }
      return result;
    });
    const job = Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { if (started && epoch === (tab.controlEpoch || 0)) tab.controlEpoch = epoch + 1; reject(new Error('Browser action timed out; inspect the page before retrying.')); }, this.actionTimeoutMs); timer.unref?.(); })]);
    this.serial.set(tab.id, job); void job.finally(() => { clearTimeout(timer); if (this.serial.get(tab.id) === job) this.serial.delete(tab.id); }).catch(() => {}); return job;
  }
  async look(tab, budget = 6000) {
    integer(budget, 0, 20000);
    if (tab.engine === 'bowser') { const result = await this.bowser.call('look', { budget }); return { text: result.content.filter(p => p.type === 'text').map(p => p.text).join('\n') }; }
    const result = await tab.page.evaluate(limit => {
      const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const elements = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true]')].filter(visible).slice(0, 300);
      window.__helmBrowserElements = elements;
      return { title: document.title, url: location.href, text: document.body?.innerText.slice(0, limit) || '', elements: elements.map((el, i) => ({ ref: i + 1, role: el.getAttribute('role') || el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().slice(0, 180) })) };
    }, budget);
    tab.title = result.title;
    return { text: `${result.title}\n${result.url}\n${result.text}\n\n${result.elements.map(e => `[${e.ref}] ${e.role} ${JSON.stringify(e.name)}`).join('\n')}`, elements: result.elements };
  }
  async target(tab, action) {
    if (action.ref != null) { integer(action.ref, 1, 300); const handle = await tab.page.evaluateHandle(ref => window.__helmBrowserElements?.[ref - 1], action.ref); const element = handle.asElement(); if (!element) { await handle.dispose(); throw new Error('element reference expired; look at the page again'); } return element; }
    if (action.selector) return tab.page.locator(text(action.selector, 2000)).first();
    if (action.role) return tab.page.getByRole(text(action.role, 40), { name: text(action.name, 500), exact: true });
    if (action.name) return tab.page.getByText(text(action.name, 500), { exact: true });
    throw new Error('choose an element ref, selector, role/name, or x/y coordinates');
  }
  checkControl(tab, action, actor, epoch = tab.controlEpoch || 0) {
    if (['look', 'console', 'network', 'screenshot'].includes(action?.kind)) return;
    if (epoch !== (tab.controlEpoch || 0)) throw new Error('Browser control changed; inspect the tab before continuing.');
    if (actor !== 'agent' && tab.control !== actor) throw new Error('Take control before changing this browser tab.');
    if (tab.control && tab.control !== actor) throw new Error('You have control of this tab. Release control to let the agent continue.');
  }
  async perform(tab, action, actor = 'agent', epoch = tab.controlEpoch || 0) {
    if (!action || typeof action !== 'object') throw new Error('browser action must be an object');
    const kind = action.kind;
    if (kind === 'look') return { tab: this.metadata(tab), ...(await this.look(tab, action.budget ?? 6000)) };
    if (kind === 'console') return { entries: tab.console };
    if (kind === 'network') return { entries: tab.network };
    if (kind === 'screenshot') return this.capture(tab, action);
    if (kind === 'batch') {
      if (!Array.isArray(action.actions) || action.actions.length > 40 || action.actions.some(a => a.kind === 'batch')) throw new Error('a batch holds at most 40 nonnested actions');
      const results = []; for (const step of action.actions) { try { this.checkControl(tab, step, actor, epoch); results.push(await this.perform(tab, step, actor, epoch)); } catch (error) { return { results, failedAt: results.length, error: error.message, ...(await this.look(tab)) }; } } return { results, ...(await this.look(tab)) };
    }
    if (tab.engine === 'bowser') return this.bowserAction(tab, action);
    const page = tab.page;
    if (kind === 'navigate') await page.goto(httpUrl(action.url), { waitUntil: 'domcontentloaded' });
    else if (kind === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else if (kind === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
    else if (kind === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
    else if (kind === 'click' || kind === 'hover') {
      if (action.x != null) { const { width, height } = page.viewportSize(); integer(action.x, 0, width); integer(action.y, 0, height); kind === 'click' ? await page.mouse.click(action.x, action.y, { button: ['left', 'right', 'middle'].includes(action.button) ? action.button : 'left', clickCount: action.double ? 2 : 1 }) : await page.mouse.move(action.x, action.y); }
      else { const target = await this.target(tab, action); try { kind === 'click' ? await target.click({ button: action.button || 'left', clickCount: action.double ? 2 : 1 }) : await target.hover(); } finally { if (target.dispose) await target.dispose(); } }
    } else if (kind === 'drag') { const { width, height } = page.viewportSize(); for (const field of ['fromX', 'toX']) integer(action[field], 0, width); for (const field of ['fromY', 'toY']) integer(action[field], 0, height); await page.mouse.move(action.fromX, action.fromY); await page.mouse.down(); try { await page.mouse.move(action.toX, action.toY, { steps: 6 }); } finally { await page.mouse.up(); } }
    else if (kind === 'type') { const value = text(action.text); if (action.ref || action.selector || action.name || action.role) { const target = await this.target(tab, action); try { await target.fill(value); } finally { if (target.dispose) await target.dispose(); } } else await page.keyboard.insertText(value); }
    else if (kind === 'key') await page.keyboard.press(text(action.key, 100));
    else if (kind === 'clipboard') {
      const origin = new URL(page.url()).origin;
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      try { return { text: await page.evaluate(() => navigator.clipboard.readText()) }; }
      finally { await page.context().clearPermissions(); }
    }
    else if (kind === 'scroll') await page.mouse.wheel(integer(action.dx ?? 0, -20000, 20000), integer(action.dy ?? 500, -20000, 20000));
    else if (kind === 'select') { const target = await this.target(tab, action); try { await target.selectOption(action.values || text(action.value, 1000)); } finally { if (target.dispose) await target.dispose(); } }
    else if (kind === 'upload') {
      const files = await this.uploads(tab, action);
      let target; try { target = await this.target(tab, action); await target.setInputFiles(files.paths); } finally { if (target?.dispose) await target.dispose(); await files.cleanup(); }
    } else if (kind === 'evaluate') return { value: await page.evaluate(text(action.script, 20000)) };
    else if (kind === 'wait') { integer(action.timeout ?? 10000, 1, 30000); if (action.selector) await page.locator(text(action.selector, 2000)).waitFor({ state: action.state || 'visible', timeout: action.timeout ?? 10000 }); else await page.getByText(text(action.text, 2000)).first().waitFor({ timeout: action.timeout ?? 10000 }); }
    else if (kind === 'resize') { await page.setViewportSize({ width: integer(action.width, 240, 1920), height: integer(action.height, 200, 1200) }); await this.clearStream(tab); }
    else if (kind === 'dialog') { if (!tab.dialog) throw new Error('no dialog is open'); const dialog = tab.dialog; tab.dialog = null; action.accept ? await dialog.accept(action.text ?? '') : await dialog.dismiss(); }
    else throw new Error(`unknown browser action: ${kind}`);
    // Only actions that can change the title ask for it; page loads update it as they finish.
    if (!['hover', 'scroll', 'type', 'resize'].includes(kind)) tab.title = await page.title().catch(() => tab.title);
    return { tab: this.metadata(tab) };
  }
  async bowserAction(tab, action) {
    const kind = action.kind, target = action.ref || action.name || action.selector;
    if (kind === 'bowser') { if (!['act', 'look', 'eval', 'flows', 'tabs', 'screenshot'].includes(action.tool)) throw new Error('unknown Bowser tool'); return this.bowser.call(action.tool, action.args || {}); }
    const actions = kind === 'navigate' ? [{ goto: httpUrl(action.url) }] : kind === 'click' ? [{ click: target, double: !!action.double, button: action.button || 'left' }]
      : kind === 'hover' ? [{ hover: target }] : kind === 'type' ? [{ type: text(action.text), ...(target ? { into: target, clear: true } : {}) }] : kind === 'key' ? [{ key: text(action.key, 100) }]
      : kind === 'scroll' ? [{ scroll: (action.dy || 0) < 0 ? 'up' : 'down', pages: Math.max(0.1, Math.abs(action.dy || 500) / 800) }] : kind === 'select' ? [{ select: target, option: action.value }]
      : kind === 'upload' ? [{ upload: target, paths: action.files }] : kind === 'back' ? [{ back: true }] : kind === 'wait' ? [{ wait_for: action.text, timeout: (action.timeout || 10000) / 1000 }]
      : kind === 'dialog' ? [{ dialog: action.accept ? 'accept' : 'dismiss', text: action.text }] : kind === 'reload' ? [{ key: 'Control+r' }] : null;
    if (kind === 'evaluate') { const result = await this.bowser.call('eval', { js: action.script }); return { text: result.content.filter(p => p.type === 'text').map(p => p.text).join('\n') }; }
    if (!actions || kind === 'click' && action.x != null) throw new Error('Bowser uses numbered elements or names. Use its text controls below, or open an isolated Chromium tab for direct pointer control.');
    let upload;
    if (kind === 'upload') { upload = await this.uploads(tab, action); actions[0].paths = upload.paths; }
    let result; try { result = await this.bowser.call('act', { actions, budget: 6000 }); } finally { await upload?.cleanup(); }
    if (kind === 'navigate') tab.url = action.url;
    return { tab: this.metadata(tab), text: result.content.filter(p => p.type === 'text').map(p => p.text).join('\n') };
  }
  async uploads(tab, action) {
    if (action.uploads) {
      if (!Array.isArray(action.uploads) || !action.uploads.length || action.uploads.length > 10) throw new Error('upload 1–10 files, up to 8 MiB total');
      let total = 0; const files = action.uploads.map(file => {
        const name = basename(text(file.name, 200)); if (!name || name === '.' || name === '..') throw new Error('invalid upload filename');
        if (typeof file.data !== 'string' || file.data.length > 12 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error('invalid upload data');
        const bytes = Buffer.from(file.data, 'base64'); total += bytes.length; if (total > 8 * 1024 * 1024) throw new Error('uploads exceed 8 MiB total'); return { name, bytes };
      });
      const folder = join(this.directory, tab.sessionId, 'uploads', id()); mkdirSync(folder, { recursive: true, mode: 0o700 });
      try { const paths = []; for (const [index, file] of files.entries()) { const subdirectory = join(folder, String(index)); mkdirSync(subdirectory, { mode: 0o700 }); const path = join(subdirectory, file.name); await writeFile(path, file.bytes, { mode: 0o600 }); paths.push(path); } return { paths, cleanup: () => rm(folder, { recursive: true, force: true }) }; }
      catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
    }
    if (!Array.isArray(action.files) || !action.files.length || action.files.length > 20) throw new Error('upload 1–20 host files');
    return { paths: action.files.map(f => resolve(text(f, 4000))), cleanup: async () => {} };
  }
  async capture(tab, { fullPage = false, maxWidth = 1280 } = {}) {
    if (tab.engine === 'bowser') { const result = await this.bowser.call('screenshot', { max_size: maxWidth }); const part = result.content.find(p => p.type === 'image'); if (!part) throw new Error('Bowser did not return a screenshot'); return { image: `data:${part.mimeType};base64,${part.data}` }; }
    const bytes = await tab.page.screenshot({ type: 'jpeg', quality: 75, fullPage: !!fullPage, timeout: 10000 });
    if (bytes.length > 3 * 1024 * 1024) throw new Error('screenshot exceeds 3 MiB; capture the viewport instead');
    return { image: `data:image/jpeg;base64,${bytes.toString('base64')}` };
  }
  expireViewers(tab) {
    for (const [viewer, at] of tab.viewers) if (this.now() - at > (tab.viewerLeases?.get(viewer) || 10000)) {
      tab.viewers.delete(viewer); tab.viewerProfiles?.delete(viewer); tab.viewerLeases?.delete(viewer);
      if (tab.control === viewer) { tab.control = null; tab.controlEpoch = (tab.controlEpoch || 0) + 1; }
    }
  }
  previewMode(tab) {
    const modes = [...tab.viewers.keys()].map(viewer => tab.viewerProfiles?.get(viewer) || 'full');
    return ['low', 'balanced', 'full', 'smooth'].find(mode => modes.includes(mode)) || 'text';
  }
  async configurePreview(tab) {
    // Serialize profile changes as well as startup. The slowest active visual
    // viewer sets the shared stream cap; text-only viewers need no images.
    const work = (tab.streamConfig || Promise.resolve()).catch(() => {}).then(async () => {
      const mode = this.previewMode(tab);
      if (tab.previewMode === mode && (tab.engine === 'bowser' || tab.cdp || mode === 'text')) return;
      await tab.capturing?.catch(() => {});
      await this.clearStream(tab);
      if (!tab.viewers.size || this.stopping) return;
      tab.previewMode = mode; tab.frameAt = 0; tab.hash = null;
      if (mode === 'text' || tab.engine === 'bowser') return;
      const profile = BROWSER_PREVIEWS[mode];
      tab.streamStart = (async () => {
        const cdp = await tab.page.context().newCDPSession(tab.page);
        if (!tab.viewers.size || this.stopping) { await cdp.detach(); return; }
        tab.cdp = cdp;
        cdp.on('Page.screencastFrame', event => {
          if (tab.cdp !== cdp) return;
          tab.frame = `data:image/jpeg;base64,${event.data}`; tab.sequence++; this.wake(tab);
          const send = () => cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
          // Right after the owner's input every frame is acknowledged at once.
          const now = Date.now(); if (now < (tab.boostUntil || 0)) { void send(); return; }
          // Chromium can have multiple unacknowledged frames. Pace their
          // acknowledgements together rather than giving each its own clock.
          tab.nextAckAt = Math.max(now, tab.nextAckAt || 0) + profile.interval;
          const ack = setTimeout(() => { tab.acks?.delete(ack); void send(); }, tab.nextAckAt - now);
          ack.unref?.(); (tab.acks ||= new Map()).set(ack, send);
        });
        try { await cdp.send('Page.startScreencast', { format: 'jpeg', quality: profile.quality, maxWidth: profile.maxWidth, maxHeight: profile.maxHeight, everyNthFrame: 1 }); }
        catch (error) { if (tab.cdp === cdp) { tab.cdp = null; tab.frame = null; } await cdp.detach().catch(() => {}); throw error; }
      })().finally(() => { tab.streamStart = null; });
      await tab.streamStart;
    });
    tab.streamConfig = work;
    try { await work; } finally { if (tab.streamConfig === work) tab.streamConfig = null; }
  }
  async frame(sessionId, tabId, { viewer, since = -1, preview = 'full', leaseMs = 10000, waitMs = 0 } = {}) {
    await this.recover(sessionId);
    const tab = this.get(sessionId, tabId); if (!/^[\w-]{1,100}$/.test(viewer || '')) throw new Error('invalid browser viewer');
    if (preview !== 'text' && !Object.hasOwn(BROWSER_PREVIEWS, preview)) throw new Error('invalid browser preview mode');
    integer(leaseMs, 10000, 60000); integer(waitMs, 0, FRAME_WAIT_MS);
    this.expireViewers(tab);
    tab.lastUsed = this.now(); tab.viewers.set(viewer, this.now());
    (tab.viewerProfiles ||= new Map()).set(viewer, preview);
    (tab.viewerLeases ||= new Map()).set(viewer, leaseMs);
    await this.configurePreview(tab);
    const mode = this.previewMode(tab);
    if (preview !== 'text' && mode !== 'text' && tab.engine === 'bowser') {
      if (!tab.capturing && (!tab.frame || this.now() - (tab.frameAt || 0) > 900)) tab.capturing = this.capture(tab, { maxWidth: BROWSER_PREVIEWS[mode].maxWidth }).then(result => { const hash = createHash('sha256').update(result.image).digest('hex'); if (hash !== tab.hash || !tab.frame) { tab.frame = result.image; tab.sequence++; tab.hash = hash; } tab.frameAt = this.now(); }).finally(() => { tab.capturing = null; });
      if (tab.capturing) await tab.capturing;
    }
    // Long poll: hold the request until Chromium paints something new, so the viewer needs no timer.
    let waited;
    if (waitMs && preview !== 'text' && mode !== 'text' && tab.engine === 'chromium' && tab.cdp && (!tab.frame || since === tab.sequence)) {
      const started = Date.now();
      await new Promise(resolve => { const waiter = { resolve, timer: setTimeout(() => { tab.waiters.delete(waiter); resolve(); }, waitMs) }; waiter.timer.unref?.(); (tab.waiters ||= new Set()).add(waiter); });
      waited = Date.now() - started;
    }
    return { tab: this.metadata(tab), sequence: tab.sequence, preview: mode, ...(waited !== undefined ? { waited } : {}), ...(preview !== 'text' && tab.frame && since !== tab.sequence ? { image: tab.frame } : {}) };
  }
  wake(tab) { for (const waiter of tab.waiters || []) { clearTimeout(waiter.timer); waiter.resolve(); } tab.waiters?.clear(); }
  /** The owner just did something: let the page's next paints through without pacing. */
  boost(tab) { tab.boostUntil = Date.now() + 400; for (const [timer, send] of tab.acks || []) { clearTimeout(timer); send(); } tab.acks?.clear(); tab.nextAckAt = 0; }
  async clearStream(tab) { await tab.streamStart?.catch(() => {}); this.wake(tab); for (const timer of tab.acks?.keys() || []) clearTimeout(timer); tab.acks?.clear(); tab.nextAckAt = 0; const cdp = tab.cdp; tab.cdp = null; tab.frame = null; if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); } }
  async unwatch(sessionId, tabId, viewer) { const tab = this.get(sessionId, tabId); tab.viewers.delete(viewer); this.wake(tab); tab.viewerProfiles?.delete(viewer); tab.viewerLeases?.delete(viewer); if (tab.control === viewer) { tab.control = null; tab.controlEpoch = (tab.controlEpoch || 0) + 1; } if (!tab.viewers.size || this.previewMode(tab) === 'text') { await tab.streamConfig?.catch(() => {}); if (!tab.viewers.size || this.previewMode(tab) === 'text') await this.clearStream(tab); } return { ok: true }; }
  async control(sessionId, tabId, viewer, take) { await this.recover(sessionId); const tab = this.get(sessionId, tabId); if (!/^[\w-]{1,100}$/.test(viewer || '')) throw new Error('invalid browser viewer'); if (tab.control && tab.control !== viewer) throw new Error('another viewer has control'); tab.control = take ? viewer : null; tab.controlEpoch = (tab.controlEpoch || 0) + 1; tab.viewers.set(viewer, this.now()); if (!tab.dialog) await (this.serial.get(tab.id) || Promise.resolve()).catch(() => {}); return { tab: this.metadata(tab) }; }
  async pageClosed(sessionId) {
    await this.persistTabs(sessionId);
    if ([...this.tabs.values()].some(t => t.sessionId === sessionId && t.engine === 'chromium')) return;
    const pending = this.contexts.get(sessionId), context = await pending;
    if (!context || this.contexts.get(sessionId) !== pending) return;
    await this.save(sessionId).catch(() => {}); this.contexts.delete(sessionId); await context.close();
    if (!this.contexts.size) await this.shutdownBrowser();
  }
  async save(sessionId) { const context = await this.contexts.get(sessionId); if (!context) return; const folder = join(this.directory, sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 }); const file = join(folder, 'storage.json'); await context.storageState({ path: file, indexedDB: true }); await chmod(file, 0o600); }
  async close(sessionId, tabId) { await this.recover(sessionId); const tab = this.get(sessionId, tabId); if (this.serial.has(tab.id)) throw new Error('wait for the current browser action to finish'); await this.save(sessionId); await this.clearStream(tab); if (tab.page) { tab.explicitClose = true; await tab.page.close(); } else { this.tabs.delete(tab.id); this.bowser.stop(); } await this.persistTabs(sessionId); if (![...this.tabs.values()].some(t => t.sessionId === sessionId && t.engine === 'chromium')) { const context = await this.contexts.get(sessionId); this.contexts.delete(sessionId); await context?.close(); } if (!this.contexts.size) await this.shutdownBrowser(); return { ok: true }; }
  async download(sessionId, tabId, downloadId) { await this.recover(sessionId); const tab = this.get(sessionId, tabId), record = tab.downloads.find(d => d.id === downloadId && d.status === 'ready'); if (!record) throw new Error('download is not ready'); if ((await stat(record.path)).size > 8 * 1024 * 1024) throw new Error('download is over 8 MiB; use its file on the host'); const bytes = await readFile(record.path); if (bytes.length > 8 * 1024 * 1024) throw new Error('download is over 8 MiB; use its file on the host'); return { name: record.name, data: bytes.toString('base64') }; }
  async sweep() {
    for (const tab of this.tabs.values()) {
      this.expireViewers(tab);
      if (tab.cdp && (!tab.viewers.size || this.previewMode(tab) === 'text')) await this.clearStream(tab);
      if (tab.engine === 'bowser' && !tab.viewers.size && this.now() - tab.lastUsed > this.idleMs && !this.serial.has(tab.id)) this.bowser.stop();
    }
    for (const sid of [...this.contexts.keys()]) {
      const tabs = [...this.tabs.values()].filter(t => t.sessionId === sid && t.engine === 'chromium');
      if (!tabs.length || !tabs.every(t => !t.viewers.size && !this.serial.has(t.id) && this.now() - t.lastUsed > this.idleMs)) continue;
      await this.save(sid); await this.persistTabs(sid); const context = await this.contexts.get(sid); this.suspending.add(sid); try { await context?.close(); } finally { this.suspending.delete(sid); } this.contexts.delete(sid); this.recovered.delete(sid);
    }
    if (this.browser && !this.contexts.size) await this.shutdownBrowser();
  }
  async shutdownBrowser() { const browser = this.browser; this.browser = null; await browser?.close(); if (!this.tabs.size) { clearInterval(this.timer); this.timer = null; } }
  async stop() { this.stopping = true; for (const sid of this.contexts.keys()) { await this.save(sid).catch(() => {}); await this.persistTabs(sid).catch(() => {}); } for (const tab of this.tabs.values()) await this.clearStream(tab); this.bowser.stop(); await this.shutdownBrowser(); this.tabs.clear(); this.contexts.clear(); clearInterval(this.timer); this.timer = null; }
}

export function browserNote() { return '[Helm browser: Agents and the owner can use the same browser tabs. Run helm browser open <url> inside this chat (isolated Chromium), or --engine bowser to reuse Bowser Computer Use on machines where installed. helm browser tabs lists your tabs. helm browser look <tab> returns text and numbered elements without screenshots. helm browser act <tab> \'{"kind":"click","ref":1}\' drives them; use kind batch with actions for several steps. Other kinds: navigate/url, type/text/ref, key/key, scroll/dy, hover/ref, select/ref/value, upload/ref/files (host paths), evaluate/script, wait/selector, resize/width/height, dialog/accept, console, network, back, forward, reload. helm browser screenshot <tab> --output <path> captures when visuals matter; close <tab> releases it. Browser tabs run on this machine: localhost reaches your dev servers. Use text views and batch actions to keep context small. The owner can view tabs and take control from Thread details → Browser; wait if they have control. Respect the request when browsing authenticated sites.]'; }
