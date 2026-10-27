import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { readFile, writeFile, rm, chmod, stat, rename } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { HELM_DIR } from './paths.js';
import { normalizeAction, readOnlyAction, resolveTarget } from './browser-targets.js';
import { BrowserFlows, fillParams, validateFlow } from './browser-flows.js';
import * as browserLogins from './browser-logins.js';
import { canOpenWindow, launchWindow as openWindow, windowProfile, windowName, WINDOW_PAGE_SCRIPT, drawPointer, clearPointer, NEW_TAB, windowOpen } from './browser-window.js';

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
/** A failed page load in plain words, in place of Chromium's code and Playwright's call log. */
export const plainNavError = (error, url) => {
  let host = url; try { host = new URL(url).host || url; } catch { /* not an address */ }
  const text = String(error?.message || error).replace(/\u001b\[[0-9;]*m/g, '');
  const code = /net::(ERR_[A-Z_]+)/.exec(text)?.[1] || '';
  if (code === 'ERR_NAME_NOT_RESOLVED' || code === 'ERR_NAME_RESOLUTION_FAILED') return `Can't find ${host}. Check the address.`;
  if (code === 'ERR_CONNECTION_REFUSED') return `Nothing is answering at ${host}. If it is your own server, is it running?`;
  if (/TIMED_OUT/.test(code) || /Timeout \d+ms exceeded/.test(text)) return `${host} took too long to answer.`;
  if (code === 'ERR_INTERNET_DISCONNECTED' || code === 'ERR_NETWORK_CHANGED') return 'This machine is not connected to the internet.';
  if (code.startsWith('ERR_CERT') || code === 'ERR_SSL_PROTOCOL_ERROR') return `${host} has a security problem, so the page was not opened.`;
  if (code === 'ERR_UNSAFE_PORT') return `Browsers do not open ${host}: that port is blocked for safety.`;
  if (code === 'ERR_CONNECTION_RESET' || code === 'ERR_CONNECTION_CLOSED' || code === 'ERR_EMPTY_RESPONSE') return `${host} closed the connection. Try again.`;
  if (code === 'ERR_TOO_MANY_REDIRECTS') return `${host} keeps sending the browser in circles.`;
  return `Could not open ${host}${code ? ` (${code.slice(4).toLowerCase().replace(/_/g, ' ')})` : ''}.`;
};
const executable = () => process.env.HELM_CHROMIUM_PATH || process.env.HELM_TEST_CHROMIUM || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
const LAUNCH = { headless: true, args: ['--disable-gpu', '--disk-cache-size=33554432'], timeout: 15000 };
// Playwright's headless shell starts ~3x faster and uses about half the memory of full Chromium; a pinned path or a missing shell falls back to the system browser.
async function launchChromium() {
  const { chromium } = await import('playwright'), pinned = process.env.HELM_CHROMIUM_PATH || process.env.HELM_TEST_CHROMIUM;
  if (pinned) return chromium.launch({ ...LAUNCH, executablePath: pinned });
  try { return await chromium.launch(LAUNCH); }
  catch (error) { const system = executable(); if (!system) throw error; return chromium.launch({ ...LAUNCH, executablePath: system }); }
}
// Playwright keeps its own Chromium here unless told otherwise.
const playwrightBrowsers = () => process.env.PLAYWRIGHT_BROWSERS_PATH
  || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright');
const hasPlaywrightChromium = () => { try { return readdirSync(playwrightBrowsers()).some(name => name.startsWith('chromium')); } catch { return false; } };
const bowserBin = () => process.env.HELM_BOWSER_PATH || (process.env.PATH || '').split(':').map(p => join(p, 'bowser-computer')).find(existsSync);
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_THREAD_DOWNLOAD_BYTES = 256 * 1024 * 1024;
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

/**
 * A thread's browser. On a machine with a screen it is a real Chromium
 * window, one per thread, that never takes the owner's keyboard: the agent
 * drives it through Chromium's own channel. Without a screen (a server) it
 * is one shared hidden Chromium. Nothing starts until a tab is used.
 */
export class BrowserManager {
  constructor({ directory = join(HELM_DIR, 'browser'), session = () => null, launch, now = Date.now, bowser = new BowserBridge(), idleMs = 10 * 60000, actionTimeoutMs = 45000, logins = browserLogins, launchWindow = openWindow, canWindow = canOpenWindow(), ownerQuietMs = 2500 } = {}) {
    this.launchWindow = launchWindow; this.canWindow = canWindow; this.ownerQuietMs = ownerQuietMs; this.windowContexts = new Map();
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
        // Only the hidden browser died: a thread's own window keeps going.
        for (const tab of this.tabs.values()) if (tab.engine === 'chromium' && !tab.window) { this.tabs.delete(tab.id); this.recovered.delete(tab.sessionId); }
        for (const sid of [...this.contexts.keys()]) if (!this.windowContexts.has(sid)) this.contexts.delete(sid);
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
    if (this.canWindow) {
      const pending = this.windowContext(sessionId, loginSeed);
      this.contexts.set(sessionId, pending);
      try { return await pending; } catch (error) { this.contexts.delete(sessionId); throw error; }
    }
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
  /**
   * The thread's own Chromium, in a window on this machine's screen. Its
   * profile folder keeps what the window signed in to. A new thread starts
   * signed in to what the owner chose as the default profile's logins.
   */
  async windowContext(sessionId, loginSeed) {
    const folder = windowProfile(this.directory, sessionId), fresh = !existsSync(folder); mkdirSync(folder, { recursive: true, mode: 0o700 });
    let seed = loginSeed;
    if (fresh && !seed) { const choice = await this.loginDefault(sessionId); if (choice.profileKey) seed = await this.logins.readLogins(choice.profileKey); }
    let context;
    try { context = await this.launchWindow(folder, { name: windowName(sessionId) }); }
    catch (error) { throw new Error(`Chromium could not open a window. ${String(error.message).split('\n')[0]}`); }
    context.helmWindow = true; context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
    try {
      // Sign-ins from before (or from a hidden browser on this machine) come along.
      let storage; try { storage = JSON.parse(await readFile(join(this.directory, sessionId, 'storage.json'), 'utf8')); } catch { /* nothing signed in yet */ }
      if (fresh && storage?.cookies?.length) await context.addCookies(storage.cookies).catch(() => {});
      if (seed?.cookies?.length) await context.addCookies(seed.cookies).catch(() => {});
      await context.exposeBinding('__helmOwnerInput', ({ page }) => this.ownerInput(page));
      await context.addInitScript(WINDOW_PAGE_SCRIPT);
    } catch (error) { await context.close().catch(() => {}); throw error; }
    // A new window opens with one blank tab: the first tab Helm needs takes it.
    // A window still open from before a restart keeps its tabs as they are.
    context.helmSpare = context.helmAttached ? null : context.pages()[0] || null;
    if (context.helmAttached) for (const page of context.pages()) this.register(sessionId, page).adopted = true;
    context.on('page', page => this.register(sessionId, page));
    context.on('close', () => void this.windowClosed(sessionId, context).catch(() => {}));
    this.windowContexts.set(sessionId, context);
    this.timer ||= setInterval(() => void this.sweep().catch(() => {}), 2000); this.timer.unref?.();
    return context;
  }
  async newPage(context) { const spare = context.helmSpare; context.helmSpare = null; return spare && !spare.isClosed() ? spare : context.newPage(); }
  /** An empty tab in the window shows the New Tab page, as in any browser. */
  async blank(page) { if (page.context?.().helmWindow) await page.goto(NEW_TAB).catch(() => {}); }
  /** The owner clicked, typed or scrolled in the window; the agent's own input is not theirs. */
  ownerInput(page) {
    const tab = [...this.tabs.values()].find(t => t.page === page);
    if (!tab || tab.agentActing || this.now() - (tab.agentDoneAt || 0) < 300) return;
    tab.ownerAt = tab.actedAt = tab.lastUsed = this.now();
    if (tab.pointer?.by === 'guide') { tab.pointer = null; void page.evaluate(clearPointer).catch(() => {}); }
  }
  /** Agent steps wait while the owner is using the window, up to 20 seconds. */
  async ownerQuiet(tab) {
    const limit = Date.now() + 20000;
    while (this.now() - (tab.ownerAt || -Infinity) < this.ownerQuietMs && Date.now() < limit) await new Promise(done => setTimeout(done, 100));
  }
  /**
   * The owner closed the window. Its tabs are kept, asleep: the agent's next
   * step on one opens the window again with all of them.
   */
  async windowClosed(sessionId, context) {
    context.helmClosed = true;
    if (this.stopping || this.suspending.has(sessionId) || this.windowContexts.get(sessionId) !== context) return;
    this.windowContexts.delete(sessionId); this.recovered.delete(sessionId);
    if (this.contexts.has(sessionId) && (await this.contexts.get(sessionId).catch(() => null)) === context) this.contexts.delete(sessionId);
    await this.persistTabs(sessionId);
  }
  /** Is any thread still using the hidden browser? */
  headlessInUse() { return [...this.contexts.keys()].some(sid => !this.windowContexts.has(sid)) && !this.canWindow; }
  async viewSize(tab) {
    const size = tab.page.viewportSize(); if (size) return size;
    const [width, height] = await tab.page.evaluate(() => [innerWidth, innerHeight]);
    return tab.windowSize = { width, height };
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
    // A window keeps its own sign-ins in its profile folder; only its cookies
    // are copied here. Reading site storage visits every framed site in a
    // hidden tab, which flashes on the owner's screen.
    await this.writePrivate(join(folder, 'storage.json'), context.helmWindow ? { cookies: await context.cookies(), origins: [] } : await context.storageState({ indexedDB: true }));
  }
  register(sessionId, page) {
    const existing = [...this.tabs.values()].find(t => t.page === page); if (existing) return existing;
    const tab = { id: id(), sessionId, engine: 'chromium', page, title: '', console: [], network: [], downloads: [], lastUsed: this.now(), dialog: null, window: !!page.context?.().helmWindow };
    this.tabs.set(tab.id, tab);
    tab.fetching = new Set(); tab.quietAt = 0;
    const changed = () => { tab.quietAt = Date.now(); for (const wake of tab.settleWaiters || []) wake(); };
    page.on('request', request => { if (['fetch', 'xhr'].includes(request.resourceType())) { tab.fetching.add(request); changed(); } });
    const finished = request => { if (tab.fetching.delete(request)) changed(); };
    page.on('requestfinished', finished); page.on('requestfailed', finished);
    page.on('close', () => {
      this.tabs.delete(tab.id);
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
    page.on('domcontentloaded', () => {
      void page.title().then(title => { tab.title = title; }).catch(() => {});
      // A new page keeps the agent's arrow where it last was, without its label.
      if (tab.window && tab.cursor) void page.evaluate(drawPointer, tab.cursor).catch(() => {});
    });
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) tab.problem = null; });
    page.on('load', () => this.persistSoon(sessionId));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) tab.pending = null; });
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
  metadata(tab) { const live = tab.page?.url(); return { id: tab.id, engine: tab.engine, url: tab.problem?.url || tab.pending || (live && live !== 'about:blank' ? live : tab.url || live || 'about:blank'), title: tab.title, viewport: tab.page?.viewportSize() || tab.windowSize || { width: 1280, height: 800 }, window: !!tab.window, dialog: tab.dialog ? { type: tab.dialog.type(), message: tab.dialog.message().slice(0, 2000) } : null, downloads: tab.downloads.map(({ path, ...d }) => d), problem: tab.problem || null }; }
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
        const context = await this.context(sessionId);
        // The window stayed open through a restart: its tab is already there, loaded.
        const kept = [...this.tabs.values()].find(t => t.sessionId === sessionId && t.adopted && t.page.url() === row.url);
        const page = kept?.page || await this.newPage(context), tab = kept || this.register(sessionId, page);
        tab.adopted = false;
        this.tabs.delete(tab.id); tab.id = row.id; tab.title = row.title || tab.title || ''; this.tabs.set(tab.id, tab);
        if (!tab.window && row.viewport && Number.isInteger(row.viewport.width) && row.viewport.width >= 240 && row.viewport.width <= 1920 && Number.isInteger(row.viewport.height) && row.viewport.height >= 200 && row.viewport.height <= 1200) await page.setViewportSize(row.viewport);
        for (const download of (Array.isArray(row.downloads) ? row.downloads : []).slice(-20)) {
          if (!/^[a-f0-9]{16}$/.test(download.id || '') || typeof download.name !== 'string') continue;
          const path = join(this.directory, sessionId, 'downloads', `${download.id}-${basename(download.name)}`);
          tab.downloads.push({ ...download, name: basename(download.name), path, status: download.status === 'ready' && existsSync(path) ? 'ready' : 'failed' });
        }
        if (kept) continue;
        // Loads in the background: the tab list answers now, and each page fills in as it arrives.
        let address = 'about:blank'; try { address = httpUrl(row.url); } catch { /* keep the tab available to retry */ }
        if (address !== 'about:blank') { tab.url = address; tab.ready = page.goto(address, { waitUntil: 'domcontentloaded' }).then(() => {}, () => {}); }
        else tab.ready = this.blank(page);
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
  /** What a closed window, or a restart, left: the saved tab list. */
  async savedRows(sessionId) {
    try { const rows = JSON.parse(await readFile(join(this.directory, sessionId, 'tabs.json'), 'utf8')); return Array.isArray(rows) ? rows.filter(row => row?.engine === 'chromium' && /^[a-f0-9]{16}$/.test(row.id)).slice(0, 24) : []; } catch { return []; }
  }
  async list(sessionId) {
    this.owner(sessionId);
    const live = () => [...this.tabs.values()].filter(t => t.sessionId === sessionId).map(t => this.metadata(t));
    const answer = tabs => ({ tabs, bowser: !!bowserBin(), running: !!this.browser, canWindow: this.canWindow, open: this.windowContexts.has(sessionId) });
    // A window left open through a Helm restart is taken back, tabs as they are.
    if (this.canWindow && !this.contexts.has(sessionId) && !this.stopping && windowOpen(windowProfile(this.directory, sessionId))) {
      try { await this.context(sessionId); await this.recover(sessionId); } catch { /* listed asleep below */ }
    }
    // Listing never opens a window: a closed window's tabs are listed asleep.
    if (this.canWindow && !this.contexts.has(sessionId)) return answer([...live(), ...(await this.savedRows(sessionId)).filter(row => !this.tabs.has(row.id)).map(row => ({ ...row, asleep: true }))]);
    await this.recover(sessionId); return answer(live()); }
  async open(sessionId, { url = 'about:blank', engine = 'chromium' } = {}) {
    await this.recover(sessionId); url = httpUrl(url);
    if (this.tabs.size >= 24) throw new Error('close a browser tab before opening another (24 tab limit)');
    if (engine === 'bowser') {
      if ([...this.tabs.values()].some(t => t.engine === 'bowser' && t.sessionId !== sessionId)) throw new Error('Bowser is shared; close its Helm tab in the other thread first');
      const existing = [...this.tabs.values()].find(t => t.engine === 'bowser' && t.sessionId === sessionId);
      const tab = existing || { id: id(), sessionId, engine, title: 'Bowser shared browser', console: [], network: [], downloads: [] };
      // Reserve the shared browser before asynchronous startup/navigation.
      this.tabs.set(tab.id, tab);
      try {
        const result = url === 'about:blank' ? await this.bowser.call('look', { budget: 0 }) : await this.bowser.call('act', { actions: [...(!existing ? [{ tab: 'new' }] : []), { goto: url }], budget: 0 });
        tab.url = url; tab.lastUsed = this.now(); this.timer ||= setInterval(() => void this.sweep().catch(() => {}), 2000); this.timer.unref?.(); return { tab: this.metadata(tab), text: result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') };
      } catch (error) { if (!existing) this.tabs.delete(tab.id); throw error; }
    }
    if (engine !== 'chromium') throw new Error('unknown browser engine');
    const context = await this.context(sessionId), page = await this.newPage(context), tab = this.register(sessionId, page);
    try { if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' }); else await this.blank(page); await this.settle(tab); tab.title = await page.title(); await this.persistTabs(sessionId); return { tab: this.metadata(tab), ...(await this.look(tab)) }; }
    catch (error) { await page.close(); throw /net::ERR_|Timeout \d+ms/.test(error.message) ? new Error(plainNavError(error, url)) : error; }
  }
  get(sessionId, tabId) { this.owner(sessionId); const tab = this.tabs.get(tabId); if (!tab || tab.sessionId !== sessionId) throw new Error('browser tab not found in this thread'); return tab; }
  async run(sessionId, tabId, action) {
    action = normalizeAction(action);
    await this.recover(sessionId);
    const tab = this.get(sessionId, tabId);
    // A modal dialog blocks the browser action that created it, so answering
    // it skips that queue.
    if (action?.kind === 'dialog') {
      if (['read', 'readonly', 'plan'].includes(this.owner(sessionId).mode)) throw new Error('this thread is read-only; browser actions that change the page are disabled');
      tab.lastUsed = this.now(); return this.perform(tab, action);
    }
    const previous = this.serial.get(tab.id) || Promise.resolve();
    const deadline = Date.now() + this.actionTimeoutMs;
    let timer;
    const operation = previous.catch(() => {}).then(async () => {
      if (Date.now() >= deadline) throw new Error('Browser action expired before delivery.');
      const owner = this.owner(sessionId);
      if (['read', 'readonly', 'plan'].includes(owner.mode)) {
        if (!readOnlyAction(action)) throw new Error('this thread is read-only; browser actions that change the page are disabled');
      }
      tab.lastUsed = tab.actedAt = this.now();
      // Wait for a page restored after a restart before the agent uses it.
      if (tab.ready) { await tab.ready; tab.ready = null; }
      // In a window the owner may be using the page themselves: the agent
      // lets them finish rather than typing over them.
      const shared = tab.window;
      if (shared && !readOnlyAction(action)) await this.ownerQuiet(tab);
      let result;
      if (shared) tab.agentActing = true;
      try { result = await this.perform(tab, action); }
      catch (error) { if (!error.candidates && !error.check) throw error; result = { error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.check ? { check: error.check } : {}), ...(await this.look(tab)) }; }
      finally { if (shared) { tab.agentActing = false; tab.agentDoneAt = this.now(); } }
      if (!['look', 'console', 'network', 'screenshot', 'point'].includes(action?.kind)) { if (['navigate', 'back', 'forward', 'reload', 'batch'].includes(action?.kind)) await this.persistTabs(sessionId); else this.persistSoon(sessionId); }
      return result;
    });
    const job = Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser action timed out; inspect the page before retrying.')), this.actionTimeoutMs); timer.unref?.(); })]);
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
  async perform(tab, action, inBatch = false) {
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
      for (const raw of actions) { try { const step = normalizeAction(raw); results.push(await this.perform(tab, step, true)); } catch (error) { return { results, failedAt: results.length, error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.check ? { check: error.check } : {}), ...(await this.look(tab, action.budget ?? 6000)) }; } }
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
    if (kind === 'point' && tab.engine === 'bowser') throw new Error('pointing works in isolated Chromium tabs, not Bowser');
    if (tab.engine === 'bowser') return this.bowserAction(tab, action);
    const page = tab.page;
    await this.aim(tab, action);
    if (kind === 'point') return { tab: this.metadata(tab) };
    if (['navigate', 'back', 'forward', 'reload'].includes(kind)) await this.go(tab, kind, action);
    else if (kind === 'stop') { const cdp = await page.context().newCDPSession(page); try { await cdp.send('Page.stopLoading'); } finally { await cdp.detach().catch(() => {}); } }
    else if (kind === 'click' || kind === 'hover') {
      if (action.x != null) { const { width, height } = await this.viewSize(tab); integer(action.x, 0, width); integer(action.y, 0, height); kind === 'click' ? await page.mouse.click(action.x, action.y, { button: ['left', 'right', 'middle'].includes(action.button) ? action.button : 'left', clickCount: action.double ? 2 : 1 }) : await page.mouse.move(action.x, action.y); }
      else { const target = await this.target(tab, action); try { kind === 'click' ? await target.click({ button: action.button || 'left', clickCount: action.double ? 2 : 1 }) : await target.hover(); } finally { if (target.dispose) await target.dispose(); } }
    } else if (kind === 'drag') { const { width, height } = await this.viewSize(tab); for (const field of ['fromX', 'toX']) integer(action[field], 0, width); for (const field of ['fromY', 'toY']) integer(action[field], 0, height); await page.mouse.move(action.fromX, action.fromY); await page.mouse.down(); try { await page.mouse.move(action.toX, action.toY, { steps: 6 }); } finally { await page.mouse.up(); } }
    else if (kind === 'type') { const value = text(action.text); if (action.ref || action.selector || action.name || action.role || action.target != null) { const target = await this.target(tab, action); try { if (action.append) { await target.focus(); await page.keyboard.insertText(value); } else await target.fill(value); if (action.enter) await target.press('Enter'); } finally { if (target.dispose) await target.dispose(); } } else { if (action.clear) { await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); } await page.keyboard.insertText(value); if (action.enter) await page.keyboard.press('Enter'); } }
    else if (kind === 'key') await page.keyboard.press(text(action.key, 100));
    else if (kind === 'clipboard') {
      const origin = new URL(page.url()).origin;
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      try { return { text: await page.evaluate(() => navigator.clipboard.readText()) }; }
      finally { await page.context().clearPermissions(); }
    }
    else if (kind === 'scroll') await page.mouse.wheel(integer(action.dx ?? 0, -20000, 20000), integer(action.direction ? Math.round((await this.viewSize(tab)).height * (action.pages ?? 1) * (action.direction === 'up' ? -1 : 1)) : action.dy ?? 500, -20000, 20000));
    else if (kind === 'select') { const target = await this.target(tab, action); try { await target.selectOption(action.option != null ? { label: text(action.option, 1000) } : action.values || text(action.value, 1000)); } finally { if (target.dispose) await target.dispose(); } }
    else if (kind === 'upload') {
      const files = await this.uploads(tab, action);
      let target; try { target = await this.target(tab, action); await target.setInputFiles(files.paths); } finally { if (target?.dispose) await target.dispose(); await files.cleanup(); }
    } else if (kind === 'evaluate') { const value = await page.evaluate(text(action.script, 20000)); await this.settle(tab); return { value, ...(!inBatch ? await this.look(tab) : {}) }; }
    else if (kind === 'wait') { integer(action.timeout ?? 10000, 1, 30000); if (action.selector) await page.locator(text(action.selector, 2000)).waitFor({ state: action.state || 'visible', timeout: action.timeout ?? 10000 }); else await page.getByText(text(action.text, 2000)).first().waitFor({ timeout: action.timeout ?? 10000 }); }
    else if (kind === 'resize') await page.setViewportSize({ width: integer(action.width, 240, 1920), height: integer(action.height, 200, 1200) });
    else if (kind === 'dialog') { if (!tab.dialog) throw new Error('no dialog is open'); const dialog = tab.dialog; tab.dialog = null; action.accept ? await dialog.accept(action.text ?? '') : await dialog.dismiss(); }
    else throw new Error(`unknown browser action: ${kind}`);
    if (['navigate', 'back', 'forward', 'reload', 'click', 'type', 'key', 'select', 'hover', 'scroll', 'drag', 'resize', 'upload', 'dialog', 'wait'].includes(kind)) await this.settle(tab);
    // Only actions that can change the title ask for it; page loads update it as they finish.
    if (!['hover', 'scroll', 'type', 'resize'].includes(kind)) tab.title = await page.title().catch(() => tab.title);
    return { tab: this.metadata(tab), ...(!inBatch ? await this.look(tab) : {}) };
  }
  /** Where the agent is about to act, drawn on the page in a window. Free in a hidden browser; point always draws. */
  async aim(tab, action) {
    const kind = action.kind;
    if (POINTER_CLEARS.includes(kind)) { if (tab.pointer) { tab.pointer = null; void tab.page.evaluate(clearPointer).catch(() => {}); } return; }
    if (!Object.hasOwn(POINTER_WORDS, kind) || kind !== 'point' && !tab.window) return;
    const { width, height } = await this.viewSize(tab);
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
    tab.cursor = { x, y };
    await tab.page.evaluate(drawPointer, { ...tab.pointer, guide: kind === 'point' }).catch(() => {});
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
  /** Wait for navigation and report a failed load in plain words. */
  async go(tab, kind, action) {
    const page = tab.page, wait = { waitUntil: 'domcontentloaded' }, target = kind === 'navigate' ? httpUrl(action.url) : null;
    // Keep the requested address until navigation finishes.
    if (target) tab.url = tab.pending = target;
    tab.problem = null;
    const moving = (target ? page.goto(target, wait) : kind === 'back' ? page.goBack(wait) : kind === 'forward' ? page.goForward(wait) : page.reload(wait))
      .then(() => { if (tab.pending === target) tab.pending = null; }, error => {
        if (tab.pending === target) tab.pending = null;
        // Interrupted by the next navigation: that one is what the owner sees.
        if (/ERR_ABORTED|interrupted by another navigation|Target (page, context or browser )?(has been )?closed/i.test(error.message)) return;
        const url = target || tab.url || page.url();
        tab.problem = { url, message: plainNavError(error, url) };
        return tab.problem;
      });
    const problem = await moving;
    if (problem) throw new Error(problem.message);
  }
  async pageClosed(sessionId, tab) {
    await new Promise(resolve => { const timer = setTimeout(resolve, this.closeGraceMs ?? 1500); timer.unref?.(); });
    // A window that closed keeps its tabs asleep; one tab closed in a window
    // that is still open is that tab, closed by the owner.
    if (tab.window) {
      if (this.stopping || tab.page.context?.().helmClosed || !this.orphans?.has(tab.id)) return;
      this.orphans.delete(tab.id); this.discardDownloads(tab); await this.persistTabs(sessionId); return;
    }
    if (this.stopping || !this.browser || this.browser.isConnected?.() === false || !this.orphans?.has(tab.id)) return;
    // The browser is still up: the page closed itself (window.close).
    this.orphans.delete(tab.id); this.discardDownloads(tab);
    await this.persistTabs(sessionId);
    if ([...this.tabs.values()].some(t => t.sessionId === sessionId && t.engine === 'chromium')) return;
    const pending = this.contexts.get(sessionId), context = await pending;
    if (!context || this.contexts.get(sessionId) !== pending) return;
    await this.save(sessionId).catch(() => {}); this.contexts.delete(sessionId); await context.close();
    if (!this.headlessInUse()) await this.shutdownBrowser();
  }
  async save(sessionId) { const context = await this.contexts.get(sessionId); if (context) { (this.savedAt ||= new Map()).set(sessionId, this.now()); await this.saveContext(sessionId, context); } }
  async close(sessionId, tabId) {
    // A sleeping tab closes without waking its window.
    if (this.canWindow && !this.contexts.has(sessionId) && !this.tabs.has(tabId)) { this.owner(sessionId); const rows = await this.savedRows(sessionId); if (!rows.some(row => row.id === tabId)) throw new Error('browser tab not found in this thread'); await writeFile(join(this.directory, sessionId, 'tabs.json'), JSON.stringify(rows.filter(row => row.id !== tabId)), { mode: 0o600 }); return { ok: true }; }
    await this.recover(sessionId); const tab = this.get(sessionId, tabId); if (this.serial.has(tab.id)) throw new Error('wait for the current browser action to finish'); await this.save(sessionId); if (tab.page) { tab.explicitClose = true; await tab.page.close(); } else { this.tabs.delete(tab.id); this.bowser.stop(); } await this.persistTabs(sessionId); if (![...this.tabs.values()].some(t => t.sessionId === sessionId && t.engine === 'chromium')) { const context = await this.contexts.get(sessionId); this.contexts.delete(sessionId); await context?.close(); } if (!this.headlessInUse()) await this.shutdownBrowser(); return { ok: true }; }
  async sweep() {
    for (const tab of this.tabs.values()) if (tab.engine === 'bowser' && this.now() - tab.lastUsed > this.idleMs && !this.serial.has(tab.id)) this.bowser.stop();
    for (const sid of [...this.contexts.keys()]) {
      const tabs = [...this.tabs.values()].filter(t => t.sessionId === sid && t.engine === 'chromium');
      // Sign-ins made since the last save survive Chromium dying with Helm.
      const savedAt = this.savedAt?.get(sid) || 0;
      if (tabs.some(t => t.actedAt > savedAt) && this.now() - savedAt > 15000) await this.save(sid).catch(() => {});
      // A window on the owner's screen is never put away behind their back.
      if (this.windowContexts.has(sid)) continue;
      if (!tabs.length || !tabs.every(t => !this.serial.has(t.id) && this.now() - t.lastUsed > this.idleMs)) continue;
      await this.save(sid); await this.persistTabs(sid); const context = await this.contexts.get(sid); this.suspending.add(sid); try { await context?.close(); } finally { this.suspending.delete(sid); } this.contexts.delete(sid); this.recovered.delete(sid);
    }
    if (this.browser && !this.headlessInUse()) await this.shutdownBrowser();
  }
  async shutdownBrowser() { const browser = this.browser; this.browser = null; await browser?.close(); if (!this.tabs.size) { clearInterval(this.timer); this.timer = null; } }
  async stop() { this.stopping = true; for (const sid of this.contexts.keys()) { await this.save(sid).catch(() => {}); await this.persistTabs(sid).catch(() => {}); } this.bowser.stop(); // A window Helm can come back to stays open on the owner's screen.
    for (const context of this.windowContexts.values()) await (context.helmDetach ? context.helmDetach() : context.close()).catch(() => {});
    this.windowContexts.clear(); await this.shutdownBrowser(); this.tabs.clear(); this.contexts.clear(); clearInterval(this.timer); this.timer = null; }
}

/** A machine with no browser to start gets no browser note: it would only steer the agent to a tool that fails. */
export function browserReady() { return !!(executable() || hasPlaywrightChromium() || bowserBin()); }

export function browserNote({ bowser = !!bowserBin() } = {}) { return `[Helm browser: helm browser controls Chromium tabs on this machine (helm browser --help). On machines with a screen, the owner uses the external Chromium window. Helm has no browser panel. localhost reaches your dev servers.${bowser ? ' Bowser Computer Use is installed: --engine bowser.' : ''} When the owner wants to do a step, point at it with helm browser point; do not click. Never ask for passwords. Suggest helm browser profiles and helm browser logins "<profile>" to copy logins. Respect the request on signed-in sites.]`; }
