import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rm, chmod, stat, rename } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { HELM_DIR } from './paths.js';
import { normalizeAction, readOnlyAction, resolveTarget } from './browser-targets.js';
import { BrowserFlows, fillParams, validateFlow } from './browser-flows.js';
import * as browserLogins from './browser-logins.js';

const id = () => randomBytes(8).toString('hex');
const cap = (rows, value, limit = 100) => { rows.push(value); if (rows.length > limit) rows.shift(); };
const text = (value, max = 20000) => { if (typeof value !== 'string' || value.length > max) throw new Error(`expected text up to ${max} characters`); return value; };
const integer = (value, min, max) => { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`expected integer ${min}–${max}`); return value; };
// What a person types in an address bar: a full address, a bare host (local
// dev servers are plain http), or words to search for. Bing, because
// DuckDuckGo and Google turn a headless browser away as a robot.
export const httpUrl = value => {
  const raw = String(value).trim();
  let address = raw;
  if (!raw.includes('://') && !raw.startsWith('about:')) {
    const local = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[\w-]+\.local)(:\d+)?([/?#]|$)/i.test(raw) || /^[\w-]+:\d+([/?#]|$)/.test(raw);
    const host = /^[^\s/?#]+\.[a-z][a-z0-9-]*(:\d+)?([/?#]\S*)?$/i.test(raw) || /^[^\s/?#]+:\d+([/?#]\S*)?$/.test(raw);
    address = local ? `http://${raw}` : host ? `https://${raw}` : `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
  }
  const u = new URL(address); if (!['http:', 'https:'].includes(u.protocol) && u.href !== 'about:blank') throw new Error('use an HTTP or HTTPS browser address'); return u.href;
};
const executable = () => process.env.HELM_CHROMIUM_PATH || process.env.HELM_TEST_CHROMIUM || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
// Pages are drawn at twice their size so the live picture stays sharp on phone
// and laptop screens; it costs about 30 MB per browser and pages still see a
// 1x screen. HELM_BROWSER_SCALE=1 turns it off.
const SCALE = Math.min(3, Math.max(1, Number(process.env.HELM_BROWSER_SCALE) || 2));
const LAUNCH = { headless: true, args: ['--disable-gpu', '--disk-cache-size=33554432', `--force-device-scale-factor=${SCALE}`], timeout: 15000 };
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
  full: { maxWidth: 1920, maxHeight: 1800, quality: 60, interval: 200 },
  smooth: { maxWidth: 1920, maxHeight: 1800, quality: 60, interval: 33 },
});
const FRAME_WAIT_MS = 1500;
const POINTER_WORDS = { click: 'Clicking', hover: 'Pointing at', type: 'Typing into', select: 'Choosing in', upload: 'Uploading into', drag: 'Dragging', scroll: 'Scrolling', point: '' };
const POINTER_CLEARS = ['navigate', 'back', 'forward', 'reload', 'resize'];
const elementName = el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || (['submit', 'button', 'reset'].includes(el.type) ? el.value : '') || '').trim().replace(/\s+/g, ' ').slice(0, 60);

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
  constructor({ directory = join(HELM_DIR, 'browser'), session = () => null, launch, now = Date.now, bowser = new BowserBridge(), idleMs = 10 * 60000, actionTimeoutMs = 45000, logins = browserLogins } = {}) {
    this.logins = logins; this.loginImports = new Map(); this.directory = directory; this.session = session; this.launch = launch; this.now = now; this.bowser = bowser; this.idleMs = idleMs; this.actionTimeoutMs = actionTimeoutMs; this.tabs = new Map(); this.contexts = new Map(); this.serial = new Map(); this.recovered = new Map(); this.suspending = new Set(); this.browser = null;
    this.flows = new BrowserFlows(directory);
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
  async context(sessionId, loginSeed) {
    this.owner(sessionId);
    if (this.contexts.has(sessionId)) return this.contexts.get(sessionId);
    const browser = await this.start();
    // Concurrent open requests must not create two contexts for one thread.
    if (this.contexts.has(sessionId)) return this.contexts.get(sessionId);
    const pending = (async () => {
      let storageState, seed, hasStorage = true;
      try { storageState = JSON.parse(await readFile(join(this.directory, sessionId, 'storage.json'), 'utf8')); } catch (error) { hasStorage = error.code !== 'ENOENT'; }
      if (!hasStorage) {
        seed = loginSeed;
        if (!seed) { const choice = await this.loginDefault(sessionId); if (choice.profileKey) seed = await this.logins.readLogins(choice.profileKey); }
        if (seed) { if (!seed.cookies.length && seed.failed) throw new Error(seed.warnings?.[0] || 'Could not copy the default browser logins.'); storageState = { cookies: seed.cookies, origins: [] }; }
      }
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...(storageState ? { storageState } : {}) });
      context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
      context.on('page', page => this.register(sessionId, page));
      try { if (seed) await this.saveContext(sessionId, context); } catch (error) { await context.close(); throw error; }
      return context;
    })();
    this.contexts.set(sessionId, pending);
    try { return await pending; } catch (error) { this.contexts.delete(sessionId); throw error; }
  }
  async profiles(sessionId) { this.owner(sessionId); return { profiles: await this.logins.listProfiles() }; }
  async loginDefault(sessionId, profileKey) {
    this.owner(sessionId); const file = join(this.directory, 'logins.json');
    if (profileKey === null) { await rm(file, { force: true }); return { profileKey: null }; }
    if (profileKey !== undefined) {
      const profile = await this.logins.resolveProfile(profileKey); if (!profile.readable) throw new Error(profile.reason);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
      await this.writePrivate(file, { profileKey: profile.key }); return { profileKey: profile.key };
    }
    try { const choice = JSON.parse(await readFile(file, 'utf8')); return { profileKey: typeof choice.profileKey === 'string' ? choice.profileKey : null }; } catch { return { profileKey: null }; }
  }
  async importLogins(sessionId, profileKey) {
    this.owner(sessionId);
    const pending = (this.loginImports.get(sessionId) || Promise.resolve()).catch(() => {}).then(async () => {
      const result = await this.logins.readLogins(profileKey, { refresh: true });
      if (!result.cookies.length && result.failed) throw new Error(result.warnings?.[0] || 'Could not copy logins from this profile.');
      const context = await this.context(sessionId, result); try { await context.addCookies(result.cookies); } catch { throw new Error('Could not copy these cookies into Chromium. Update Chromium and try again.'); } await this.save(sessionId);
      return { cookies: result.cookies.length, sites: result.sites, failed: result.failed, profile: result.profile };
    });
    this.loginImports.set(sessionId, pending);
    try { return await pending; } finally { if (this.loginImports.get(sessionId) === pending) this.loginImports.delete(sessionId); }
  }
  async writePrivate(file, value) {
    const partial = `${file}.${id()}.tmp`;
    try { await writeFile(partial, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(partial, file); }
    finally { await rm(partial, { force: true }); }
  }
  async saveContext(sessionId, context) {
    const folder = join(this.directory, sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700); await chmod(folder, 0o700);
    await this.writePrivate(join(folder, 'storage.json'), await context.storageState({ indexedDB: true }));
  }
  register(sessionId, page) {
    const existing = [...this.tabs.values()].find(t => t.page === page); if (existing) return existing;
    const tab = { id: id(), sessionId, engine: 'chromium', page, title: '', console: [], network: [], downloads: [], lastUsed: this.now(), viewers: new Map(), sequence: 0, frame: null, control: null, dialog: null };
    this.tabs.set(tab.id, tab);
    tab.fetching = new Set(); tab.quietAt = 0;
    const changed = () => { tab.quietAt = Date.now(); for (const wake of tab.settleWaiters || []) wake(); };
    page.on('request', request => { if (['fetch', 'xhr'].includes(request.resourceType())) { tab.fetching.add(request); changed(); } });
    const finished = request => { if (tab.fetching.delete(request)) changed(); };
    page.on('requestfinished', finished); page.on('requestfailed', finished);
    page.on('close', () => {
      this.tabs.delete(tab.id); void this.clearStream(tab);
      if (this.suspending.has(sessionId)) return;
      if (tab.explicitClose) { if (!this.stopping) this.discardDownloads(tab); return; }
      // A tab nobody closed: Chromium may be going down with Helm, in either
      // order. It stays in the saved list until the browser is seen alive
      // without it, so a restart forgets nothing.
      let row; try { row = this.metadata(tab); } catch { return; }
      (this.orphans ||= new Map()).set(tab.id, { sessionId, row, tab });
      if (!this.stopping) void this.pageClosed(sessionId, tab).catch(() => {});
    });
    page.on('console', msg => cap(tab.console, { level: msg.type(), text: msg.text().slice(0, 4000), at: this.now() }));
    page.on('pageerror', error => cap(tab.console, { level: 'error', text: error.message.slice(0, 4000), at: this.now() }));
    page.on('response', response => cap(tab.network, { url: response.url().slice(0, 2000), method: response.request().method(), status: response.status() }));
    page.on('requestfailed', request => cap(tab.network, { url: request.url().slice(0, 2000), method: request.method(), error: request.failure()?.errorText }));
    page.on('domcontentloaded', () => { void page.title().then(title => { tab.title = title; }).catch(() => {}); });
    // The viewer shows a loading bar from the click to the page's load, like a real browser.
    // A download or an empty answer never loads, so the bar gives up after 20 seconds.
    const loading = value => { clearTimeout(tab.loadingTimer); if (value) { tab.loadingTimer = setTimeout(() => loading(false), 20000); tab.loadingTimer.unref?.(); } if (tab.loading !== value) { tab.loading = value; this.changed(tab); } };
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loading(true); });
    page.on('requestfailed', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loading(false); });
    page.on('load', () => loading(false));
    page.on('download', () => loading(false)); page.on('close', () => clearTimeout(tab.loadingTimer));
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
  metadata(tab) { return { id: tab.id, engine: tab.engine, url: tab.page?.url() || tab.url || 'about:blank', title: tab.title, viewport: tab.page?.viewportSize() || { width: 1280, height: 800 }, control: tab.control, controlEpoch: tab.controlEpoch || 0, dialog: tab.dialog ? { type: tab.dialog.type(), message: tab.dialog.message().slice(0, 2000) } : null, downloads: tab.downloads.map(({ path, ...d }) => d), pointer: this.pointer(tab), fit: tab.fit !== false, loading: !!tab.loading }; }
  pointer(tab) { const p = tab.pointer; return p && this.now() - p.at < (p.by === 'guide' ? 60000 : 4000) ? p : null; }
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
      for (const [key, orphan] of this.orphans || []) if (orphan.sessionId === sessionId) this.orphans.delete(key);
      let rows; try { rows = JSON.parse(await readFile(join(this.directory, sessionId, 'tabs.json'), 'utf8')); } catch { return; }
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(0, 24)) {
        if (row.engine !== 'chromium' || !/^[a-f0-9]{16}$/.test(row.id)) continue;
        if (this.tabs.has(row.id)) continue;
        const context = await this.context(sessionId), page = await context.newPage(), tab = this.register(sessionId, page);
        this.tabs.delete(tab.id); tab.id = row.id; tab.title = row.title || ''; this.tabs.set(tab.id, tab);
        if (row.fit === false) tab.fit = false;
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
  async persistTabs(sessionId) { clearTimeout(this.persistTimers?.get(sessionId)); this.persistTimers?.delete(sessionId); const folder = join(this.directory, sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 }); await writeFile(join(folder, 'tabs.json'), JSON.stringify([...[...this.tabs.values()].filter(t => t.sessionId === sessionId).map(t => this.metadata(t)), ...[...this.orphans?.values() || []].filter(o => o.sessionId === sessionId && !this.tabs.has(o.row.id)).map(o => o.row)]), { mode: 0o600 }); }
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
    try { if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' }); await this.settle(tab); tab.title = await page.title(); await this.persistTabs(sessionId); return { tab: this.metadata(tab), ...(await this.look(tab)) }; }
    catch (error) { await page.close(); throw error; }
  }
  get(sessionId, tabId) { this.owner(sessionId); const tab = this.tabs.get(tabId); if (!tab || tab.sessionId !== sessionId) throw new Error('browser tab not found in this thread'); return tab; }
  async run(sessionId, tabId, action, actor = 'agent', expectedEpoch) {
    action = normalizeAction(action);
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
        if (!readOnlyAction(action)) throw new Error('this thread is read-only; browser actions that change the page are disabled');
      }
      this.checkControl(tab, action, actor, epoch);
      tab.lastUsed = tab.actedAt = this.now(); const owned = actor !== 'agent' && tab.engine === 'chromium'; if (owned) this.boost(tab);
      let result;
      try { result = await this.perform(tab, action, actor, epoch); }
      catch (error) { if (!error.candidates && !error.check) throw error; result = { error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.check ? { check: error.check } : {}), ...(await this.look(tab)) }; }
      if (owned) this.boost(tab);
      if (!['look', 'console', 'network', 'screenshot', 'point'].includes(action?.kind)) { if (['navigate', 'back', 'forward', 'reload', 'batch'].includes(action?.kind)) await this.persistTabs(sessionId); else this.persistSoon(sessionId); }
      return result;
    });
    const job = Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { if (started && epoch === (tab.controlEpoch || 0)) tab.controlEpoch = epoch + 1; reject(new Error('Browser action timed out; inspect the page before retrying.')); }, this.actionTimeoutMs); timer.unref?.(); })]);
    this.serial.set(tab.id, job); void job.finally(() => { clearTimeout(timer); if (this.serial.get(tab.id) === job) this.serial.delete(tab.id); }).catch(() => {}); return job;
  }
  async look(tab, budget = 6000) {
    integer(budget, 0, 20000);
    if (tab.engine === 'bowser') { const result = await this.bowser.call('look', { budget }); return { text: result.content.filter(p => p.type === 'text').map(p => p.text).join('\n') }; }
    const result = await tab.page.evaluate(limit => {
      const visible = el => { const r = el.getBoundingClientRect(), s = el.ownerDocument.defaultView.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[inert]'); };
      const selector = 'a[href],button,input:not([type=hidden]),textarea,select,option,summary,label[for],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menu],[role=menuitem],[role=option],[role=combobox],[role=switch],[role=textbox],[role=searchbox],[contenteditable=true],[onclick]';
      const elements = [], roots = [], seen = new Set();
      const visit = (root, inView = true) => {
        if (seen.has(root)) return; seen.add(root); roots.push(root);
        for (const el of root.querySelectorAll('*')) {
          if (elements.length < 300 && (el.matches(selector) || typeof el.onclick === 'function') && visible(el)) elements.push({ el, inView });
          if (el.shadowRoot && visible(el)) visit(el.shadowRoot, inView);
          if (el.tagName === 'IFRAME' && visible(el)) { try { if (el.contentDocument) { const r = el.getBoundingClientRect(), w = el.ownerDocument.defaultView; visit(el.contentDocument, inView && r.bottom > 0 && r.right > 0 && r.top < w.innerHeight && r.left < w.innerWidth); } } catch {} }
        }
      };
      visit(document);
      window.__helmBrowserElements = elements.map(({ el }) => el);
      const prose = []; let left = limit;
      for (const root of roots) { if (!left) break; const content = (root.body?.innerText || (root.nodeType === 11 ? [...root.childNodes].map(node => node.nodeType === 3 ? node.textContent : node.nodeType === 1 && visible(node) ? node.innerText || '' : '').join('\n') : '') || '').slice(0, left); prose.push(content); left -= content.length; }
      return { title: document.title, url: location.href, text: prose.join('\n').slice(0, limit), elements: elements.map(({ el, inView }, i) => {
        const tag = el.tagName.toLowerCase(), type = tag === 'input' ? el.type : 'text', r = el.getBoundingClientRect(), w = el.ownerDocument.defaultView;
        const role = el.getAttribute('role') || (tag === 'input' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', file: 'file', search: 'searchbox' }[type] || 'textbox') : tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' || el.isContentEditable ? 'textbox' : tag);
        const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => el.getRootNode().getElementById?.(id)?.textContent || '').join(' ').trim();
        const name = (el.getAttribute('aria-label') || labelled || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || (['submit', 'button', 'reset'].includes(type) ? el.value : '') || '').trim().slice(0, 180);
        const state = {};
        if (el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') state.disabled = true;
        if (['checkbox', 'radio', 'switch'].includes(role)) state.checked = el.getAttribute('aria-checked') === 'mixed' ? 'mixed' : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : !!el.checked;
        if (el.hasAttribute('aria-expanded') || tag === 'summary') state.expanded = tag === 'summary' ? !!el.parentElement?.open : el.getAttribute('aria-expanded') === 'true';
        if (el.hasAttribute('aria-selected')) state.selected = el.getAttribute('aria-selected') === 'true';
        if (el.hasAttribute('aria-current')) state.current = el.getAttribute('aria-current');
        if (['input', 'textarea', 'select'].includes(tag) && type !== 'password' && type !== 'file') state.value = String(el.value ?? '').slice(0, 180);
        return { ref: i + 1, role, name, ...state, inViewport: inView && r.bottom > 0 && r.right > 0 && r.top < w.innerHeight && r.left < w.innerWidth };
      }) };
    }, budget);
    tab.title = result.title;
    return { text: `${result.title}\n${result.url}\n${result.text}\n\n${result.elements.map(e => `[${e.ref}] ${e.role} ${JSON.stringify(e.name)}${e.disabled ? ' disabled' : ''}${e.checked != null ? ` checked=${e.checked}` : ''}${e.expanded != null ? ` expanded=${e.expanded}` : ''}${e.selected != null ? ` selected=${e.selected}` : ''}${e.current ? ` current=${e.current}` : ''}${e.value != null ? ` value=${JSON.stringify(e.value)}` : ''}${!e.inViewport ? ' offscreen' : ''}`).join('\n')}`, elements: result.elements };
  }
  async target(tab, action) {
    if (action.ref != null) {
      integer(action.ref, 1, 300); const handle = await tab.page.evaluateHandle(ref => window.__helmBrowserElements?.[ref - 1], action.ref), element = handle.asElement();
      if (!element) { await handle.dispose(); throw new Error('element reference expired; look at the page again'); }
      const frame = await element.ownerFrame();
      if (frame && frame !== tab.page.mainFrame()) { try { return (await frame.evaluateHandle(el => el, element)).asElement(); } finally { await handle.dispose(); } }
      return element;
    }
    if (action.selector) return tab.page.locator(text(action.selector, 2000)).first();
    if (action.role) return tab.page.getByRole(text(action.role, 40), { name: text(action.name, 500), exact: true });
    if (action.name) return tab.page.getByText(text(action.name, 500), { exact: true });
    if (action.target != null) {
      if (typeof action.target === 'number' || typeof action.target === 'string' && /^\d+$/.test(action.target.trim())) return this.target(tab, { ref: Number(action.target) });
      const { elements } = await this.look(tab, 0), chosen = resolveTarget(text(action.target, 500), elements, action.kind);
      return this.target(tab, { ref: chosen.ref });
    }
    throw new Error('choose a target, element ref, selector, role/name, or x/y coordinates');
  }
  async settle(tab) {
    if (tab.engine !== 'chromium' || !tab.fetching || tab.dialog) return;
    const deadline = Date.now() + 3000;
    await tab.page.waitForLoadState('load', { timeout: 3000 }).catch(() => {});
    if (tab.dialog || Date.now() >= deadline) return;
    await new Promise(resolve => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        const remaining = deadline - Date.now(), quiet = 150 - (Date.now() - tab.quietAt);
        if (tab.dialog || remaining <= 0 || !tab.fetching.size && quiet <= 0) { tab.settleWaiters.delete(wake); resolve(); return; }
        timer = setTimeout(wake, Math.min(remaining, tab.fetching.size ? remaining : Math.max(1, quiet)));
      };
      (tab.settleWaiters ||= new Set()).add(wake); wake();
    });
  }
  async listFlows(sessionId) { this.owner(sessionId); return this.flows.list(); }
  async runFlow(sessionId, tabId, name, values) { this.owner(sessionId); const flow = await this.flows.load(name); return this.run(sessionId, tabId, { actions: flow.actions, with: values }); }
  checkControl(tab, action, actor, epoch = tab.controlEpoch || 0) {
    if (['look', 'console', 'network', 'screenshot', 'point', 'check', 'fit'].includes(action?.kind)) return;
    if (epoch !== (tab.controlEpoch || 0)) throw new Error('Browser control changed; inspect the tab before continuing.');
    if (actor !== 'agent' && tab.control !== actor) throw new Error('Take control before changing this browser tab.');
    if (tab.control && tab.control !== actor) throw new Error('You have control of this tab. Release control to let the agent continue.');
  }
  async perform(tab, action, actor = 'agent', epoch = tab.controlEpoch || 0, inBatch = false) {
    action = normalizeAction(action);
    const kind = action.kind;
    if (kind === 'look') return { tab: this.metadata(tab), ...(await this.look(tab, action.budget ?? 6000)) };
    if (kind === 'console') return { entries: tab.console };
    if (kind === 'network') return { entries: tab.network };
    if (kind === 'screenshot') return this.capture(tab, action);
    if (kind === 'batch') {
      if (!Array.isArray(action.actions) || action.actions.length > 40 || action.actions.some(a => normalizeAction(a).kind === 'batch')) throw new Error('a batch holds at most 40 nonnested actions');
      integer(action.budget ?? 6000, 0, 20000);
      if (action.save_as != null) validateFlow(action.actions, action.save_as, action.note);
      const actions = fillParams(action.actions, action.with ?? {}), results = [];
      for (const raw of actions) { try { const step = normalizeAction(raw); this.checkControl(tab, step, actor, epoch); results.push(await this.perform(tab, step, actor, epoch, true)); } catch (error) { return { results, failedAt: results.length, error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.check ? { check: error.check } : {}), ...(await this.look(tab, action.budget ?? 6000)) }; } }
      const result = { results, ...(await this.look(tab, action.budget ?? 6000)) };
      if (action.save_as != null) { try { if (await this.flows.save(action.save_as, action.actions, action.note, result)) result.saved = action.save_as; } catch (error) { result.saveError = `Steps succeeded, but the flow could not be saved: ${error.message}`; } }
      return result;
    }
    if (kind === 'check') {
      if (tab.engine === 'bowser') throw new Error('deterministic checks need a Chromium tab');
      if (action.expect != null && typeof action.expect !== 'boolean') throw new Error('check expect must be true or false');
      const wanted = text(action.check, 2000);
      await this.settle(tab);
      const view = await this.look(tab, 20000);
      let found = await tab.page.evaluate(value => {
        const visible = el => { const r = el.getBoundingClientRect(), s = el.ownerDocument.defaultView.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[inert]'); };
        const visit = root => {
          if ((root.body?.innerText || (root.nodeType === 11 ? [...root.childNodes].map(node => node.nodeType === 3 ? node.textContent : node.nodeType === 1 && visible(node) ? node.innerText || '' : '').join('\n') : '') || '').includes(value)) return true;
          for (const el of root.querySelectorAll('*')) { if (el.shadowRoot && visible(el) && visit(el.shadowRoot)) return true; if (el.tagName === 'IFRAME' && visible(el)) { try { if (el.contentDocument && visit(el.contentDocument)) return true; } catch {} } }
          return false;
        };
        return visit(document);
      }, wanted);
      if (!found) { try { resolveTarget(wanted, view.elements); found = true; } catch (error) { if (error.candidates?.[0]?.score) throw error; } }
      const check = { check: wanted, found, expect: action.expect ?? true, pass: found === (action.expect ?? true) };
      if (!check.pass) { const error = new Error(`check failed: ${JSON.stringify(wanted)} expected ${check.expect}`); error.check = check; throw error; }
      return { ...check, ...(!inBatch ? view : {}) };
    }
    if (kind === 'fit') return this.fit(tab, action, actor);
    if (kind === 'point' && tab.engine === 'bowser') throw new Error('pointing works in isolated Chromium tabs, not Bowser');
    if (tab.engine === 'bowser') return this.bowserAction(tab, action);
    const page = tab.page;
    await this.aim(tab, action, actor);
    if (kind === 'point') return { tab: this.metadata(tab) };
    if (kind === 'navigate') await page.goto(httpUrl(action.url), { waitUntil: 'domcontentloaded' });
    else if (kind === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else if (kind === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
    else if (kind === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
    else if (kind === 'click' || kind === 'hover') {
      if (action.x != null) { const { width, height } = page.viewportSize(); integer(action.x, 0, width); integer(action.y, 0, height); kind === 'click' ? await page.mouse.click(action.x, action.y, { button: ['left', 'right', 'middle'].includes(action.button) ? action.button : 'left', clickCount: action.double ? 2 : 1 }) : await page.mouse.move(action.x, action.y); }
      else { const target = await this.target(tab, action); try { kind === 'click' ? await target.click({ button: action.button || 'left', clickCount: action.double ? 2 : 1 }) : await target.hover(); } finally { if (target.dispose) await target.dispose(); } }
    } else if (kind === 'drag') { const { width, height } = page.viewportSize(); for (const field of ['fromX', 'toX']) integer(action[field], 0, width); for (const field of ['fromY', 'toY']) integer(action[field], 0, height); await page.mouse.move(action.fromX, action.fromY); await page.mouse.down(); try { await page.mouse.move(action.toX, action.toY, { steps: 6 }); } finally { await page.mouse.up(); } }
    else if (kind === 'type') { const value = text(action.text); if (action.ref || action.selector || action.name || action.role || action.target != null) { const target = await this.target(tab, action); try { if (action.append) { await target.focus(); await page.keyboard.insertText(value); } else await target.fill(value); if (action.enter) await target.press('Enter'); } finally { if (target.dispose) await target.dispose(); } } else { if (action.clear) { await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); } await page.keyboard.insertText(value); if (action.enter) await page.keyboard.press('Enter'); } }
    else if (kind === 'key') await page.keyboard.press(text(action.key, 100));
    else if (kind === 'clipboard') {
      const origin = new URL(page.url()).origin;
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      try { return { text: await page.evaluate(() => navigator.clipboard.readText()) }; }
      finally { await page.context().clearPermissions(); }
    }
    else if (kind === 'scroll') await page.mouse.wheel(integer(action.dx ?? 0, -20000, 20000), integer(action.direction ? Math.round(page.viewportSize().height * (action.pages ?? 1) * (action.direction === 'up' ? -1 : 1)) : action.dy ?? 500, -20000, 20000));
    else if (kind === 'select') { const target = await this.target(tab, action); try { await target.selectOption(action.option != null ? { label: text(action.option, 1000) } : action.values || text(action.value, 1000)); } finally { if (target.dispose) await target.dispose(); } }
    else if (kind === 'upload') {
      const files = await this.uploads(tab, action);
      let target; try { target = await this.target(tab, action); await target.setInputFiles(files.paths); } finally { if (target?.dispose) await target.dispose(); await files.cleanup(); }
    } else if (kind === 'evaluate') { const value = await page.evaluate(text(action.script, 20000)); await this.settle(tab); return { value, ...(!inBatch ? await this.look(tab) : {}) }; }
    else if (kind === 'wait') { integer(action.timeout ?? 10000, 1, 30000); if (action.selector) await page.locator(text(action.selector, 2000)).waitFor({ state: action.state || 'visible', timeout: action.timeout ?? 10000 }); else await page.getByText(text(action.text, 2000)).first().waitFor({ timeout: action.timeout ?? 10000 }); }
    else if (kind === 'resize') { tab.fit = false; await page.setViewportSize({ width: integer(action.width, 240, 1920), height: integer(action.height, 200, 1200) }); await this.clearStream(tab); }
    else if (kind === 'dialog') { if (!tab.dialog) throw new Error('no dialog is open'); const dialog = tab.dialog; tab.dialog = null; action.accept ? await dialog.accept(action.text ?? '') : await dialog.dismiss(); }
    else throw new Error(`unknown browser action: ${kind}`);
    // The owner watches the live page; only agent actions wait for it to settle and get it back as text.
    const agent = actor === 'agent';
    if (agent && ['navigate', 'back', 'forward', 'reload', 'click', 'type', 'key', 'select', 'hover', 'scroll', 'drag', 'resize', 'upload', 'dialog', 'wait'].includes(kind)) await this.settle(tab);
    // Only actions that can change the title ask for it; page loads update it as they finish.
    if (!['hover', 'scroll', 'type', 'resize'].includes(kind)) tab.title = await page.title().catch(() => tab.title);
    return { tab: this.metadata(tab), ...(agent && !inBatch ? await this.look(tab) : {}) };
  }
  /**
   * A viewer sizes the page to its panel, or picks a fixed phone or desktop
   * size. It only changes the view, so it needs no control and works in
   * read-only chats; it still waits its turn behind agent actions. An
   * automatic fit never undoes a fixed size, and while someone has control
   * only their panel sets the size; otherwise the last panel change wins.
   */
  async fit(tab, action, actor) {
    if (actor === 'agent') throw new Error('fit is for viewers; agents use resize');
    const size = action.mode === 'phone' ? { width: 390, height: 844 } : action.mode === 'desktop' ? { width: 1280, height: 800 } : action.mode === 'panel' ? { width: integer(action.width, 240, 1920), height: integer(action.height, 200, 1200) } : null;
    if (!size) throw new Error('fit mode is panel, phone or desktop');
    if (action.auto && (tab.fit === false || tab.control && tab.control !== actor)) return { tab: this.metadata(tab) };
    tab.fit = action.mode === 'panel';
    const now = tab.page?.viewportSize();
    if (tab.engine !== 'chromium' || tab.dialog || now?.width === size.width && now?.height === size.height) return { tab: this.metadata(tab) };
    await tab.page.setViewportSize(size); await this.clearStream(tab);
    // The page reflowed: a guide follows its element, an agent pointer is stale.
    const guide = tab.pointer?.by === 'guide' && tab.guide, at = tab.pointer?.at; tab.pointer = null;
    if (guide) { try { await this.aim(tab, guide, 'agent'); if (tab.pointer) tab.pointer.at = at; } catch { tab.pointer = null; } }
    this.changed(tab);
    return { tab: this.metadata(tab) };
  }
  /** Where the agent is about to act, for a viewer's pointer. Free when nobody is watching; point always records. */
  async aim(tab, action, actor) {
    const kind = action.kind;
    if (POINTER_CLEARS.includes(kind) || actor !== 'agent' && tab.pointer?.by === 'guide' && ['click', 'drag', 'type', 'key', 'select', 'upload'].includes(kind)) { if (tab.pointer) { tab.pointer = null; this.changed(tab); } return; }
    if (actor !== 'agent' || !Object.hasOwn(POINTER_WORDS, kind) || kind !== 'point' && (!tab.viewers?.size || this.previewMode(tab) === 'text')) return;
    const { width, height } = tab.page.viewportSize() || { width: 1280, height: 800 };
    let x = kind === 'drag' ? action.toX : action.x, y = kind === 'drag' ? action.toY : action.y, box, name = '';
    if (kind === 'scroll' && x == null) { x = Math.round(width / 2); y = Math.round(height / 2); }
    else if (x == null && !(kind === 'type' && !(action.ref || action.selector || action.name || action.role || action.target != null))) {
      let target; try {
        target = await this.target(tab, action);
        if (!['point', 'upload'].includes(kind)) await target.scrollIntoViewIfNeeded({ timeout: 500 });
        const timeout = kind === 'point' ? 5000 : 500, [found, label] = await Promise.all([target.boundingBox({ timeout }), target.evaluate(elementName, undefined, { timeout }).catch(() => '')]);
        if (found) { box = { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) }; x = Math.round(found.x + found.width / 2); y = Math.round(found.y + found.height / 2); name = label; }
      } catch (error) { if (kind === 'point') throw error; } finally { if (target?.dispose) await target.dispose(); }
    }
    if (kind === 'point') tab.guide = action.x == null ? action : null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) { if (kind === 'point') throw new Error('that spot is not on screen; scroll to it first'); return; }
    const note = kind === 'point' && action.note != null ? text(action.note, 300).trim() : '';
    const verb = kind === 'click' ? action.button === 'right' ? 'Right-clicking' : action.double ? 'Double-clicking' : 'Clicking' : kind === 'scroll' ? (action.dy ?? 500) < 0 ? 'Scrolling up' : 'Scrolling down' : POINTER_WORDS[kind];
    tab.pointerSeq = (tab.pointerSeq || 0) + 1;
    tab.pointer = { x, y, ...(box ? { box } : {}), action: kind, label: [verb, name && `“${name}”`].filter(Boolean).join(' '), by: kind === 'point' ? 'guide' : 'agent', ...(note ? { note } : {}), seq: tab.pointerSeq, at: this.now() };
    this.changed(tab);
    if (kind !== 'point') await new Promise(done => setTimeout(done, 120));
  }
  async bowserAction(tab, action) {
    const kind = action.kind, target = action.ref || action.name || action.selector || action.target;
    if (kind === 'bowser') { if (!['act', 'look', 'eval', 'flows', 'tabs', 'screenshot'].includes(action.tool)) throw new Error('unknown Bowser tool'); return this.bowser.call(action.tool, action.args || {}); }
    const actions = kind === 'navigate' ? [{ goto: httpUrl(action.url) }] : kind === 'click' ? [{ click: target, double: !!action.double, button: action.button || 'left' }]
      : kind === 'hover' ? [{ hover: target }] : kind === 'type' ? [{ type: text(action.text), ...(target ? { into: target, clear: !action.append } : {}), ...(action.enter ? { enter: true } : {}) }] : kind === 'key' ? [{ key: text(action.key, 100) }]
      : kind === 'scroll' ? [{ scroll: action.direction || ((action.dy || 0) < 0 ? 'up' : 'down'), pages: action.pages ?? Math.max(0.1, Math.abs(action.dy || 500) / 800) }] : kind === 'select' ? [{ select: target, option: action.option ?? action.value }]
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
    const bytes = await tab.page.screenshot({ type: 'jpeg', quality: 75, fullPage: !!fullPage, scale: 'css', timeout: 10000 });
    if (bytes.length > 3 * 1024 * 1024) throw new Error('screenshot exceeds 3 MiB; capture the viewport instead');
    return { image: `data:image/jpeg;base64,${bytes.toString('base64')}` };
  }
  expireViewers(tab) {
    for (const [viewer, at] of tab.viewers) if (this.now() - at > (tab.viewerLeases?.get(viewer) || 10000)) {
      tab.viewers.delete(viewer); tab.viewerProfiles?.delete(viewer); tab.viewerLeases?.delete(viewer); tab.viewerRevisions?.delete(viewer);
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
    if (waitMs && preview !== 'text' && mode !== 'text' && tab.engine === 'chromium' && tab.cdp && (!tab.frame || since === tab.sequence) && (tab.viewerRevisions?.get(viewer) ?? tab.revision ?? 0) === (tab.revision || 0)) {
      const started = Date.now();
      await new Promise(resolve => { const waiter = { resolve, timer: setTimeout(() => { tab.waiters.delete(waiter); resolve(); }, waitMs) }; waiter.timer.unref?.(); (tab.waiters ||= new Set()).add(waiter); });
      waited = Date.now() - started;
    }
    (tab.viewerRevisions ||= new Map()).set(viewer, tab.revision || 0);
    return { tab: this.metadata(tab), sequence: tab.sequence, preview: mode, ...(waited !== undefined ? { waited } : {}), ...(preview !== 'text' && tab.frame && since !== tab.sequence ? { image: tab.frame } : {}) };
  }
  /** Something a viewer shows changed without a new paint: answer waiting and next frame requests at once. */
  changed(tab) { tab.revision = (tab.revision || 0) + 1; this.wake(tab); }
  wake(tab) { for (const waiter of tab.waiters || []) { clearTimeout(waiter.timer); waiter.resolve(); } tab.waiters?.clear(); }
  /** The owner just did something: let the page's next paints through without pacing. */
  boost(tab) { tab.boostUntil = Date.now() + 400; for (const [timer, send] of tab.acks || []) { clearTimeout(timer); send(); } tab.acks?.clear(); tab.nextAckAt = 0; }
  async clearStream(tab) { await tab.streamStart?.catch(() => {}); this.wake(tab); for (const timer of tab.acks?.keys() || []) clearTimeout(timer); tab.acks?.clear(); tab.nextAckAt = 0; const cdp = tab.cdp; tab.cdp = null; tab.frame = null; if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); } }
  async unwatch(sessionId, tabId, viewer) { const tab = this.get(sessionId, tabId); tab.viewers.delete(viewer); this.wake(tab); tab.viewerProfiles?.delete(viewer); tab.viewerLeases?.delete(viewer); tab.viewerRevisions?.delete(viewer); if (tab.control === viewer) { tab.control = null; tab.controlEpoch = (tab.controlEpoch || 0) + 1; } if (!tab.viewers.size || this.previewMode(tab) === 'text') { await tab.streamConfig?.catch(() => {}); if (!tab.viewers.size || this.previewMode(tab) === 'text') await this.clearStream(tab); } return { ok: true }; }
  async control(sessionId, tabId, viewer, take) { await this.recover(sessionId); const tab = this.get(sessionId, tabId); if (!/^[\w-]{1,100}$/.test(viewer || '')) throw new Error('invalid browser viewer'); if (tab.control && tab.control !== viewer) throw new Error('another viewer has control'); tab.control = take ? viewer : null; tab.controlEpoch = (tab.controlEpoch || 0) + 1; tab.viewers.set(viewer, this.now()); if (!tab.dialog) await (this.serial.get(tab.id) || Promise.resolve()).catch(() => {}); return { tab: this.metadata(tab) }; }
  async pageClosed(sessionId, tab) {
    await new Promise(resolve => { const timer = setTimeout(resolve, this.closeGraceMs ?? 1500); timer.unref?.(); });
    if (this.stopping || !this.browser || this.browser.isConnected?.() === false || !this.orphans?.has(tab.id)) return;
    // The browser is still up: the page closed itself (window.close).
    this.orphans.delete(tab.id); this.discardDownloads(tab);
    await this.persistTabs(sessionId);
    if ([...this.tabs.values()].some(t => t.sessionId === sessionId && t.engine === 'chromium')) return;
    const pending = this.contexts.get(sessionId), context = await pending;
    if (!context || this.contexts.get(sessionId) !== pending) return;
    await this.save(sessionId).catch(() => {}); this.contexts.delete(sessionId); await context.close();
    if (!this.contexts.size) await this.shutdownBrowser();
  }
  async save(sessionId) { const context = await this.contexts.get(sessionId); if (context) { (this.savedAt ||= new Map()).set(sessionId, this.now()); await this.saveContext(sessionId, context); } }
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
      // Sign-ins made since the last save survive Chromium dying with Helm.
      const savedAt = this.savedAt?.get(sid) || 0;
      if (tabs.some(t => t.actedAt > savedAt) && this.now() - savedAt > 15000) await this.save(sid).catch(() => {});
      if (!tabs.length || !tabs.every(t => !t.viewers.size && !this.serial.has(t.id) && this.now() - t.lastUsed > this.idleMs)) continue;
      await this.save(sid); await this.persistTabs(sid); const context = await this.contexts.get(sid); this.suspending.add(sid); try { await context?.close(); } finally { this.suspending.delete(sid); } this.contexts.delete(sid); this.recovered.delete(sid);
    }
    if (this.browser && !this.contexts.size) await this.shutdownBrowser();
  }
  async shutdownBrowser() { const browser = this.browser; this.browser = null; await browser?.close(); if (!this.tabs.size) { clearInterval(this.timer); this.timer = null; } }
  async stop() { this.stopping = true; for (const sid of this.contexts.keys()) { await this.save(sid).catch(() => {}); await this.persistTabs(sid).catch(() => {}); } for (const tab of this.tabs.values()) await this.clearStream(tab); this.bowser.stop(); await this.shutdownBrowser(); this.tabs.clear(); this.contexts.clear(); clearInterval(this.timer); this.timer = null; }
}

export function browserNote() { return '[Helm browser: Agents and the owner can use the same browser tabs. Run helm browser open <url> inside this chat (isolated Chromium), or --engine bowser to reuse Bowser Computer Use on machines where installed. helm browser tabs lists your tabs. helm browser look <tab> returns text and numbered elements without screenshots. Plan the whole task as one batch; prefer direct URLs and plain targets: helm browser act <tab> \'{"actions":[{"click":"the Save button"},{"check":"Saved"}]}\'. Checks use literal page text or targets, not questions. Read the returned settled page; failed batches stop with candidates and element numbers. Save repeating tasks with actions using {{param}}, with values, save_as and note; helm browser flows lists them, helm browser run <tab> <name> key=value replays them. Existing kind/ref, selector, role/name and coordinate actions still work; kinds include key, scroll, hover, select, upload/files, evaluate/script, wait/selector, resize, dialog, console, network, back, forward and reload. helm browser screenshot <tab> --output <path> captures when visuals matter; close <tab> releases it. Browser tabs run on this machine: localhost reaches your dev servers. Use text views and batch actions to keep context small. The owner watches from the chat\'s Browser button and can take control; wait if they have control. When the owner asks to be shown or wants to do it themselves, do not click: helm browser point <tab> <ref|selector> --note "Click here to approve" shows them the spot without touching the page. When a site needs a login, suggest that the owner copy their browser profile logins using Logins in the viewer instead of asking for passwords. Respect the request when browsing authenticated sites.]'; }
