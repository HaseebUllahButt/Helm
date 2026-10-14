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
const bowserBin = () => process.env.HELM_BOWSER_PATH || (process.env.PATH || '').split(':').map(p => join(p, 'bowser-computer')).find(existsSync);

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
    }
    const requestId = ++this.sequence;
    const result = await new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Bowser action timed out; inspect the browser before retrying')); }, 45000); timer.unref?.();
      this.pending.set(requestId, { resolve: resolveCall, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
    if (result?.isError) throw new Error(result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') || 'Bowser action failed');
    return result;
  }
  stop(error = new Error('Bowser bridge stopped')) { const child = this.child; this.child = null; child?.kill(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
}

/** Lazy, shared Chromium. No browser imports/processes or screenshot work while unused. */
export class BrowserManager {
  constructor({ directory = join(HELM_DIR, 'browser'), session = () => null, launch, now = Date.now, bowser = new BowserBridge(), idleMs = 10 * 60000 } = {}) {
    this.directory = directory; this.session = session; this.launch = launch; this.now = now; this.bowser = bowser; this.idleMs = idleMs; this.tabs = new Map(); this.contexts = new Map(); this.serial = new Map(); this.recovered = new Map(); this.browser = null;
  }
  async start() {
    if (!this.starting) this.starting = (async () => {
      if (this.browser?.isConnected()) return this.browser;
      const launch = this.launch || (async () => { const { chromium } = await import('playwright'); return chromium.launch({ headless: true, ...(executable() ? { executablePath: executable() } : {}), args: ['--disable-gpu', '--disk-cache-size=33554432'], timeout: 15000 }); });
      try { this.browser = await launch(); } catch (error) { throw new Error(`Chromium could not start. Set HELM_CHROMIUM_PATH or install it with npx playwright install chromium. ${error.message}`); }
      this.browser.on('disconnected', () => { for (const tab of this.tabs.values()) this.clearStream(tab); this.tabs.clear(); this.contexts.clear(); this.recovered.clear(); this.browser = null; });
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
    page.on('close', () => { this.clearStream(tab); this.tabs.delete(tab.id); });
    page.on('console', msg => cap(tab.console, { level: msg.type(), text: msg.text().slice(0, 4000), at: this.now() }));
    page.on('pageerror', error => cap(tab.console, { level: 'error', text: error.message.slice(0, 4000), at: this.now() }));
    page.on('response', response => cap(tab.network, { url: response.url().slice(0, 2000), method: response.request().method(), status: response.status() }));
    page.on('requestfailed', request => cap(tab.network, { url: request.url().slice(0, 2000), method: request.method(), error: request.failure()?.errorText }));
    page.on('dialog', dialog => { tab.dialog = dialog; });
    page.on('download', download => {
      const record = { id: id(), name: basename(download.suggestedFilename()), url: download.url(), status: 'pending' }; cap(tab.downloads, record, 20);
      const folder = join(this.directory, sessionId, 'downloads'); mkdirSync(folder, { recursive: true, mode: 0o700 });
      record.path = join(folder, `${record.id}-${record.name}`);
      void download.saveAs(record.path).then(() => { record.status = 'ready'; }, () => { record.status = 'failed'; });
    });
    return tab;
  }
  metadata(tab) { return { id: tab.id, engine: tab.engine, url: tab.page?.url() || tab.url || 'about:blank', title: tab.title, viewport: tab.page?.viewportSize() || { width: 1280, height: 800 }, control: tab.control, dialog: tab.dialog ? { type: tab.dialog.type(), message: tab.dialog.message().slice(0, 2000) } : null, downloads: tab.downloads.map(({ path, ...d }) => d) }; }
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
  async persistTabs(sessionId) { const folder = join(this.directory, sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 }); await writeFile(join(folder, 'tabs.json'), JSON.stringify([...this.tabs.values()].filter(t => t.sessionId === sessionId).map(t => this.metadata(t))), { mode: 0o600 }); }
  async list(sessionId) { await this.recover(sessionId); return { tabs: [...this.tabs.values()].filter(t => t.sessionId === sessionId).map(t => this.metadata(t)), bowser: !!bowserBin(), running: !!this.browser }; }
  async open(sessionId, { url = 'about:blank', engine = 'chromium' } = {}) {
    await this.recover(sessionId); url = httpUrl(url);
    if (this.tabs.size >= 24) throw new Error('close a browser tab before opening another (24 tab limit)');
    if (engine === 'bowser') {
      if ([...this.tabs.values()].some(t => t.engine === 'bowser' && t.sessionId !== sessionId)) throw new Error('Bowser is shared; close its Helm tab in the other thread first');
      const result = await this.bowser.call('act', { actions: [{ goto: url }], budget: 0 });
      const tab = [...this.tabs.values()].find(t => t.engine === 'bowser' && t.sessionId === sessionId) || { id: id(), sessionId, engine, title: 'Bowser shared browser', console: [], network: [], downloads: [], viewers: new Map(), sequence: 0, control: null };
      tab.url = url; tab.lastUsed = this.now(); this.tabs.set(tab.id, tab); this.timer ||= setInterval(() => void this.sweep().catch(() => {}), 2000); this.timer.unref?.(); return { tab: this.metadata(tab), text: result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') };
    }
    if (engine !== 'chromium') throw new Error('unknown browser engine');
    const context = await this.context(sessionId), page = await context.newPage(), tab = this.register(sessionId, page);
    try { if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' }); tab.title = await page.title(); await this.persistTabs(sessionId); return { tab: this.metadata(tab), ...(await this.look(tab)) }; }
    catch (error) { await page.close(); throw error; }
  }
  get(sessionId, tabId) { this.owner(sessionId); const tab = this.tabs.get(tabId); if (!tab || tab.sessionId !== sessionId) throw new Error('browser tab not found in this thread'); return tab; }
  async run(sessionId, tabId, action, actor = 'agent') {
    await this.recover(sessionId);
    const tab = this.get(sessionId, tabId);
    const previous = this.serial.get(tab.id) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const owner = this.owner(sessionId);
      if (actor === 'agent' && ['read', 'readonly', 'plan'].includes(owner.mode)) {
        const readOnly = step => ['look', 'console', 'network', 'screenshot', 'navigate', 'back', 'forward'].includes(step?.kind) || step?.kind === 'batch' && Array.isArray(step.actions) && step.actions.every(readOnly);
        if (!readOnly(action)) throw new Error('this thread is read-only; browser actions that change the page are disabled');
      }
      this.checkControl(tab, action, actor);
      tab.lastUsed = this.now(); const result = await this.perform(tab, action, actor); if (!['look', 'console', 'network', 'screenshot'].includes(action?.kind)) await this.persistTabs(sessionId); return result;
    });
    this.serial.set(tab.id, job); void job.finally(() => { if (this.serial.get(tab.id) === job) this.serial.delete(tab.id); }).catch(() => {}); return job;
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
  checkControl(tab, action, actor) {
    if (['look', 'console', 'network', 'screenshot'].includes(action?.kind)) return;
    if (actor !== 'agent' && tab.control !== actor) throw new Error('Take control before changing this browser tab.');
    if (tab.control && tab.control !== actor) throw new Error('You have control of this tab. Release control to let the agent continue.');
  }
  async perform(tab, action, actor = 'agent') {
    if (!action || typeof action !== 'object') throw new Error('browser action must be an object');
    const kind = action.kind;
    if (kind === 'look') return { tab: this.metadata(tab), ...(await this.look(tab, action.budget ?? 6000)) };
    if (kind === 'console') return { entries: tab.console };
    if (kind === 'network') return { entries: tab.network };
    if (kind === 'screenshot') return this.capture(tab, action);
    if (kind === 'batch') {
      if (!Array.isArray(action.actions) || action.actions.length > 40 || action.actions.some(a => a.kind === 'batch')) throw new Error('a batch holds at most 40 nonnested actions');
      const results = []; for (const step of action.actions) { try { this.checkControl(tab, step, actor); results.push(await this.perform(tab, step, actor)); } catch (error) { return { results, failedAt: results.length, error: error.message, ...(await this.look(tab)) }; } } return { results, ...(await this.look(tab)) };
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
    tab.title = await page.title().catch(() => tab.title); return { tab: this.metadata(tab) };
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
  async capture(tab, { fullPage = false } = {}) {
    if (tab.engine === 'bowser') { const result = await this.bowser.call('screenshot', { max_size: 1280 }); const part = result.content.find(p => p.type === 'image'); if (!part) throw new Error('Bowser did not return a screenshot'); return { image: `data:${part.mimeType};base64,${part.data}` }; }
    const bytes = await tab.page.screenshot({ type: 'jpeg', quality: 75, fullPage: !!fullPage, timeout: 10000 });
    if (bytes.length > 3 * 1024 * 1024) throw new Error('screenshot exceeds 3 MiB; capture the viewport instead');
    return { image: `data:image/jpeg;base64,${bytes.toString('base64')}` };
  }
  async frame(sessionId, tabId, { viewer, since = -1 } = {}) {
    await this.recover(sessionId);
    const tab = this.get(sessionId, tabId); if (!/^[\w-]{1,100}$/.test(viewer || '')) throw new Error('invalid browser viewer');
    tab.lastUsed = this.now(); tab.viewers.set(viewer, this.now());
    if (tab.engine === 'bowser') {
      if (!tab.capturing && (!tab.frame || this.now() - (tab.frameAt || 0) > 900)) tab.capturing = this.capture(tab).then(result => { const hash = createHash('sha256').update(result.image).digest('hex'); if (hash !== tab.hash || !tab.frame) { tab.frame = result.image; tab.sequence++; tab.hash = hash; } tab.frameAt = this.now(); }).finally(() => { tab.capturing = null; });
      if (tab.capturing) await tab.capturing;
    } else if (!tab.cdp && !tab.streamStart) {
      tab.streamStart = (async () => {
      const cdp = await tab.page.context().newCDPSession(tab.page); tab.cdp = cdp;
      cdp.on('Page.screencastFrame', event => {
        // Keep only the latest frame and pace acknowledgements: bounded memory and five fps.
        tab.frame = `data:image/jpeg;base64,${event.data}`; tab.sequence++;
        const ack = setTimeout(() => { tab.acks?.delete(ack); void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); }, 200); ack.unref?.(); (tab.acks ||= new Set()).add(ack);
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
      })().finally(() => { tab.streamStart = null; });
    }
    if (tab.streamStart) await tab.streamStart;
    return { tab: this.metadata(tab), sequence: tab.sequence, ...(tab.frame && since !== tab.sequence ? { image: tab.frame } : {}) };
  }
  async clearStream(tab) { await tab.streamStart?.catch(() => {}); for (const timer of tab.acks || []) clearTimeout(timer); tab.acks?.clear(); const cdp = tab.cdp; tab.cdp = null; if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); } tab.frame = null; }
  async unwatch(sessionId, tabId, viewer) { const tab = this.get(sessionId, tabId); tab.viewers.delete(viewer); if (tab.control === viewer) tab.control = null; if (!tab.viewers.size) await this.clearStream(tab); return { ok: true }; }
  async control(sessionId, tabId, viewer, take) { await this.recover(sessionId); const tab = this.get(sessionId, tabId); if (!/^[\w-]{1,100}$/.test(viewer || '')) throw new Error('invalid browser viewer'); if (tab.control && tab.control !== viewer) throw new Error('another viewer has control'); tab.control = take ? viewer : null; tab.viewers.set(viewer, this.now()); await (this.serial.get(tab.id) || Promise.resolve()).catch(() => {}); return { tab: this.metadata(tab) }; }
  async save(sessionId) { const context = await this.contexts.get(sessionId); if (!context) return; const folder = join(this.directory, sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 }); const file = join(folder, 'storage.json'); await context.storageState({ path: file, indexedDB: true }); await chmod(file, 0o600); }
  async close(sessionId, tabId) { await this.recover(sessionId); const tab = this.get(sessionId, tabId); if (this.serial.has(tab.id)) throw new Error('wait for the current browser action to finish'); await this.save(sessionId); await this.clearStream(tab); if (tab.page) await tab.page.close(); else { this.tabs.delete(tab.id); this.bowser.stop(); } await this.persistTabs(sessionId); if (![...this.tabs.values()].some(t => t.sessionId === sessionId)) { const context = await this.contexts.get(sessionId); await context?.close(); this.contexts.delete(sessionId); } if (!this.tabs.size) await this.shutdownBrowser(); return { ok: true }; }
  async download(sessionId, tabId, downloadId) { await this.recover(sessionId); const tab = this.get(sessionId, tabId), record = tab.downloads.find(d => d.id === downloadId && d.status === 'ready'); if (!record) throw new Error('download is not ready'); if ((await stat(record.path)).size > 8 * 1024 * 1024) throw new Error('download is over 8 MiB; use its file on the host'); const bytes = await readFile(record.path); if (bytes.length > 8 * 1024 * 1024) throw new Error('download is over 8 MiB; use its file on the host'); return { name: record.name, data: bytes.toString('base64') }; }
  async sweep() {
    for (const tab of this.tabs.values()) {
      for (const [viewer, at] of tab.viewers) if (this.now() - at > 10000) { tab.viewers.delete(viewer); if (tab.control === viewer) tab.control = null; }
      if (!tab.viewers.size && tab.cdp) await this.clearStream(tab);
      if (tab.engine === 'bowser' && !tab.viewers.size && this.now() - tab.lastUsed > this.idleMs && !this.serial.has(tab.id)) this.bowser.stop();
    }
    for (const sid of [...this.contexts.keys()]) {
      const tabs = [...this.tabs.values()].filter(t => t.sessionId === sid && t.engine === 'chromium');
      if (!tabs.length || !tabs.every(t => !t.viewers.size && !this.serial.has(t.id) && this.now() - t.lastUsed > this.idleMs)) continue;
      await this.save(sid); await this.persistTabs(sid); const context = await this.contexts.get(sid); await context?.close(); this.contexts.delete(sid); this.recovered.delete(sid);
    }
    if (this.browser && !this.contexts.size) await this.shutdownBrowser();
  }
  async shutdownBrowser() { clearInterval(this.timer); this.timer = null; const browser = this.browser; this.browser = null; await browser?.close(); }
  async stop() { for (const sid of this.contexts.keys()) { await this.save(sid).catch(() => {}); await this.persistTabs(sid).catch(() => {}); } for (const tab of this.tabs.values()) await this.clearStream(tab); this.bowser.stop(); await this.shutdownBrowser(); this.tabs.clear(); this.contexts.clear(); }
}

export function browserNote() { return '[Helm browser: Agents and the owner can use the same browser tabs. Run helm browser open <url> inside this chat (isolated Chromium), or --engine bowser to reuse Bowser Computer Use on machines where installed. helm browser tabs lists your tabs. helm browser look <tab> returns text and numbered elements without screenshots. helm browser act <tab> \'{"kind":"click","ref":1}\' drives them; use kind batch with actions for several steps. Other kinds: navigate/url, type/text/ref, key/key, scroll/dy, hover/ref, select/ref/value, upload/ref/files (host paths), evaluate/script, wait/selector, resize/width/height, dialog/accept, console, network, back, forward, reload. helm browser screenshot <tab> --output <path> captures when visuals matter; close <tab> releases it. Browser tabs run on this machine: localhost reaches your dev servers. Use text views and batch actions to keep context small. The owner can view tabs and take control from Thread details → Browser; wait if they have control. Respect the request when browsing authenticated sites.]'; }
