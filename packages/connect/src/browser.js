import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { readFile, writeFile, rm, chmod, stat, rename } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { HELM_DIR } from './paths.js';
import { CAPTCHA_SLICE_MS, normalizeAction, readOnlyAction, resolveTarget, scoreTargets } from './browser-targets.js';
import { BrowserFlows, fillParams, validateFlow } from './browser-flows.js';
import { browserArgs, ignoredBrowserArgs, browserIdentity, presentAsChrome } from './browser-identity.js';
import * as browserLogins from './browser-logins.js';
import { canOpenWindow, systemChromium, launchTarget, launchWindow as openWindow, windowProfile, sharedProfile, WINDOW_PAGE_SCRIPT, drawPointer, clearPointer, NEW_TAB, windowOpen, stopWindow, trimProfile, screenEnv } from './browser-window.js';
import { ExtensionRelay } from './browser-relay.js';
import { EXTENSION_ID, EXTENSION_VERSION, browserRunning, openProfile, profileOfMark, copyText, extensionFolder, linkFile, manualSteps, openExtensionsPage, ownBrowserPids, pasteSteps, readMode, restartOwnBrowser, startOwnBrowser, syncExtension, writeMode, flagsFile, readChoice, writeMain, manualBrowser, setBrowserExtension } from './browser-extension.js';
import { discoverBrowsers } from './chromium-find.js';

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
const executable = () => process.env.HELM_CHROMIUM_PATH || process.env.HELM_TEST_CHROMIUM || systemChromium();
const LAUNCH = { headless: true, channel: 'chromium', ignoreDefaultArgs: ignoredBrowserArgs, args: [...browserArgs, '--disk-cache-size=33554432', '--disable-component-update'], timeout: 15000 };
// Full Chromium keeps the same plugins, languages and window.chrome as a window.
async function launchChromium() {
  const { chromium } = await import('patchright-core'), pinned = process.env.HELM_CHROMIUM_PATH || process.env.HELM_TEST_CHROMIUM;
  let browser;
  if (pinned) browser = await chromium.launch({ ...LAUNCH, executablePath: pinned });
  else try { browser = await chromium.launch(LAUNCH); }
  catch (error) { const system = executable(); if (!system) throw error; browser = await chromium.launch({ ...LAUNCH, executablePath: system }); }
  try { browser.helmIdentity = await browserIdentity(browser); browser.helmPatched = true; return browser; }
  catch (error) { await browser.close(); throw error; }
}
// Playwright keeps its own Chromium here unless told otherwise.
const playwrightBrowsers = () => process.env.PLAYWRIGHT_BROWSERS_PATH
  || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright');
const hasPlaywrightChromium = () => { try { return readdirSync(playwrightBrowsers()).some(name => name.startsWith('chromium-')); } catch { return false; } };
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
/** How long a browser Helm started gets to load the add-on and connect. */
const OWN_START_MS = 20000;
const OWN_BROWSER_OFF = 'Your browser is not connected to Helm. Ask the owner to open it. If it is open, run helm browser mode to see why. To use Helm\'s own window, run helm browser mode window.';
const MAX_THREAD_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const POINTER_WORDS = { click: 'Clicking', hover: 'Pointing at', type: 'Typing into', select: 'Choosing in', upload: 'Uploading into', drag: 'Dragging', scroll: 'Scrolling', point: '' };
const POINTER_CLEARS = ['navigate', 'back', 'forward', 'reload', 'resize'];
const pointerTarget = el => {
  const view = el.ownerDocument.defaultView, rect = el.getBoundingClientRect();
  const name = (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || (['submit', 'button', 'reset'].includes(el.type) ? el.value : '') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  let clipped = false;
  for (let parent = el.parentElement || el.getRootNode().host; parent && !clipped; parent = parent.parentElement || parent.getRootNode().host) {
    const style = view.getComputedStyle(parent), box = parent.getBoundingClientRect();
    clipped = style.overflowX !== 'visible' && (rect.left < box.left || rect.right > box.right)
      || style.overflowY !== 'visible' && (rect.top < box.top || rect.bottom > box.bottom);
  }
  return { name, main: view === view.top, clipped, viewport: { width: view.innerWidth, height: view.innerHeight },
    box: rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
};

// How long a step may wait, unless the call asks for more with "timeout"
// (ms): a control to be ready or a check to hold, a page to load, a call.
const STEP_MS = 2000, NAV_MS = 10000, CALL_MS = 30000, MAX_MS = 120000;
const pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
/** What a frame inside the page says, or null when it is busy or gone. */
const frameAnswer = (reading, wait = STEP_MS) => Promise.race([reading.catch(() => null), pause(wait).then(() => null)]);
/** A step's own deadline, never past the deadline of its call. */
const stepTime = (action, op, base) => { const wanted = action.timeout == null ? base : integer(action.timeout, 1, MAX_MS); return Math.max(1, Math.min(wanted, op ? op.deadline - Date.now() : wanted)); };
/** A check is page text, or all of: text, url (part of the address), dialog (true or part of its message), target (a control) with its value or checked state. */
const checkSpec = value => {
  if (typeof value === 'string') return { text: text(value, 2000) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('check needs page text, or an object with text, url, dialog or target');
  const unknown = Object.keys(value).filter(key => !['text', 'url', 'dialog', 'target', 'value', 'checked'].includes(key));
  if (unknown.length) throw new Error(`check does not know ${unknown.join(', ')}; use text, url, dialog, target, value or checked`);
  for (const key of ['text', 'url', 'target', 'value']) if (value[key] != null) text(value[key], 2000);
  if (value.dialog != null && value.dialog !== true) text(value.dialog, 2000);
  if (value.checked != null && typeof value.checked !== 'boolean') throw new Error('check checked must be true or false');
  if ((value.value != null || value.checked != null) && value.target == null) throw new Error('check value and checked need a target');
  if (value.text == null && value.url == null && value.dialog == null && value.target == null) throw new Error('check needs text, url, dialog or target');
  return value;
};
// In a frame: where its frame element is in the parent page.
const frameBox = el => {
  const r = el.getBoundingClientRect(), view = el.ownerDocument.defaultView, s = view.getComputedStyle(el);
  return { visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[inert]'), inView: r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth };
};
// In a frame: is this text in its document or its open shadow roots? Child frames are read on their own.
const hasText = value => {
  const visible = el => { const r = el.getBoundingClientRect(), s = el.ownerDocument.defaultView.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[inert]'); };
  const visit = root => {
    if ((root.body?.innerText || (root.nodeType === 11 ? [...root.childNodes].map(node => node.nodeType === 3 ? node.textContent : node.nodeType === 1 && visible(node) ? node.innerText || '' : '').join('\n') : '') || '').includes(value)) return true;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot && visible(el) && visit(el.shadowRoot)) return true;
    return false;
  };
  return visit(document);
};
// In a frame: its text and visible controls. Each control keeps the local
// number it first got in this document, which `doc` names. It also names a
// CAPTCHA a person can see, by its element, and if its answer field has a
// value; `captchaOnly` reads only that.
const readFrame = ({ limit, room, within, inView, captchaOnly }) => {
  const visible = el => { const r = el.getBoundingClientRect(), s = el.ownerDocument.defaultView.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden],[inert]'); };
  const captcha = (() => {
    const widgets = { recaptcha: '.g-recaptcha:not([data-size=invisible])', hcaptcha: '.h-captcha:not([data-size=invisible])', turnstile: '.cf-turnstile', cloudflare: '#challenge-form,#challenge-stage,#challenge-running,#cf-challenge-running', arkose: '#FunCaptcha,.funcaptcha,#arkose', geetest: '.geetest_holder,.geetest_panel,.geetest_box,.geetest_captcha,.geetest_widget', perimeterx: '#px-captcha', awswaf: 'awswaf-captcha' };
    const found = []; window.__helmCaptcha = null;
    for (const [vendor, css] of Object.entries(widgets)) { const el = [...document.querySelectorAll(css)].find(visible); if (el) { found.push(vendor); window.__helmCaptcha ||= el; } }
    // Cloudflare's "Just a moment" page sets its options in a small inline script.
    if (!found.includes('cloudflare') && window === window.top && [...document.scripts].some(s => !s.src && s.text.length < 20000 && s.text.includes('_cf_chl_opt'))) { found.push('cloudflare'); window.__helmCaptcha ||= document.body; }
    const answers = {};
    for (const [vendor, name] of [['recaptcha', 'g-recaptcha-response'], ['hcaptcha', 'h-captcha-response'], ['turnstile', 'cf-turnstile-response']]) { const fields = document.getElementsByName(name); if (fields.length) answers[vendor] = [...fields].some(field => String(field.value || '').trim() !== ''); }
    return found.length || Object.keys(answers).length ? { found, answers } : null;
  })();
  if (captchaOnly) return { captcha };
  const selector = 'a[href],button,input:not([type=hidden]),textarea,select,option,summary,label[for],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menu],[role=menuitem],[role=option],[role=combobox],[role=switch],[role=textbox],[role=searchbox],[contenteditable=true],[onclick]';
  let scopes = [document];
  if (within) { try { scopes = [...document.querySelectorAll(within)]; } catch { return { error: `within: ${JSON.stringify(within)} is not a CSS selector` }; } }
  const refs = window.__helmRefs ||= { doc: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, next: 1, nums: new WeakMap(), els: new Map() };
  for (const [ref, held] of refs.els) if (!held.deref()?.isConnected) refs.els.delete(ref);
  const listed = new Set(), roots = [], seen = new Set(); let total = 0;
  const visit = root => {
    if (seen.has(root)) return; seen.add(root); roots.push(root);
    const candidates = new Set(root.querySelectorAll(selector));
    for (const el of root.querySelectorAll('*')) {
      if (!listed.has(el) && (candidates.has(el) || typeof el.onclick === 'function') && visible(el)) { total++; if (listed.size < room) listed.add(el); }
      if (el.shadowRoot && visible(el)) visit(el.shadowRoot);
    }
  };
  for (const scope of scopes) visit(scope);
  const prose = []; let left = Math.max(0, limit);
  for (const root of roots) { if (!left) break; const content = (root.body?.innerText || (root.nodeType === 11 ? [...root.childNodes].map(node => node.nodeType === 3 ? node.textContent : node.nodeType === 1 && visible(node) ? node.innerText || '' : '').join('\n') : root.nodeType === 1 ? root.innerText : '') || '').slice(0, left); prose.push(content); left -= content.length; }
  const elements = [...listed].map(el => {
    let local = refs.nums.get(el); if (!local) { local = refs.next++; refs.nums.set(el, local); } refs.els.set(local, new WeakRef(el));
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
    return { local, role, name, ...state, inViewport: inView && r.bottom > 0 && r.right > 0 && r.top < w.innerHeight && r.left < w.innerWidth };
  });
  return { title: document.title, url: location.href, text: prose.join('\n'), elements, total, doc: refs.doc, captcha };
};
/** Add one frame's CAPTCHA read to what the whole tab shows. */
const noteCaptcha = (seen, answers, read, row) => {
  for (const vendor of read?.found || []) seen.push({ vendor, row, element: true });
  for (const [vendor, filled] of Object.entries(read?.answers || {})) answers[vendor] ||= filled;
};
const describe = e => `[${e.ref}] ${e.role} ${JSON.stringify(e.name)}${e.disabled ? ' disabled' : ''}${e.checked != null ? ` checked=${e.checked}` : ''}${e.expanded != null ? ` expanded=${e.expanded}` : ''}${e.selected != null ? ` selected=${e.selected}` : ''}${e.current ? ` current=${e.current}` : ''}${e.value != null ? ` value=${JSON.stringify(e.value)}` : ''}${!e.inViewport ? ' offscreen' : ''}`;
// CAPTCHA frames, known by their address: [vendor, hosts (and their subdomains), path start].
const CAPTCHA_FRAMES = [
  ['recaptcha', ['google.com', 'recaptcha.net'], '/recaptcha/'], ['hcaptcha', ['hcaptcha.com']], ['turnstile', ['challenges.cloudflare.com']],
  ['arkose', ['arkoselabs.com', 'funcaptcha.com']], ['geetest', ['geetest.com']], ['datadome', ['captcha-delivery.com']],
  ['perimeterx', ['perimeterx.net', 'px-cdn.net', 'px-cloud.net']], ['awswaf', ['awswaf.com']],
];
export const CAPTCHA_NAMES = { recaptcha: 'reCAPTCHA', hcaptcha: 'hCaptcha', turnstile: 'Cloudflare Turnstile', cloudflare: 'Cloudflare check', arkose: 'Arkose', geetest: 'GeeTest', datadome: 'DataDome', perimeterx: 'PerimeterX', awswaf: 'AWS WAF' };
/** The CAPTCHA a frame at this address shows, or null. A frame for an invisible check (no person solves it) is not one. */
export const captchaVendor = address => {
  let url; try { url = new URL(address); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const rule = CAPTCHA_FRAMES.find(([, hosts, path]) => hosts.some(name => host === name || host.endsWith(`.${name}`)) && (!path || url.pathname.startsWith(path)));
  if (!rule || /size=invisible|checkbox-invisible/.test(url.search + url.hash)) return null;
  return rule[0];
};
/** What a read saw: the first CAPTCHA, and if one of its answer fields has a value. */
const captchaState = (seen, answers) => seen.length ? { vendor: seen[0].vendor, solved: seen.some(s => answers[s.vendor] === true) } : null;
const captchaLine = (captcha, tabId) => `A CAPTCHA (${CAPTCHA_NAMES[captcha.vendor]}) shows on this page. Do not solve it yourself. Run helm browser captcha ${tabId}: the owner solves it, then you continue.`;
const NO_SCREEN = 'This machine has no screen, so the owner cannot see this page or solve the CAPTCHA. Tell the owner the site asks for a CAPTCHA, or try another way.';
// Steps that only read the page. Any other step can change it.
const READS = ['look', 'console', 'network', 'screenshot', 'point', 'check', 'wait'];
const changesPage = kind => !READS.includes(kind);
const readsOnly = action => { action = normalizeAction(action); return action.kind === 'batch' ? Array.isArray(action.actions) && action.actions.every(readsOnly) : !changesPage(action.kind); };
/** A timed-out call in plain words: did a step reach the page, and what was not run. */
const timedOut = op => {
  if (!op.started) return 'The browser action timed out before it reached the page. Nothing was done.';
  const { batch, step } = op;
  const where = step ? (batch ? `during step ${step.index} (${step.kind})` : `during the ${step.kind} step`) : op.done < op.total ? `before step ${op.done + 1}` : 'while it read the page after the last step';
  const landed = !step ? '' : changesPage(step.kind) ? ' That step may have landed.' : ' That step only reads the page.';
  const next = op.done + (step ? 2 : 1), skipped = !batch || next > op.total ? '' : next === op.total ? ` Step ${next} was not run.` : ` Steps ${next}–${op.total} were not run.`;
  return `The browser action timed out ${where}.${landed}${batch ? ` ${op.done} of ${op.total} steps finished.` : ''}${skipped} Read the page before you try again.`;
};

/**
 * A thread's browser. On a machine with a screen it is a real Chromium
 * window, one per thread, that never takes the owner's keyboard: the agent
 * drives it through Chromium's own channel. Without a screen (a server) it
 * is one shared hidden Chromium. Nothing starts until a tab is used.
 */
let ownerLogins = false;
/** Only the Helm service starts browsers with the owner's own logins; tests never read real profiles. */
export const useOwnerLogins = () => { ownerLogins = true; };

/**
 * Agent tabs in Helm's window sit in the background, where Chromium stops
 * drawing and slows timers. A tiny screen feed keeps frames coming, so
 * animations, games and Playwright's "is it still moving" checks still run.
 * Each new document drops the feed, so it starts again after each page load.
 */
async function keepDrawing(page) {
  let cdp; try { cdp = await page.context().newCDPSession(page); } catch { return; }
  cdp.on('Page.screencastFrame', ({ sessionId }) => void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}));
  const start = () => Promise.all([
    cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
    cdp.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 60 }),
  ]).catch(() => {});
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) void start(); });
  await start();
}

export class BrowserManager {
  constructor({ directory = join(HELM_DIR, 'browser'), session = () => null, launch, now = Date.now, idleMs = 10 * 60000, windowIdleMs = 10 * 60000, actionTimeoutMs = CALL_MS, logins = browserLogins, launchWindow = openWindow, canWindow = canOpenWindow, ownerQuietMs = 2500, extensionWaitMs = 4000, browsers = discoverBrowsers, mode = null, setupTools = { copyText, openExtensionsPage }, startOwn = startOwnBrowser, alert = () => {} } = {}) {
    // Tells the owner a chat needs them, and takes the notice away when it does not.
    this.setupTools = setupTools; this.startOwn = startOwn; this.alert = alert;
    // `mode` sets the browser mode for this run only (tests); else the saved choice counts.
    this.extensionWaitMs = extensionWaitMs; this.browsers = browsers; this.modeChoice = mode;
    this.launchWindow = launchWindow; this.windowCheck = canWindow; this.ownerQuietMs = ownerQuietMs; this.windowContexts = new Map(); this.windowIdleMs = windowIdleMs;
    this.logins = logins; this.loginImports = new Map(); this.directory = directory; this.session = session; this.launch = launch; this.now = now; this.idleMs = idleMs; this.actionTimeoutMs = actionTimeoutMs; this.tabs = new Map(); this.contexts = new Map(); this.serial = new Map(); this.recovered = new Map(); this.suspending = new Set(); this.browser = null;
    this.flows = new BrowserFlows(directory);
  }
  /** A screen can appear after Helm starts, when its service starts before the desktop. Once seen, windows stay on. */
  get canWindow() { return this.screenSeen ||= !!(typeof this.windowCheck === 'function' ? this.windowCheck() : this.windowCheck); }
  /** Extended mode: agents use the owner's own browser through Helm's add-on. It needs a screen. */
  get mode() { return this.modeChoice ||= readMode(this.directory); }
  get extended() { return this.mode === 'extended' && this.canWindow; }
  /** The link the add-on connects to. It runs whenever extended mode is on, so the add-on finds Helm. */
  startRelay() {
    if (this.relayStart) return this.relayStart;
    const changed = syncExtension(this.extensionDirectory());
    // An add-on with another version loads this Helm's copy as it connects.
    this.relay ||= new ExtensionRelay({ linkFile: linkFile(this.extensionDirectory()), extensionId: EXTENSION_ID, version: EXTENSION_VERSION });
    this.relayAt = Date.now();
    return this.relayStart = this.relay.start().then(relay => {
      // A changed add-on came with this Helm: the browser loads it again.
      if (changed) void relay.waitForExtension(60000).then(on => on && relay.callAll('reload', {}));
      return relay;
    }, error => { this.relayStart = null; throw error; });
  }
  /**
   * At start: extended mode opens the link at once, so the browser reconnects
   * after a restart. The Helm service also names the add-on in the browser's
   * flags file, so the browser loads it on its next start. Test copies never
   * touch the owner's browser.
   */
  async prepare({ install = !process.env.HELM_NO_SERVICE && !process.env.NODE_TEST_CONTEXT } = {}) {
    if (this.mode !== 'extended') return;
    await this.startRelay();
    if (install) { try { const browser = this.ownBrowser(); if (browser) setBrowserExtension(browser, extensionFolder(this.extensionDirectory()), true); } catch { /* the browser stays as it is */ } }
  }
  /**
   * Why the owner's browser is not connected, and what the agent does. Until
   * it connects, the chats' tabs open in Helm's own window.
   */
  ownBrowserSteps() {
    const browser = this.ownBrowser();
    if (!browser) return ['Helm found no Chromium-based browser on this machine. Your tabs open in Helm\'s window.'];
    // The owner sets it up from Settings, when it suits them: never stop the task for it.
    if (browser.manual) return [`${browser.name} needs one step from the owner before you can use it. Do the task in Helm's window now. At the end, tell the owner once: in Helm, open Settings, choose this machine, and click Set up under Your browser.`];
    if (!ownBrowserPids(browser.processProgram || browser.program).length) return [`${browser.name} is closed, and Helm could not start it. Your tabs open in Helm's window until ${browser.name} runs. If a site is not signed in, ask the owner to open ${browser.name}.`];
    // Never interrupt the owner: the browser loads the add-on on its own next start.
    return [`${browser.name} loads the Helm add-on the next time it starts. Until then your tabs open in Helm's window: if a site is not signed in, run helm browser logins "<profile>". Never close or restart ${browser.name} yourself.`];
  }
  /** The owner's profile that wrote this add-on mark, or null. Found once per mark. */
  profileOfMark(mark, profiles) {
    this.markProfiles ||= new Map();
    if (this.markProfiles.has(mark)) return this.markProfiles.get(mark);
    const found = profileOfMark(mark, profiles);
    if (found) this.markProfiles.set(mark, found);
    return found;
  }
  /**
   * Where a chat's new tabs open in the owner's own browser: the profile the
   * agent names, else the chat's last one, else the owner's default login
   * profile, else the profile the owner used last, else the first that
   * connected. A named profile that is not open is loaded into the running
   * browser, with no window and no restart. Returns { mark, name }.
   */
  async ownProfile(sessionId, wanted) {
    const relay = this.relay; if (!relay?.connected) throw new Error(OWN_BROWSER_OFF);
    const profiles = await this.logins.listProfiles().catch(() => []);
    const same = (a, b) => !!a && !!b && a.dataDir === b.dataDir && a.directory === b.directory;
    const markOf = profile => relay.profiles.find(mark => same(this.profileOfMark(mark, profiles), profile));
    const named = profile => ({ name: profile.name && profile.name !== profile.directory ? `${profile.name} (${profile.directory})` : profile.directory });
    this.chatProfiles ||= new Map();
    if (!wanted && !this.chatProfiles.has(sessionId)) {
      let saved = null; try { saved = JSON.parse(await readFile(join(this.directory, sessionId, 'profile.json'), 'utf8')); } catch { /* none chosen */ }
      if (saved?.dataDir && saved?.directory) this.chatProfiles.set(sessionId, { dataDir: String(saved.dataDir), directory: String(saved.directory), name: String(saved.name || '') });
    }
    let profile = wanted ? await this.logins.resolveProfile(wanted) : this.chatProfiles.get(sessionId) || null;
    if (!profile) {
      const { profileKey } = await this.savedLoginDefault();
      const choice = profileKey && profiles.find(p => p.key === profileKey);
      if (choice && markOf(choice)) profile = choice;
    }
    if (!profile) {
      const last = profiles.find(p => p.lastUsed && markOf(p));
      const mark = last ? markOf(last) : relay.profiles[0];
      const known = last || this.profileOfMark(mark, profiles);
      return { mark, ...(known ? named(known) : { name: 'the first profile that connected' }) };
    }
    let mark = markOf(profile);
    if (!mark) {
      // The profile is not open: the running browser loads it. Never a restart.
      const connected = relay.profiles.map(m => this.profileOfMark(m, profiles)).find(Boolean);
      const browser = this.ownBrowser(), label = named(profile).name;
      if (connected && connected.dataDir !== profile.dataDir) throw new Error(`The profile ${label} belongs to another browser. Helm uses the browser where its add-on is connected. Never close or restart a browser yourself.`);
      if (!browser || !browserRunning(profile.dataDir)) throw new Error(`The browser of the profile ${label} is not open. Ask the owner to open it. Never start, close or restart it yourself.`);
      openProfile({ program: browser.program, launcher: browser.launcher, dataDir: profile.dataDir, directory: profile.directory, screen: screenEnv() });
      const opened = await relay.waitForExtension(this.profileWaitMs ?? 15000, m => same(this.profileOfMark(m, profiles), profile));
      mark = markOf(profile);
      if (!opened || !mark) throw new Error(`The profile ${label} did not connect to Helm. Ask the owner to open that profile in ${browser.name}. Never close or restart the browser yourself.`);
    }
    if (wanted || !this.chatProfiles.has(sessionId)) {
      const keep = { dataDir: profile.dataDir, directory: profile.directory, name: profile.name || '' };
      this.chatProfiles.set(sessionId, keep);
      const folder = join(this.directory, sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 });
      await this.writePrivate(join(folder, 'profile.json'), keep).catch(() => {});
    }
    return { mark, ...named(profile) };
  }
  /** The owner's own browser, driven through the add-on as if it were Helm's window. */
  async ownBrowserContext() {
    const relay = await this.startRelay();
    // Only a link that just opened waits for the add-on: later, Helm's window opens at once.
    let wait = Math.max(0, this.relayAt + this.extensionWaitMs - Date.now());
    // A closed browser is started with no window: agents use the owner's real
    // profile, never a copy of its logins. One start at a time.
    if (!relay.connected) {
      const browser = this.ownBrowser();
      if (browser && !browser.manual && !ownBrowserPids(browser.processProgram || browser.program).length && !(Date.now() - (this.ownStartedAt || 0) < OWN_START_MS)) {
        if (this.startOwn({ ...browser, folder: extensionFolder(this.extensionDirectory()), screen: screenEnv() })) this.ownStartedAt = Date.now();
      }
      if (Date.now() - (this.ownStartedAt || 0) < OWN_START_MS) wait = Math.max(wait, this.ownStartedAt + OWN_START_MS - Date.now());
    }
    if (!(await relay.waitForExtension(wait))) throw new Error(OWN_BROWSER_OFF);
    const { chromium } = await import('patchright-core');
    const browser = await chromium.connectOverCDP(relay.cdpUrl, { timeout: 15000 });
    const context = browser.contexts()[0];
    if (!context) { await browser.close().catch(() => {}); throw new Error(OWN_BROWSER_OFF); }
    context.helmDetach = () => browser.close(); context.helmPatched = true; context.helmOwnBrowser = true;
    // After a Helm restart the add-on still has the chats' tabs open.
    context.helmAttached = context.pages().length > 0;
    return context;
  }
  /** The owner's default browser: its program, the launcher that starts it, and its flags file. */
  ownBrowser() {
    const found = this.browsers(), choice = readChoice(this.directory).main;
    const best = found.find(b => b.name.toLowerCase() === choice?.toLowerCase()) || found.find(b => b.systemDefault) || found[0];
    if (!best) return null;
    return { ...best, launcher: best.launcher || best.program, flags: flagsFile(best.launcher || best.program), manual: manualBrowser(best) };
  }
  extensionDirectory() {
    const choice = readChoice(this.directory);
    const main = choice.extensionMain === null ? null : choice.extensionMain || choice.main;
    return main ? join(this.directory, 'main', Buffer.from(main.toLowerCase()).toString('hex')) : this.directory;
  }
  mainInfo() {
    const selected = this.ownBrowser()?.name;
    return { browser: selected || null, browsers: this.browsers().map(b => ({ name: b.name, selected: b.name === selected, systemDefault: !!b.systemDefault })) };
  }
  async setMain(name) {
    const next = this.browsers().find(b => b.name.toLowerCase() === String(name).toLowerCase());
    if (!next) throw new Error('Choose a browser from helm browser main.');
    const old = this.ownBrowser();
    if (old?.name === next.name) {
      if (!readChoice(this.directory).main) writeMain(this.directory, next.name, readChoice(this.directory).extensionMain ?? null);
      return this.modeInfo();
    }
    if (this.mode === 'extended') {
      await this.closeShared();
      setBrowserExtension(old, extensionFolder(this.extensionDirectory()), false);
      await this.relay?.stop(); this.relay = null; this.relayStart = null; this.ownStartedAt = 0;
    }
    writeMain(this.directory, next.name);
    if (this.mode === 'extended') {
      await this.startRelay();
      setBrowserExtension(this.ownBrowser(), extensionFolder(this.extensionDirectory()), true);
    }
    return this.modeInfo();
  }
  mainNote() {
    const found = this.browsers();
    return found.length > 1 && !readChoice(this.directory).main && !found.some(b => b.systemDefault)
      ? 'Ask the owner once for their main browser. Save it with helm browser main <name>. Continue the task.' : '';
  }
  /**
   * What `helm browser mode` and Settings show. `state`: connected, off
   * (Helm's window chosen), next-start (the browser loads the add-on when it
   * starts again), closed, one-step (Chrome or Edge: the owner loads it once),
   * none (no browser) or no-screen.
   */
  async modeInfo() {
    const info = { mode: this.mode, screen: this.canWindow, browsers: this.mainInfo().browsers };
    if (!this.canWindow) return { ...info, state: 'no-screen' };
    if (this.mode !== 'extended') return { ...info, state: 'off', browser: this.ownBrowser()?.name || null };
    const browser = this.ownBrowser(), relay = await this.startRelay().catch(() => null);
    const state = relay?.connected ? 'connected' : !browser ? 'none' : browser.manual ? 'one-step' : ownBrowserPids(browser.processProgram || browser.program).length ? 'next-start' : 'closed';
    return { ...info, state, connected: !!relay?.connected, browser: browser?.name || null, folder: extensionFolder(this.extensionDirectory()), flagsFile: browser?.flags || null,
      ...(relay?.connected ? {} : { steps: this.ownBrowserSteps() }) };
  }
  /**
   * Settings' Set up, for a browser that loads no add-ons from Helm (Google
   * Chrome, Edge): Helm opens its add-ons page and copies the add-on's folder,
   * so the owner turns on Developer mode, clicks Load unpacked and pastes.
   * The add-on then connects at once, with no restart.
   */
  async ownerSetup() {
    if (!this.canWindow) throw new Error('This machine has no screen, so agents use Helm\'s hidden browser.');
    const browser = this.ownBrowser(); if (!browser) throw new Error('Helm found no Chromium-based browser on this machine. Install one, for example Google Chrome or Brave.');
    if (this.mode !== 'extended') await this.setMode('extended');
    const relay = await this.startRelay();
    if (relay.connected || !browser.manual) return this.modeInfo();
    const folder = extensionFolder(this.extensionDirectory()), screen = screenEnv();
    const copied = await this.setupTools.copyText(folder, { env: { ...process.env, ...screen } });
    const opened = this.setupTools.openExtensionsPage({ ...browser, screen });
    return { ...(await this.modeInfo()), copied, opened, steps: [...(opened ? [] : [`Open chrome://extensions in ${browser.name}.`]), ...pasteSteps(), ...(copied ? [] : [`Paste this folder: ${folder}`])] };
  }
  /**
   * Switch between Helm's own window and the owner's browser. The chats'
   * tabs go to sleep and open again in the new place on their next step.
   * `restart` closes and reopens the owner's browser so it loads the add-on:
   * only after the owner agreed.
   */
  async setMode(mode, { restart = false } = {}) {
    if (mode === 'extended' && !this.canWindow) throw new Error('Extended mode needs a screen. This machine uses its hidden browser.');
    const before = this.mode; writeMode(this.directory, mode); this.modeChoice = mode;
    if (before !== mode) await this.closeShared();
    const browser = this.ownBrowser(), folder = extensionFolder(this.extensionDirectory());
    if (mode === 'window') {
      if (browser) setBrowserExtension(browser, folder, false);
      await this.relay?.stop().catch(() => {}); this.relay = null; this.relayStart = null;
      return this.modeInfo();
    }
    const relay = await this.startRelay();
    if (browser) setBrowserExtension(browser, folder, true);
    if (restart && !relay.connected) {
      if (!browser) throw new Error('Helm found no Chromium-based browser on this machine.');
      await restartOwnBrowser({ ...browser, folder, screen: screenEnv() });
      // A browser that ignores flags files (Google Chrome, Edge) never connects: the owner adds the folder by hand.
      if (!(await relay.waitForExtension(20000))) return { ...(await this.modeInfo()), steps: manualSteps(folder), note: `${browser.name} did not load the add-on from its flags file. Add it by hand.` };
    }
    return this.modeInfo();
  }
  /** Close the shared window or browser link. Each chat's tabs are saved first and come back asleep. */
  async closeShared() {
    const context = this.shared; if (!context) return;
    const sids = [...this.windowContexts].filter(([, value]) => value === context).map(([sid]) => sid);
    for (const sid of sids) { await this.persistTabs(sid).catch(() => {}); this.suspending.add(sid); }
    try {
      for (const sid of sids) { this.windowContexts.delete(sid); this.contexts.delete(sid); this.recovered.delete(sid); }
      this.shared = null; context.helmClosed = true;
      for (const tab of [...this.tabs.values()]) if (tab.page?.context?.() === context) { this.tabs.delete(tab.id); await tab.page.close().catch(() => {}); }
      if (!context.helmOwnBrowser) await stopWindow(sharedProfile(this.directory));
      await (context.helmDetach ? context.helmDetach() : context.close()).catch(() => {});
    } finally { for (const sid of sids) this.suspending.delete(sid); }
  }
  async start() {
    if (!this.starting) this.starting = (async () => {
      if (this.browser?.isConnected()) return this.browser;
      const launch = this.launch || launchChromium;
      try { this.browser = await launch(); } catch (error) { throw new Error(`The browser could not start. Install any Chromium-based browser, or set HELM_CHROMIUM_PATH. ${error.message}`); }
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
        if (!seed) { this.owner(sessionId); const choice = await this.startingProfile(); if (choice.profileKey) seed = await this.logins.readLogins(choice.profileKey, { saved: true }); }
        if (seed) { if (!seed.cookies.length && seed.failed) throw new Error(seed.warnings?.[0] || 'Could not copy the default browser logins.'); storageState = { cookies: seed.cookies, origins: [] }; }
      }
      // Set the user agent before any popup's first request. Each page also
      // receives matching client hints before an agent opens its address.
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...(browser.helmIdentity ? { userAgent: browser.helmIdentity.userAgent } : {}), ...(storageState ? { storageState } : {}) });
      context.helmPatched = !!browser.helmPatched;
      context.setDefaultTimeout(STEP_MS); context.setDefaultNavigationTimeout(NAV_MS);
      context.on('page', page => {
        const tab = this.register(sessionId, page);
        tab.prepared = presentAsChrome(page, browser.helmIdentity).then(cdp => { tab.identityCdp = cdp; });
        void tab.prepared.catch(() => {}); // The open or action request reports it.
      });
      try { if (seed) await this.saveContext(sessionId, context); } catch (error) { await context.close(); throw error; }
      return context;
    })();
    this.contexts.set(sessionId, pending);
    try { return await pending; } catch (error) { this.contexts.delete(sessionId); throw error; }
  }
  /**
   * A chat's tabs, in the one window on this machine's screen that every
   * chat shares. The window's profile folder keeps what it signed in to.
   */
  async windowContext(sessionId, loginSeed) {
    const context = await this.sharedWindow();
    if (!context.helmJoined.has(sessionId)) {
      context.helmJoined.add(sessionId);
      // The owner's own browser keeps its own logins: Helm never writes cookies there.
      if (context.helmOwnBrowser) { this.windowContexts.set(sessionId, context); return context; }
      // Sign-ins this chat made in its own window, before the window was shared.
      let storage; try { storage = JSON.parse(await readFile(join(this.directory, sessionId, 'storage.json'), 'utf8')); } catch { /* nothing signed in yet */ }
      if (storage?.cookies?.length) await context.addCookies(storage.cookies).catch(() => {});
    }
    if (loginSeed?.cookies?.length && !context.helmOwnBrowser) await context.addCookies(loginSeed.cookies).catch(() => {});
    this.windowContexts.set(sessionId, context);
    return context;
  }
  /**
   * The one window. A new window starts signed in to what the owner chose as
   * the default profile's logins. A window still open from before a restart
   * keeps its tabs; each chat takes its own back by address.
   */
  sharedWindow() {
    if (this.shared && !this.shared.helmClosed) return Promise.resolve(this.shared);
    return this.openingShared ||= (async () => {
      let context, seed;
      // Until the owner's browser connects, the chats use Helm's window.
      if (this.extended) context = await this.ownBrowserContext().catch(error => { if (error.message === OWN_BROWSER_OFF) return null; throw error; });
      if (!context) {
        const folder = sharedProfile(this.directory), fresh = !existsSync(folder); mkdirSync(folder, { recursive: true, mode: 0o700 });
        if (fresh) { const choice = await this.startingProfile(); if (choice.profileKey) seed = await this.logins.readLogins(choice.profileKey, { saved: true }).catch(() => null); }
        try { context = await this.launchWindow(folder, { name: 'helm-browser' }); }
        catch (error) { throw new Error(`The browser could not open a window. ${String(error.message).split('\n')[0]}`); }
        context.helmFallback = this.extended;
      }
      context.helmWindow = true; context.helmJoined = new Set(); context.setDefaultTimeout(STEP_MS); context.setDefaultNavigationTimeout(NAV_MS);
      try {
        if (seed?.cookies?.length) await context.addCookies(seed.cookies).catch(() => {});
        await context.exposeBinding('__helmOwnerInput', ({ page }) => this.ownerInput(page));
        await context.addInitScript(WINDOW_PAGE_SCRIPT);
      } catch (error) { await context.close().catch(() => {}); throw error; }
      // Some browser launchers open a blank tab: the first tab Helm needs takes it.
      context.helmSpare = context.helmAttached ? null : context.pages()[0] || null;
      context.helmUnclaimed = context.helmAttached ? new Set(context.pages()) : new Set();
      // A tab belongs to the chat that opened it, or to the chat whose page
      // opened it as a popup. A tab the owner opens stays theirs.
      context.on('page', page => void this.claimPage(context, page).catch(() => {}));
      context.on('close', () => void this.sharedClosed(context).catch(() => {}));
      this.shared = context;
      this.timer ||= setInterval(() => void this.sweep().catch(() => {}), 2000); this.timer.unref?.();
      return context;
    })().finally(() => { this.openingShared = null; });
  }
  /** A popup goes to the chat whose page opened it. Helm registers the tabs it opens itself. */
  async claimPage(context, page) {
    const opener = await page.opener().catch(() => null), sessionId = opener && [...this.tabs.values()].find(t => t.page === opener)?.sessionId;
    if (sessionId && this.windowContexts.get(sessionId) === context) { this.register(sessionId, page); this.persistSoon(sessionId); }
  }
  /** The owner closed the window: every chat's tabs are kept, asleep. */
  async sharedClosed(context) {
    context.helmClosed = true; if (this.shared === context) this.shared = null;
    for (const [sid, value] of [...this.windowContexts]) if (value === context) await this.windowClosed(sid, context).catch(() => {});
  }
  /** Close the window once no chat has a tab in it, unless the owner has tabs of their own there. */
  async closeIfEmpty() {
    const context = this.shared; if (!context || context.helmClosed || this.stopping) return;
    if ([...this.windowContexts.values()].includes(context)) return;
    const own = context.pages().filter(page => !page.isClosed() && ![NEW_TAB, 'about:blank', 'chrome://newtab/'].includes(page.url()));
    if (own.length) return;
    this.shared = null; context.helmClosed = true;
    if (!context.helmOwnBrowser) await stopWindow(sharedProfile(this.directory));
    await (context.helmDetach ? context.helmDetach() : context.close()).catch(() => {});
    if (!context.helmOwnBrowser) await trimProfile(sharedProfile(this.directory));
  }
  /**
   * A new tab. In a window it opens at its address: an empty tab sent
   * somewhere shows "about:blank" over a white page until the site answers,
   * while a tab Chromium opens at the address shows the address and Loading.
   * A new window's empty first tab goes once the real one is there.
   * `helmGoing` marks a page already on its way. A site that has not
   * answered within `wait` gets a plain tab that loads it, so the tab is
   * listed while the site is slow.
   */
  async newPage(context, url, { wait = 2000, profile } = {}) {
    const spare = context.helmSpare; context.helmSpare = null;
    // In the owner's browser every tab opens in the chat's profile.
    const own = !!context.helmOwnBrowser && !!profile;
    const going = context.helmWindow && url && (url !== 'about:blank' || own);
    if (spare && !spare.isClosed() && !going) return spare;
    if (!going) {
      // In Helm's window a new tab opens in the background: a foreground tab
      // makes Chromium ask the desktop for focus, and that takes it from the owner.
      const page = context.helmWindow && !context.helmOwnBrowser ? await this.windowTab(context, 'about:blank', 5000).catch(() => null) || await context.newPage() : await context.newPage();
      try { await [...this.tabs.values()].find(tab => tab.page === page)?.prepared; return page; }
      catch (error) { await page.close().catch(() => {}); throw error; }
    }
    // The owner's browser hands the tab over blank, before its site answers.
    let page; try { page = await this.windowTab(context, url, own ? Math.max(wait, 10000) : wait, own ? profile : undefined); } catch (error) { if (spare && !spare.isClosed()) context.helmSpare = spare; throw error; }
    if (!page) { if (own) throw new Error('Your browser did not open the tab in time. Try again.'); if (spare && !spare.isClosed()) return spare; return context.newPage(); }
    if (spare && !spare.isClosed()) await spare.close().catch(() => {});
    if (url !== 'about:blank') page.helmGoing = url; return page;
  }
  /**
   * Chromium opens the tab at `url` in the background, so the window never
   * takes the owner's focus; Playwright hands the page over once the site
   * first answers. Null when Chromium cannot be asked or the site is slow.
   */
  async windowTab(context, url, wait, profile) {
    const browser = context.browser?.(), first = context.pages().find(page => !page.isClosed());
    const cdp = browser ? await browser.newBrowserCDPSession() : first ? await context.newCDPSession(first) : null;
    if (!cdp) return null;
    const seen = new Map(); let want, found;
    const arrived = new Promise(resolve => { found = resolve; });
    const check = async page => {
      let session; try { session = await context.newCDPSession(page); const { targetInfo } = await session.send('Target.getTargetInfo'); seen.set(targetInfo.targetId, page); if (targetInfo.targetId === want) found(page); } catch { /* closed already */ } finally { await session?.detach().catch(() => {}); }
    };
    context.on('page', check);
    let timer;
    try {
      ({ targetId: want } = await cdp.send('Target.createTarget', { url, background: true, ...(profile ? { helmProfile: profile } : {}) }));
      if (seen.has(want)) return seen.get(want);
      const page = await Promise.race([arrived, new Promise(resolve => { timer = setTimeout(resolve, wait); timer.unref?.(); })]);
      if (page) return page;
      await cdp.send('Target.closeTarget', { targetId: want }).catch(() => {});
      return null;
    } finally { clearTimeout(timer); context.off('page', check); await cdp.detach().catch(() => {}); }
  }
  /**
   * A tab opened at its address has loaded far enough to read, or says why
   * it could not. Chromium's error page names the problem; loading the
   * address again there can leave the tab stuck, even unable to close.
   */
  async arrive(page, url) {
    await page.waitForLoadState('domcontentloaded');
    if (!page.url().startsWith('chrome-error:')) return;
    const code = await page.evaluate(() => document.querySelector('.error-code')?.textContent?.trim() || '').catch(() => '');
    throw new Error(`net::${/^DNS_PROBE/.test(code) ? 'ERR_NAME_NOT_RESOLVED' : /^ERR_[A-Z_]+$/.test(code) ? code : 'ERR_FAILED'} at ${url}`);
  }
  /** An empty tab in the window shows the New Tab page, as in any browser. */
  async blank(page) { const context = page.context?.(); if (context?.helmWindow && !context.helmOwnBrowser) await page.goto(NEW_TAB).catch(() => {}); }
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
  async profiles(sessionId) {
    this.owner(sessionId);
    const profiles = await this.logins.listProfiles();
    // In the owner's own browser: which profiles Helm's add-on is connected in.
    const open = this.extended && this.relay?.connected ? this.relay.profiles.map(mark => this.profileOfMark(mark, profiles)).filter(Boolean) : [];
    return { profiles: profiles.map(p => open.some(o => o.dataDir === p.dataDir && o.directory === p.directory) ? { ...p, connected: true } : p) };
  }
  async loginDefault(sessionId, profileKey) {
    this.owner(sessionId); const file = join(this.directory, 'logins.json');
    if (profileKey === null) { await rm(file, { force: true }); return { profileKey: null }; }
    if (profileKey !== undefined) {
      const profile = await this.logins.resolveProfile(profileKey); if (!profile.readable) throw new Error(profile.reason);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
      await this.writePrivate(file, { profileKey: profile.key }); return { profileKey: profile.key };
    }
    return this.savedLoginDefault();
  }
  /**
   * The logins a new browser starts with: the profile the owner chose, else
   * the system default browser's most recently used profile.
   */
  async startingProfile() {
    const choice = await this.savedLoginDefault(); if (choice.profileKey || !ownerLogins) return choice;
    const profiles = await this.logins.listProfiles().catch(() => []);
    return { profileKey: profiles.find(profile => profile.readable)?.key ?? null };
  }
  async savedLoginDefault() {
    try { const choice = JSON.parse(await readFile(join(this.directory, 'logins.json'), 'utf8')); return { profileKey: typeof choice.profileKey === 'string' ? choice.profileKey : null }; } catch { return { profileKey: null }; }
  }
  async importLogins(sessionId, profileKey) {
    this.owner(sessionId);
    if (this.extended && this.relay?.connected) return { cookies: 0, note: 'Your tabs use the logins of the owner\'s own browser. Nothing to copy.' };
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
    // Nothing from the owner's own browser is copied out.
    if (context.helmOwnBrowser) return;
    const folder = join(this.directory, sessionId); mkdirSync(folder, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700); await chmod(folder, 0o700);
    // A window keeps its own sign-ins in its profile folder; only its cookies
    // are copied here. Reading site storage visits every framed site in a
    // hidden tab, which flashes on the owner's screen.
    await this.writePrivate(join(folder, 'storage.json'), context.helmWindow ? { cookies: await context.cookies(), origins: [] } : await context.storageState({ indexedDB: true }));
  }
  register(sessionId, page) {
    const existing = [...this.tabs.values()].find(t => t.page === page); if (existing) return existing;
    const tab = { id: id(), sessionId, engine: 'chromium', page, title: '', console: [], network: [], downloads: [], lastUsed: this.now(), dialog: null, window: !!page.context?.().helmWindow, patched: !!page.context?.().helmPatched };
    this.tabs.set(tab.id, tab);
    if (tab.window && !page.context?.().helmOwnBrowser) void keepDrawing(page);
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
      tab.refs?.clear(); tab.refKeys?.clear(); // A new document: no old number can reach it.
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
      const restore = [];
      for (const row of rows) {
        if (row.engine !== 'chromium' || !/^[a-f0-9]{16}$/.test(row.id)) continue;
        if (this.tabs.has(row.id)) continue;
        const context = await this.context(sessionId);
        // The window stayed open through a restart: its tab is already there, loaded.
        const left = [...(context.helmUnclaimed || [])].find(page => !page.isClosed() && page.url() === row.url);
        if (left) context.helmUnclaimed.delete(left);
        const kept = left ? this.register(sessionId, left) : null;
        let address = 'about:blank'; try { address = httpUrl(row.url); } catch { /* keep the tab available to retry */ }
        restore.push({ row, context, kept, address });
      }
      // The tabs open together, each at its address. One whose site is slow
      // to answer opens empty and loads behind, as before.
      const own = restore.some(({ context, kept }) => !kept && context.helmOwnBrowser) ? await this.ownProfile(sessionId).catch(() => null) : null;
      const pages = await Promise.all(restore.map(({ context, kept, address }) => kept?.page || this.newPage(context, address, { profile: own?.mark }).catch(() => context.newPage())));
      for (const [index, { row, kept, address }] of restore.entries()) {
        const page = pages[index], tab = kept || this.register(sessionId, page);
        this.tabs.delete(tab.id); tab.id = row.id; tab.title = row.title || tab.title || ''; this.tabs.set(tab.id, tab);
        if (!tab.window && row.viewport && Number.isInteger(row.viewport.width) && row.viewport.width >= 240 && row.viewport.width <= 1920 && Number.isInteger(row.viewport.height) && row.viewport.height >= 200 && row.viewport.height <= 1200) await page.setViewportSize(row.viewport);
        for (const download of (Array.isArray(row.downloads) ? row.downloads : []).slice(-20)) {
          if (!/^[a-f0-9]{16}$/.test(download.id || '') || typeof download.name !== 'string') continue;
          const path = join(this.directory, sessionId, 'downloads', `${download.id}-${basename(download.name)}`);
          tab.downloads.push({ ...download, name: basename(download.name), path, status: download.status === 'ready' && existsSync(path) ? 'ready' : 'failed' });
        }
        if (kept) continue;
        // Loads in the background: the tab list answers now, and each page fills in as it arrives.
        if (address !== 'about:blank') { tab.url = address; tab.ready = (page.helmGoing ? this.arrive(page, address) : page.goto(address, { waitUntil: 'domcontentloaded' })).then(() => {}, () => {}); }
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
    try { const rows = JSON.parse(await readFile(join(this.directory, sessionId, 'tabs.json'), 'utf8')); return Array.isArray(rows) ? rows.filter(row => row?.engine === 'chromium' && /^[a-f0-9]{16}$/.test(row.id)) : []; } catch { return []; }
  }
  async list(sessionId) {
    this.owner(sessionId);
    const live = () => [...this.tabs.values()].filter(t => t.sessionId === sessionId).map(t => this.metadata(t));
    const answer = tabs => ({ tabs, running: !!this.browser, canWindow: this.canWindow, open: this.windowContexts.has(sessionId) });
    // A window left open through a Helm restart is taken back, tabs as they are.
    if (this.canWindow && !this.contexts.has(sessionId) && !this.stopping && (this.shared || (this.extended && this.relay?.connected ? this.relay.tabs.size : windowOpen(sharedProfile(this.directory)))) && (await this.savedRows(sessionId)).length) {
      try { await this.context(sessionId); await this.recover(sessionId); } catch { /* listed asleep below */ }
    }
    // Listing never opens a window: a closed window's tabs are listed asleep.
    if (this.canWindow && !this.contexts.has(sessionId)) return answer([...live(), ...(await this.savedRows(sessionId)).filter(row => !this.tabs.has(row.id)).map(row => ({ ...row, asleep: true }))]);
    await this.recover(sessionId); return answer(live()); }
  /**
   * Open a tab for a chat. `profile` names the owner's browser profile: in
   * the owner's own browser the tab opens there, else Helm's window first
   * copies that profile's logins.
   */
  async open(sessionId, { url = 'about:blank', profile } = {}) {
    await this.recover(sessionId); url = httpUrl(url);
    if (profile != null && (typeof profile !== 'string' || !profile.trim())) throw new Error('name a browser profile, for example --profile work');
    let context = await this.context(sessionId), place = null;
    if (context.helmOwnBrowser) place = await this.ownProfile(sessionId, profile);
    else if (profile) { await this.importLogins(sessionId, profile); context = await this.context(sessionId); }
    const page = await this.newPage(context, url, { profile: place?.mark });
    const tab = this.register(sessionId, page);
    try { if (url !== 'about:blank') await (page.helmGoing ? this.arrive(page, url) : page.goto(url, { waitUntil: 'domcontentloaded' })); else await this.blank(page); await this.settle(tab, { navigation: true }); tab.title = await page.title(); await this.persistTabs(sessionId); return { tab: this.metadata(tab), ...(place ? { profile: place.name } : {}), ...(this.mainNote() ? { mainBrowserNote: this.mainNote() } : {}), ...(context.helmFallback ? { note: `This tab opened in Helm's window, not in the owner's browser. ${this.ownBrowserSteps().join(' ')}` } : {}), ...(await this.look(tab)) }; }
    catch (error) { tab.explicitClose = true; await page.close(); throw /net::ERR_|Timeout \d+ms/.test(error.message) ? new Error(plainNavError(error, url)) : error; }
  }
  get(sessionId, tabId) { this.owner(sessionId); const tab = this.tabs.get(tabId); if (!tab || tab.sessionId !== sessionId) throw new Error('browser tab not found in this thread'); return tab; }
  async run(sessionId, tabId, action) {
    action = normalizeAction(action);
    await this.recover(sessionId);
    const tab = this.get(sessionId, tabId);
    // A modal dialog blocks the browser action that created it, so answering
    // it, or checking it, skips that queue.
    if (action?.kind === 'dialog' || action?.kind === 'check' && tab.dialog) {
      if (action.kind === 'dialog' && ['read', 'readonly', 'plan'].includes(this.owner(sessionId).mode)) throw new Error('this thread is read-only; browser actions that change the page are disabled');
      tab.lastUsed = this.now();
      try { return await this.perform(tab, action); } catch (error) { if (!error.check) throw error; return { error: error.message, check: error.check, tab: this.metadata(tab), ...(action.look === false ? {} : await this.snapshot(tab)) }; }
    }
    const previous = this.serial.get(tab.id) || Promise.resolve();
    // What this call is doing now, so a timeout can say if a step reached the page.
    // A batch's "timeout" is for the whole call; a single step's is for that step.
    const batch = action.kind === 'batch', asked = action.timeout == null ? null : integer(action.timeout, 1, MAX_MS);
    const limit = batch ? asked ?? this.actionTimeoutMs : Math.max(this.actionTimeoutMs, asked == null ? 0 : asked + 5000);
    const op = { deadline: Date.now() + limit, expired: false, started: false, step: null, done: 0, batch, total: batch && Array.isArray(action.actions) ? action.actions.length : 1 };
    const expired = () => new Error('The browser action timed out before it reached the page. Nothing was done.');
    let timer;
    const operation = previous.catch(() => {}).then(async () => {
      if (op.expired || Date.now() >= op.deadline) throw expired();
      const owner = this.owner(sessionId);
      if (['read', 'readonly', 'plan'].includes(owner.mode)) {
        if (!readOnlyAction(action)) throw new Error('this thread is read-only; browser actions that change the page are disabled');
      }
      // A step from a call that timed out can still land. Until it ends,
      // only reads may run, so two inputs never reach the page together.
      const stuck = [...(tab.working || [])].find(other => other.step && changesPage(other.step.kind));
      if (stuck && !readsOnly(action)) throw new Error(`An earlier ${stuck.step.kind} step is still running in the page, so this action was not run. Read the page, wait, or close the tab.`);
      tab.lastUsed = tab.actedAt = this.now();
      // Wait for a restored page before the agent uses it.
      if (tab.ready) { await tab.ready; tab.ready = null; }
      await tab.prepared;
      // In a window the owner may be using the page themselves: the agent
      // lets them finish rather than typing over them.
      const shared = tab.window;
      if (shared && !readOnlyAction(action)) await this.ownerQuiet(tab);
      if (op.expired || Date.now() >= op.deadline) throw expired();
      let result;
      if (shared) tab.agentActing = true;
      (tab.working ||= new Set()).add(op); op.started = true; op.step = batch ? null : { kind: action.kind };
      try { result = await this.perform(tab, action, false, op); }
      catch (error) { if (!error.candidates && !error.check) throw error; result = { error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.check ? { check: error.check } : {}), ...(error.check && action.look === false ? {} : await (error.check ? this.snapshot(tab) : this.look(tab))) }; }
      finally { tab.working.delete(op); op.step = null; if (shared) { tab.agentActing = false; tab.agentDoneAt = this.now(); } }
      if (!['look', 'console', 'network', 'screenshot', 'point'].includes(action?.kind)) { if (['navigate', 'back', 'forward', 'reload', 'batch'].includes(action?.kind)) await this.persistTabs(sessionId); else this.persistSoon(sessionId); }
      return result;
    });
    const job = Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { op.expired = true; reject(new Error(timedOut(op))); }, limit); timer.unref?.(); })]);
    // A reply timeout does not stop a browser command already in flight.
    // Give it one more action timeout to finish before allowing recovery
    // commands through: an evaluate call can otherwise block the tab forever.
    // Page changes stay refused while its input step is still running.
    let release;
    const grace = new Promise(resolve => { release = resolve; });
    const graceTimer = setTimeout(release, 2 * limit); graceTimer.unref?.();
    const serial = Promise.race([operation, grace]);
    this.serial.set(tab.id, serial);
    void serial.finally(() => {
      clearTimeout(graceTimer);
      if (this.serial.get(tab.id) === serial) this.serial.delete(tab.id);
    }).catch(() => {});
    try { return await job; } finally { clearTimeout(timer); }
  }
  /**
   * The page as text and numbered controls, from every frame a person can
   * see. A number always means one element: a later read never gives it to
   * another. A read lists at most 300 controls and says when it cut the
   * list; `within` (a CSS selector) or `frame` (its number, or part of its
   * address) reads the rest.
   */
  async look(tab, budget = 6000, { within, frame: only, wait = STEP_MS } = {}) {
    integer(budget, 0, 20000);
    if (within != null) text(within, 2000);
    // A modal dialog stops every page read until it is answered.
    if (tab.dialog) return { text: `${tab.title}\n${tab.page.url()}\nA dialog is open (${tab.dialog.type()}): ${JSON.stringify(tab.dialog.message().slice(0, 2000))}. Answer it with {"dialog":"accept"} or {"dialog":"dismiss"}, then read the page.`, elements: [] };
    let frames = (await this.frames(tab, wait)).map((row, number) => ({ ...row, number }));
    if (only != null) {
      const chosen = typeof only === 'number' ? frames[only] : frames.find(row => row.number > 0 && row.frame.url().includes(text(only, 2000)));
      if (!chosen) throw new Error(`frame ${JSON.stringify(only)} is not on the page; look at the page again`);
      frames = [chosen];
    }
    // A tab number stands for one element of one frame document, so a late or
    // overlapping read can never give two elements the same number.
    tab.refs ||= new Map(); tab.refKeys ||= new Map(); tab.nextRef ||= 1;
    for (const [ref, held] of tab.refs) if (held.frame.isDetached()) { tab.refs.delete(ref); tab.refKeys.delete(`${held.doc}:${held.local}`); }
    const prose = [], lines = [], elements = [], quiet = [], seen = [], answers = {}; let total = 0, page;
    for (const row of frames) {
      if (row.unknown) { quiet.push(row.number); continue; }
      const framed = row.number > 0 && captchaVendor(row.frame.url()); if (framed) seen.push({ vendor: framed, row });
      const reading = row.frame.evaluate(readFrame, { limit: budget - prose.join('\n').length, room: 300 - elements.length, within: within ?? null, inView: row.inView });
      // A busy frame inside the page does not hold up the whole read.
      const read = row.number === 0 ? await reading : await frameAnswer(reading, wait);
      if (!read) { quiet.push(row.number); continue; }
      if (read.error) throw new Error(read.error);
      if (row.number === 0) page = read;
      noteCaptcha(seen, answers, read.captcha, row);
      total += read.total ?? read.elements.length;
      if (read.text) prose.push(read.text);
      if (read.elements.length && (row.number > 0 || only != null)) lines.push(`Frame ${row.number} ${row.frame.url()}:`);
      for (const { local, ...shown } of read.elements) {
        const key = `${read.doc}:${local}`; let ref = tab.refKeys.get(key);
        if (!ref) { ref = tab.nextRef++; tab.refKeys.set(key, ref); }
        tab.refs.set(ref, { frame: row.frame, doc: read.doc, local });
        const element = { ref, ...shown }; elements.push(element); lines.push(describe(element));
      }
    }
    page ||= { title: await tab.page.title().catch(() => tab.title), url: tab.page.url() };
    tab.title = page.title;
    if (quiet.length) lines.push(`Frame ${quiet.join(', ')} did not answer and is not listed.`);
    const cut = total > elements.length ? { shown: elements.length, total } : null;
    if (cut) lines.push(`Showing ${cut.shown} of ${cut.total} controls. Read the rest with a look that has "within" (a CSS selector) or "frame" (a frame number).`);
    const captcha = captchaState(seen, answers), warn = captcha && !captcha.solved ? `${captchaLine(captcha, tab.id)}\n` : '';
    return { text: `${page.title}\n${page.url}\n${warn}${prose.join('\n').slice(0, budget)}\n\n${lines.join('\n')}`, elements, ...(cut ? { cut } : {}), ...(quiet.length ? { quiet } : {}), ...(captcha ? { captcha } : {}) };
  }
  /** The page after a check, with its own time: a page that cannot answer does not hold the check's reply. */
  async snapshot(tab, budget = 6000) {
    return await frameAnswer(this.look(tab, budget), STEP_MS) || { text: `${tab.title}\n${tab.page.url()}\nThe page did not answer in ${STEP_MS} ms, so it is not shown.`, elements: [] };
  }
  /** The CAPTCHA a tab shows now, read cheaply. `unsure` when part of the page did not answer. */
  async captchaNow(tab) {
    const seen = [], answers = {}; let unsure = false;
    for (const [number, row] of (await this.frames(tab, STEP_MS)).entries()) {
      if (row.unknown) { unsure = true; continue; }
      const framed = number > 0 && captchaVendor(row.frame.url()); if (framed) seen.push({ vendor: framed, row });
      const read = await frameAnswer(row.frame.evaluate(readFrame, { captchaOnly: true }), STEP_MS);
      if (!read) { unsure = true; continue; } noteCaptcha(seen, answers, read.captcha, row);
    }
    return { captcha: captchaState(seen, answers), seen, unsure };
  }
  /**
   * The owner solves a CAPTCHA; Helm never does. The first call points at it
   * and tells the owner. Each call reads the tab until the CAPTCHA is solved
   * or gone, for at most `wait` ms, and then says it is still waiting. It only
   * reads, so it skips the tab's queue and works in read-only chats. `last`
   * ends the wait when the CAPTCHA is still there.
   */
  async captcha(sessionId, tabId, { wait = CAPTCHA_SLICE_MS, last = false } = {}) {
    await this.recover(sessionId);
    const tab = this.get(sessionId, tabId); wait = integer(wait, 0, CAPTCHA_SLICE_MS);
    if (tab.dialog) throw new Error(`A dialog is open on this tab (${tab.dialog.type()}). Answer it first, then run helm browser captcha again.`);
    if (tab.ready) { await tab.ready; tab.ready = null; }
    let now = await this.captchaNow(tab), state = tab.captchaWait;
    // A wait nobody asked about for a while (the agent stopped) starts again.
    if (state && Date.now() - state.polled > 2 * CAPTCHA_SLICE_MS) { this.endCaptcha(tab); state = null; }
    if (!state) {
      if (!now.captcha) return { captcha: null, note: 'No CAPTCHA shows on this tab. Continue your task.', tab: this.metadata(tab) };
      const { vendor } = now.captcha;
      if (now.captcha.solved) return { solved: true, vendor, seconds: 0, tab: this.metadata(tab), ...(await this.snapshot(tab)) };
      if (!tab.window) return { solved: false, vendor, seconds: 0, note: NO_SCREEN, tab: this.metadata(tab) };
      state = tab.captchaWait = { vendor, started: this.now(), polled: Date.now(), tag: `helm-captcha-${sessionId}-${tab.id}-${Date.now().toString(36)}` };
      await this.pointCaptcha(tab, now.seen).catch(() => {});
      try { this.alert({ sessionId, tabId: tab.id, vendor, tag: state.tag }); } catch { /* the pointer still shows the owner */ }
    }
    const end = Date.now() + wait, seconds = () => Math.round((this.now() - state.started) / 1000);
    const finish = async (solved, note) => {
      this.endCaptcha(tab);
      if (this.tabs.get(tab.id) !== tab) return { solved, vendor: state.vendor, seconds: seconds(), note };
      if (solved) await this.settle(tab);
      return { solved, vendor: state.vendor, seconds: seconds(), ...(note ? { note } : {}), tab: this.metadata(tab), ...(await this.snapshot(tab)) };
    };
    // Gone counts after two reads in a row, so a page that loads again does not end the wait.
    for (let gone = 0; ;) {
      tab.lastUsed = this.now(); state.polled = Date.now();
      if (this.tabs.get(tab.id) !== tab) return finish(false, 'The tab closed before the CAPTCHA was solved.');
      if (now.captcha?.solved) return finish(true);
      gone = !now.captcha && !now.unsure ? gone + 1 : 0;
      if (gone >= 2) return finish(true);
      if (Date.now() >= end) break;
      await pause(Math.min(500, end - Date.now()));
      now = await this.captchaNow(tab);
    }
    if (last) return finish(false, `The owner did not solve the CAPTCHA in ${seconds()} s. Ask the owner what to do.`);
    return { waiting: true, vendor: state.vendor, seconds: seconds() };
  }
  /** Point at the CAPTCHA for the owner: its element, or the frame it shows in. */
  async pointCaptcha(tab, seen) {
    for (const { row, element } of seen) {
      const handle = element ? (await row.frame.evaluateHandle(() => window.__helmCaptcha?.isConnected ? window.__helmCaptcha : null)).asElement() : await row.frame.frameElement();
      if (!handle) continue;
      await handle.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      return this.aim(tab, { kind: 'point', handle, note: 'Solve this check, then Helm continues.' });
    }
  }
  /** The wait ended: the pointer and the owner's notice go. */
  endCaptcha(tab) {
    const state = tab.captchaWait; if (!state) return; tab.captchaWait = null;
    try { this.alert({ sessionId: tab.sessionId, tabId: tab.id, vendor: state.vendor, tag: state.tag, resolve: true }); } catch { /* already gone */ }
    if (tab.pointer?.by === 'guide') { tab.pointer = null; void tab.page.evaluate(clearPointer).catch(() => {}); }
  }
  /** A control named in plain words. One that is not there yet gets until `ms` to appear; a tie fails at once. */
  async find(tab, target, purpose, ms) {
    const until = Date.now() + ms;
    for (;;) {
      const { elements } = await this.look(tab, 0);
      try { return resolveTarget(target, elements, purpose); } catch (error) { if (error.candidates?.[0]?.score || Date.now() >= until) throw error; }
      await pause(Math.min(100, until - Date.now()));
    }
  }
  /**
   * The tab's frames a person can see, outer first. Cross-origin frames are
   * read through their own targets. A frame whose place cannot be read in
   * `wait` (a busy parent frame) is kept as unknown, without its children.
   */
  async frames(tab, wait = STEP_MS) {
    // One deadline for the whole search: frames not reached in time are unknown.
    const rows = [{ frame: tab.page.mainFrame(), inView: true }], end = Date.now() + wait;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].unknown) continue;
      const children = rows[i].frame.childFrames();
      const places = Date.now() >= end ? children.map(() => null) : await Promise.all(children.map(child => frameAnswer(child.frameElement().then(async handle => { try { return await handle.evaluate(frameBox); } finally { await handle.dispose(); } }).catch(() => child.isDetached() ? { visible: false } : null), Math.max(1, end - Date.now()))));
      children.forEach((child, k) => { if (!places[k]) rows.push({ frame: child, unknown: true }); else if (places[k].visible) rows.push({ frame: child, inView: rows[i].inView && places[k].inView }); });
    }
    return rows;
  }
  /** Does the check hold now? True, false, or null when a frame that could hold the answer did not answer by `until`. */
  async holds(tab, want, until = Date.now() + STEP_MS) {
    if (want.url != null && !tab.page.url().includes(want.url)) return false;
    if (want.dialog != null && !(tab.dialog && (want.dialog === true || tab.dialog.message().includes(want.dialog)))) return false;
    if (want.text == null && want.target == null) return true;
    if (tab.dialog) throw new Error('a dialog is open; answer it first, or check {"dialog": true}');
    const wait = () => Math.max(1, until - Date.now());
    // Every read gets only the time left; a page that cannot answer leaves the check unknown.
    let view; const controls = async () => view ||= await frameAnswer(this.look(tab, 0, { wait: wait() }), wait());
    if (want.text != null) {
      let seen = false, unsure = false;
      for (const row of await this.frames(tab, wait())) {
        const has = row.unknown ? null : await frameAnswer(row.frame.evaluate(hasText, want.text), wait());
        if (has) { seen = true; break; } if (has == null) unsure = true;
      }
      if (!seen) { const read = await controls(); if (!read) return null; if (!(scoreTargets(want.text, read.elements)[0]?.score >= 800)) return unsure || read.quiet ? null : false; }
    }
    if (want.target != null) {
      const read = await controls(); if (!read) return null;
      const { elements, quiet } = read; let control; try { control = resolveTarget(want.target, elements); } catch (error) { if (error.candidates?.[0]?.score) throw error; return quiet ? null : false; }
      if (want.value != null) {
        // The list shows the first 180 characters; the check reads the whole value.
        if (control.value === undefined) throw new Error(`check cannot read the value of ${JSON.stringify(want.target)}`);
        const value = await frameAnswer(this.target(tab, { ref: control.ref }).then(async field => { try { return await field.evaluate(el => String(el.value ?? '')); } finally { await field.dispose(); } }), wait());
        if (value == null) return null; if (value !== want.value) return false;
      }
      if (want.checked != null && control.checked !== want.checked) return false;
    }
    return true;
  }
  async target(tab, action) {
    if (action.handle) return action.handle;
    if (action.ref != null) {
      integer(action.ref, 1, Number.MAX_SAFE_INTEGER);
      const gone = () => new Error(`element ${action.ref} is not on the page now; look at the page again`);
      const held = tab.refs?.get(action.ref); if (!held || held.frame.isDetached()) throw gone();
      const handle = await held.frame.evaluateHandle(({ doc, local }) => { const refs = window.__helmRefs, el = refs?.doc === doc ? refs.els.get(local)?.deref() : null; return el?.isConnected ? el : null; }, { doc: held.doc, local: held.local }), element = handle.asElement();
      if (!element) { await handle.dispose(); throw gone(); }
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
  async settle(tab, { navigation = false } = {}) {
    if (tab.engine !== 'chromium' || !tab.fetching || tab.dialog) return;
    const start = Date.now(), deadline = start + 3000;
    // Pictures and adverts can hold the load event back for seconds after the
    // text is there: a page that has fetched nothing for half a second is ready.
    await Promise.race([tab.page.waitForLoadState('load', { timeout: 3000 }).catch(() => {}), this.quiet(tab, deadline, 500, start)]);
    if (navigation || tab.dialog || Date.now() >= deadline) return;
    await this.quiet(tab, deadline, 150);
  }
  /** No fetch in flight and none started or ended for `ms`, counted from `since`. */
  quiet(tab, deadline, ms, since = 0) {
    return new Promise(resolve => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        const remaining = deadline - Date.now(), quiet = ms - (Date.now() - Math.max(tab.quietAt, since));
        if (tab.dialog || remaining <= 0 || !tab.fetching.size && quiet <= 0) { tab.settleWaiters.delete(wake); resolve(); return; }
        timer = setTimeout(wake, Math.min(remaining, tab.fetching.size ? remaining : Math.max(1, quiet)));
      };
      (tab.settleWaiters ||= new Set()).add(wake); wake();
    });
  }
  async listFlows(sessionId) { this.owner(sessionId); return this.flows.list(); }
  async runFlow(sessionId, tabId, name, values) { this.owner(sessionId); const flow = await this.flows.load(name); return this.run(sessionId, tabId, { actions: flow.actions, with: values }); }
  // "look": false on a step or batch skips the page read after it (helm browser script). A step that fails still reads the page.
  async perform(tab, action, inBatch = false, op = null) {
    action = normalizeAction(action);
    const kind = action.kind;
    if (kind === 'look') return { tab: this.metadata(tab), ...(await this.look(tab, action.budget ?? 6000, action)) };
    if (kind === 'console') return this.readConsole(tab);
    if (kind === 'network') return { entries: tab.network };
    if (kind === 'screenshot') return this.capture(tab, action);
    if (kind === 'batch') {
      if (!Array.isArray(action.actions) || action.actions.length > 40 || action.actions.some(a => normalizeAction(a).kind === 'batch')) throw new Error('a batch holds at most 40 nonnested actions');
      integer(action.budget ?? 6000, 0, 20000);
      if (action.save_as != null) validateFlow(action.actions, action.save_as, action.note);
      const actions = fillParams(action.actions, action.with ?? {}), results = [];
      for (const [index, raw] of actions.entries()) {
        // The call timed out and its caller has the answer: deliver nothing more.
        if (op?.expired) return { results, stopped: true };
        try { const step = normalizeAction(raw); if (op) op.step = { index: index + 1, kind: step.kind }; results.push(await this.perform(tab, step, true, op)); if (op) { op.step = null; op.done = index + 1; } } catch (error) { return { results, failedAt: results.length, error: error.message, ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.check ? { check: error.check } : {}), ...(await (error.check ? this.snapshot(tab, action.budget ?? 6000) : this.look(tab, action.budget ?? 6000))) }; } }
      const result = { results, ...(action.look === false ? {} : await this.look(tab, action.budget ?? 6000)) };
      if (action.save_as != null) { try { if (await this.flows.save(action.save_as, action.actions, action.note, result)) result.saved = action.save_as; } catch (error) { result.saveError = `Steps succeeded, but the flow could not be saved: ${error.message}`; } }
      return result;
    }
    if (kind === 'check') {
      if (action.expect != null && typeof action.expect !== 'boolean') throw new Error('check expect must be true or false');
      // The page can still be changing: the check reads again until it holds or its time ends.
      // A condition seen only after the deadline does not count; null means part of the page could not be read.
      const want = checkSpec(action.check), expect = action.expect ?? true, ms = stepTime(action, op, STEP_MS), until = Date.now() + ms;
      let found = null;
      for (;;) {
        const seen = await this.holds(tab, want, until);
        if (Date.now() > until || op?.expired) break;
        found = seen; if (found === expect || Date.now() >= until) break;
        await pause(Math.min(100, until - Date.now()));
      }
      const check = { check: action.check, found, expect, pass: found === expect };
      if (!check.pass) { const error = new Error(`check failed: ${JSON.stringify(action.check)} ${found === null ? 'could not be checked: part of the page did not answer' : expect ? 'did not come' : 'did not go away'} in ${ms} ms`); error.check = check; throw error; }
      // While a dialog is open the page cannot be read: the tab says what the dialog shows.
      return { ...check, ...(!inBatch ? { tab: this.metadata(tab), ...(action.look === false ? {} : await this.snapshot(tab, 20000)) } : {}) };
    }
    const page = tab.page;
    // Resolve a plain target once. Both the pointer and the action use the
    // same element, without reading the whole page a second time.
    // An upload may name its field by CSS, like input[type=file]: such fields are often hidden.
    if (kind === 'upload' && typeof action.target === 'string' && /[[\]#=>]/.test(action.target) && !action.selector) action = { ...action, selector: action.target, target: undefined };
    // One deadline for the whole step: finding the control, the pointer and the input share it.
    const budget = stepTime(action, op, ['navigate', 'back', 'forward', 'reload', 'wait'].includes(kind) ? NAV_MS : STEP_MS), stepEnd = Date.now() + budget;
    const left = () => Math.max(1, stepEnd - Date.now());
    // No input goes out once the call timed out or this step used its time.
    const stop = message => Object.assign(new Error(message), { stopped: true });
    const live = () => {
      if (op?.expired) throw stop('The call timed out, so this step sent no input.');
      if (Date.now() >= stepEnd) throw stop(`${kind}: the step used its ${budget} ms before this input was sent. Read the page, or give the step a longer "timeout".`);
    };
    if (typeof action.target === 'string' && !/^\d+$/.test(action.target.trim())
      && action.ref == null && !action.selector && !action.role && !action.name && action.x == null) {
      action = { ...action, ref: (await this.find(tab, text(action.target, 500), kind, left())).ref };
    }
    await this.aim(tab, action, left, live);
    if (kind === 'point') return { tab: this.metadata(tab) };
    try {
      live();
      if (['navigate', 'back', 'forward', 'reload'].includes(kind)) await this.go(tab, kind, action, left());
      else if (kind === 'stop') { const cdp = await page.context().newCDPSession(page); try { live(); await cdp.send('Page.stopLoading'); } finally { await cdp.detach().catch(() => {}); } }
      else if (kind === 'click' || kind === 'hover') {
        if (action.x != null) { const { width, height } = await this.viewSize(tab); integer(action.x, 0, width); integer(action.y, 0, height); live(); kind === 'click' ? await page.mouse.click(action.x, action.y, { button: ['left', 'right', 'middle'].includes(action.button) ? action.button : 'left', clickCount: action.double ? 2 : 1 }) : await page.mouse.move(action.x, action.y); }
        else { const target = await this.target(tab, action); try { live(); kind === 'click' ? await target.click({ button: action.button || 'left', clickCount: action.double ? 2 : 1, timeout: left() }) : await target.hover({ timeout: left() }); } finally { if (target.dispose) await target.dispose(); } }
      } else if (kind === 'drag') { const { width, height } = await this.viewSize(tab); for (const field of ['fromX', 'toX']) integer(action[field], 0, width); for (const field of ['fromY', 'toY']) integer(action[field], 0, height); live(); await page.mouse.move(action.fromX, action.fromY); live(); await page.mouse.down(); try { live(); await page.mouse.move(action.toX, action.toY, { steps: 6 }); } finally { await page.mouse.up(); } }
      else if (kind === 'type') { const value = text(action.text); if (action.ref || action.selector || action.name || action.role || action.target != null) { const target = await this.target(tab, action); try { live(); if (action.append) { await target.focus({ timeout: left() }); live(); await page.keyboard.insertText(value); } else await target.fill(value, { timeout: left() }); if (action.enter) { live(); await target.press('Enter', { timeout: left() }); } } finally { if (target.dispose) await target.dispose(); } } else { live(); if (action.clear) { await page.keyboard.press('ControlOrMeta+a'); live(); await page.keyboard.press('Backspace'); live(); } await page.keyboard.insertText(value); if (action.enter) { live(); await page.keyboard.press('Enter'); } } }
      else if (kind === 'key') { live(); await page.keyboard.press(text(action.key, 100)); }
      else if (kind === 'clipboard') {
        const origin = new URL(page.url()).origin;
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
        try { return { text: await page.evaluate(() => navigator.clipboard.readText()) }; }
        finally { await page.context().clearPermissions(); }
      }
      else if (kind === 'scroll') { const dy = integer(action.direction ? Math.round((await this.viewSize(tab)).height * (action.pages ?? 1) * (action.direction === 'up' ? -1 : 1)) : action.dy ?? 500, -20000, 20000); live(); await page.mouse.wheel(integer(action.dx ?? 0, -20000, 20000), dy); }
      else if (kind === 'select') { const target = await this.target(tab, action); try { live(); await target.selectOption(action.option != null ? { label: text(action.option, 1000) } : action.values || text(action.value, 1000), { timeout: left() }); } finally { if (target.dispose) await target.dispose(); } }
      else if (kind === 'upload') {
        const files = await this.uploads(tab, action);
        let target;
        try {
          target = await this.target(tab, action);
          // A file field takes the files. A button that opens the file picker
          // gets them through the picker, so no system dialog opens.
          const field = await target.evaluate(el => el instanceof HTMLInputElement && el.type === 'file').catch(() => false); live();
          if (field) await target.setInputFiles(files.paths, { timeout: left() });
          else { const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: left() }), target.click({ timeout: left() })]); live(); await chooser.setFiles(files.paths); }
        } finally { if (target?.dispose) await target.dispose(); await files.cleanup(); }
      } else if (kind === 'evaluate') { live(); const script = text(action.script, 20000), value = await (tab.patched ? page.evaluate(script, undefined, undefined, false) : page.evaluate(script)); await this.settle(tab); return { value, ...(!inBatch && action.look !== false ? await this.look(tab) : {}) }; }
      else if (kind === 'wait') { if (action.selector) await page.locator(text(action.selector, 2000)).first().waitFor({ state: action.state || 'visible', timeout: left() }); else await page.getByText(text(action.text, 2000)).first().waitFor({ timeout: left() }); }
      else if (kind === 'resize') { live(); await page.setViewportSize({ width: integer(action.width, 240, 1920), height: integer(action.height, 200, 1200) }); }
      else if (kind === 'dialog') { if (!tab.dialog) throw new Error('no dialog is open'); const dialog = tab.dialog; tab.dialog = null; action.accept ? await dialog.accept(action.text ?? '') : await dialog.dismiss(); }
      else throw new Error(kind ? `unknown browser action: ${kind}` : `unknown browser action ${JSON.stringify(Object.keys(action))}; use a kind such as goto, click, type, evaluate or wait`);
    } catch (error) {
      // Playwright's own words and call log, in place of what the agent needs to know.
      if (!/Timeout \d+ms exceeded/.test(error.message) || ['navigate', 'back', 'forward', 'reload'].includes(kind)) throw error;
      // The input landed and opened a dialog, which holds the step until it is answered.
      if (tab.dialog) throw new Error(`${kind}: the page opened a dialog (${tab.dialog.type()}): ${JSON.stringify(tab.dialog.message().slice(0, 2000))}. Answer it with {"dialog":"accept"} or {"dialog":"dismiss"}.`);
      throw new Error(kind === 'wait' ? `wait: nothing matched in ${budget} ms` : `${kind}: the control was not found or not ready in ${budget} ms. Read the page, or give the step a longer "timeout".`);
    }
    // Pointer moves and scrolling do not need to wait for unrelated adverts
    // or analytics. A read still measures the current DOM and layout.
    if (['navigate', 'back', 'forward', 'reload', 'click', 'type', 'key', 'select', 'drag', 'resize', 'upload', 'dialog', 'wait'].includes(kind)) await this.settle(tab, { navigation: ['navigate', 'back', 'forward', 'reload'].includes(kind) });
    // Only actions that can change the title ask for it; page loads update it as they finish.
    if (!tab.dialog && !['hover', 'scroll', 'type', 'resize'].includes(kind)) tab.title = await page.title().catch(() => tab.title);
    return { tab: this.metadata(tab), ...(!inBatch && action.look !== false ? await this.look(tab) : {}) };
  }
  /** Where the agent is about to act, drawn on the page in a window. Free in a hidden browser; point always draws. */
  async aim(tab, action, left = () => STEP_MS, live = () => {}) {
    const kind = action.kind;
    if (POINTER_CLEARS.includes(kind)) { if (tab.pointer) { tab.pointer = null; void tab.page.evaluate(clearPointer).catch(() => {}); } return; }
    if (!Object.hasOwn(POINTER_WORDS, kind) || kind !== 'point' && !tab.window) return;
    // The owner must act in this tab, so only here does Helm bring it to the front.
    if (kind === 'point' && tab.window) await tab.page.bringToFront().catch(() => {});
    let size = tab.page.viewportSize();
    const view = async () => size ||= await this.viewSize(tab);
    let x = kind === 'drag' ? action.toX : action.x, y = kind === 'drag' ? action.toY : action.y, box, name = '';
    if (kind === 'scroll' && x == null) { const { width, height } = await view(); x = Math.round(width / 2); y = Math.round(height / 2); }
    else if (x == null && !(kind === 'type' && !(action.ref || action.selector || action.name || action.role || action.target != null))) {
      let target; try {
        target = await this.target(tab, action);
        const timeout = Math.min(kind === 'point' ? 5000 : 500, left());
        let info = await target.evaluate(pointerTarget, undefined, { timeout });
        if (info.main) size = info.viewport;
        let found = info.main ? info.box : await target.boundingBox({ timeout });
        const { width, height } = await view();
        // A visible target needs no separate scroll and stability check:
        // Chromium's action still checks that it can click or type there.
        if (!['point', 'upload'].includes(kind) && (!info.main || info.clipped || !found
          || found.x < 0 || found.y < 0 || found.x + found.width > width || found.y + found.height > height)) {
          live(); await target.scrollIntoViewIfNeeded({ timeout: Math.min(500, left()) });
          info = await target.evaluate(pointerTarget, undefined, { timeout });
          if (info.main) size = info.viewport;
          found = info.main ? info.box : await target.boundingBox({ timeout });
        }
        if (found) { box = { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) }; x = Math.round(found.x + found.width / 2); y = Math.round(found.y + found.height / 2); name = info.name; }
      } catch (error) { if (kind === 'point' || error.stopped) throw error; } finally { if (target?.dispose) await target.dispose(); }
    }
    if (kind === 'point') tab.guide = action.x == null ? action : null;
    const { width, height } = await view();
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) { if (kind === 'point') throw new Error('that spot is not on screen; scroll to it first'); return; }
    live();
    const note = kind === 'point' && action.note != null ? text(action.note, 300).trim() : '';
    const verb = kind === 'click' ? action.button === 'right' ? 'Right-clicking' : action.double ? 'Double-clicking' : 'Clicking' : kind === 'scroll' ? (action.dy ?? 500) < 0 ? 'Scrolling up' : 'Scrolling down' : POINTER_WORDS[kind];
    tab.pointerSeq = (tab.pointerSeq || 0) + 1;
    tab.pointer = { x, y, ...(box ? { box } : {}), action: kind, label: [verb, name && `“${name}”`].filter(Boolean).join(' '), by: kind === 'point' ? 'guide' : 'agent', ...(note ? { note } : {}), seq: tab.pointerSeq, at: this.now() };
    tab.cursor = { x, y };
    await tab.page.evaluate(drawPointer, { ...tab.pointer, guide: kind === 'point' }).catch(() => {});
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
    let bytes;
    if (fullPage) bytes = await tab.page.screenshot({ type: 'jpeg', quality: 75, fullPage: true, scale: 'css', timeout: 10000 });
    else {
      // Capture what is visible now. Playwright waits for every web font,
      // which can hold a screenshot for seconds after the page is readable.
      const cdp = await (tab.captureCdp ||= tab.page.context().newCDPSession(tab.page));
      const { x, y, width, height, ratio } = await tab.page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, ratio: devicePixelRatio }));
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 75, fromSurface: true, captureBeyondViewport: false, clip: { x, y, width, height, scale: 1 / ratio } });
      bytes = Buffer.from(data, 'base64');
    }
    if (bytes.length > 3 * 1024 * 1024) throw new Error('screenshot exceeds 3 MiB; capture the viewport instead');
    return { image: `data:image/jpeg;base64,${bytes.toString('base64')}` };
  }
  /** Read Chromium's buffered console only when asked. Leaving Runtime on
   * makes sites inspect logged objects in pages and workers. */
  async readConsole(tab) {
    if (!tab.patched) return { entries: tab.console };
    const cdp = await tab.page.context().newCDPSession(tab.page);
    const record = message => {
      if (!tab.console.some(old => old.at === message.at && old.level === message.level && old.text === message.text)) cap(tab.console, message);
    };
    cdp.on('Runtime.consoleAPICalled', event => {
      const message = { level: event.type, text: event.args.map(arg => String(arg.value ?? arg.unserializableValue ?? arg.description ?? arg.type)).join(' ').slice(0, 4000), at: event.timestamp };
      record(message);
    });
    cdp.on('Runtime.exceptionThrown', event => record({ level: 'error', text: String(event.exceptionDetails.exception?.description || event.exceptionDetails.text).slice(0, 4000), at: event.timestamp }));
    try { await cdp.send('Runtime.enable'); await cdp.send('Runtime.disable'); }
    finally { await cdp.detach(); }
    return { entries: tab.console };
  }
  /** Wait for navigation and report a failed load in plain words. */
  async go(tab, kind, action, timeout = NAV_MS) {
    const page = tab.page, wait = { waitUntil: 'domcontentloaded', timeout }, target = kind === 'navigate' ? httpUrl(action.url) : null;
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
    await this.save(sessionId).catch(() => {}); this.contexts.delete(sessionId);
    if (context.helmWindow) { this.windowContexts.delete(sessionId); this.recovered.delete(sessionId); await this.closeIfEmpty(); } else await context.close();
    if (!this.headlessInUse()) await this.shutdownBrowser();
  }
  async save(sessionId) { const context = await this.contexts.get(sessionId); if (context) { (this.savedAt ||= new Map()).set(sessionId, this.now()); await this.saveContext(sessionId, context); } }
  async close(sessionId, tabId) {
    // A sleeping tab closes without waking its window.
    if (this.canWindow && !this.contexts.has(sessionId) && !this.tabs.has(tabId)) { this.owner(sessionId); const rows = await this.savedRows(sessionId); if (!rows.some(row => row.id === tabId)) throw new Error('browser tab not found in this thread'); await writeFile(join(this.directory, sessionId, 'tabs.json'), JSON.stringify(rows.filter(row => row.id !== tabId)), { mode: 0o600 }); return { ok: true }; }
    await this.recover(sessionId); const tab = this.get(sessionId, tabId); if (this.serial.has(tab.id)) throw new Error('wait for the current browser action to finish'); await this.save(sessionId); tab.explicitClose = true; await tab.page.close(); await this.persistTabs(sessionId); if (![...this.tabs.values()].some(t => t.sessionId === sessionId && t.engine === 'chromium')) { const context = await this.contexts.get(sessionId); this.contexts.delete(sessionId); if (context?.helmWindow) { this.windowContexts.delete(sessionId); this.recovered.delete(sessionId); await this.closeIfEmpty(); } else await context?.close(); } if (!this.headlessInUse()) await this.shutdownBrowser(); return { ok: true }; }
  async sweep() {
    // The owner's browser connected while the chats used Helm's window: they
    // move there after their current step. Their tabs open again by address.
    const fallback = this.shared;
    if (fallback?.helmFallback && !fallback.helmClosed && this.extended && this.relay?.connected) {
      const tabs = [...this.tabs.values()].filter(t => t.page?.context?.() === fallback);
      if (tabs.every(t => !this.serial.has(t.id) && !t.dialog)) await this.closeShared();
    }
    for (const sid of [...this.contexts.keys()]) {
      const tabs = [...this.tabs.values()].filter(t => t.sessionId === sid && t.engine === 'chromium');
      // Sign-ins made since the last save survive Chromium dying with Helm.
      const savedAt = this.savedAt?.get(sid) || 0;
      if (tabs.some(t => t.actedAt > savedAt) && this.now() - savedAt > 15000) await this.save(sid).catch(() => {});
      // A window nobody has used for a while is put away: its tabs sleep and
      // come back with the next step. One the owner is looking at stays.
      if (this.windowContexts.has(sid)) {
        if (tabs.length && tabs.every(t => !this.serial.has(t.id) && !t.dialog && this.now() - t.lastUsed > this.windowIdleMs) && !(await this.watched(tabs))) await this.putAway(sid);
        continue;
      }
      if (!tabs.length || !tabs.every(t => !this.serial.has(t.id) && this.now() - t.lastUsed > this.idleMs)) continue;
      await this.save(sid); await this.persistTabs(sid); const context = await this.contexts.get(sid); this.suspending.add(sid); try { await context?.close(); } finally { this.suspending.delete(sid); } this.contexts.delete(sid); this.recovered.delete(sid);
    }
    if (this.browser && !this.headlessInUse()) await this.shutdownBrowser();
  }
  /** Is the owner looking at one of these tabs right now? */
  async watched(tabs) {
    const looking = tab => Promise.race([tab.page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus()), new Promise(done => setTimeout(() => done(false), 1000).unref?.())]).catch(() => false);
    return (await Promise.all(tabs.map(looking))).some(Boolean);
  }
  /** Close a chat's tabs and keep them asleep; the window closes when no chat has a tab left. */
  async putAway(sessionId) {
    await this.save(sessionId).catch(() => {}); await this.persistTabs(sessionId);
    this.suspending.add(sessionId);
    try { await this.closeTabs(sessionId); } finally { this.suspending.delete(sessionId); }
    await this.closeIfEmpty();
  }
  async closeTabs(sessionId) {
    this.windowContexts.delete(sessionId); this.contexts.delete(sessionId); this.recovered.delete(sessionId);
    for (const tab of [...this.tabs.values()]) if (tab.sessionId === sessionId && tab.engine === 'chromium') { this.tabs.delete(tab.id); await tab.page?.close().catch(() => {}); }
  }
  /** The chat was deleted: its window, tabs, downloads and sign-ins go too. */
  async forget(sessionId) {
    if (!/^[\w:-]{1,160}$/.test(sessionId || '')) return;
    this.suspending.add(sessionId);
    try {
      const context = await this.contexts.get(sessionId)?.catch(() => null);
      this.windowContexts.delete(sessionId); this.contexts.delete(sessionId); this.recovered.delete(sessionId);
      clearTimeout(this.persistTimers?.get(sessionId)); this.persistTimers?.delete(sessionId); this.savedAt?.delete(sessionId);
      for (const [key, orphan] of this.orphans || []) if (orphan.sessionId === sessionId) this.orphans.delete(key);
      if (context?.helmWindow) await this.closeTabs(sessionId);
      else await context?.close().catch(() => {});
      for (const tab of [...this.tabs.values()]) if (tab.sessionId === sessionId) this.tabs.delete(tab.id);
      await stopWindow(windowProfile(this.directory, sessionId));
      await rm(join(this.directory, sessionId), { recursive: true, force: true });
    } finally { this.suspending.delete(sessionId); }
    await this.closeIfEmpty();
    if (this.browser && !this.headlessInUse()) await this.shutdownBrowser();
  }
  /**
   * Some time after Helm starts: folders of chats deleted while it was down
   * go, after a day untouched. Closed windows lose component downloads and
   * graphics files. Cached site files stay ready for the next visit.
   */
  async tidy() {
    let names; try { names = readdirSync(this.directory); } catch { return; }
    for (const name of names) {
      if (name === 'flows' || name === 'window' || !/^[\w:-]{1,160}$/.test(name)) continue;
      const folder = join(this.directory, name);
      let info; try { info = statSync(folder); } catch { continue; }
      if (!info.isDirectory() || this.contexts.has(name)) continue;
      let alive; try { alive = !!this.session(name); } catch { alive = false; }
      const touched = Math.max(info.mtimeMs, ...['tabs.json', 'storage.json'].map(file => { try { return statSync(join(folder, file)).mtimeMs; } catch { return 0; } }));
      if (!alive && this.now() - touched > 24 * 3600000) await this.forget(name);
      // Each chat kept its own window before the window was shared; that profile goes.
      else { await stopWindow(windowProfile(this.directory, name)); await rm(windowProfile(this.directory, name), { recursive: true, force: true }).catch(() => {}); }
    }
    await trimProfile(sharedProfile(this.directory));
  }
  async shutdownBrowser() { const browser = this.browser; this.browser = null; await browser?.close(); if (!this.tabs.size) { clearInterval(this.timer); this.timer = null; } }
  async stop() { this.stopping = true; for (const sid of this.contexts.keys()) { await this.save(sid).catch(() => {}); await this.persistTabs(sid).catch(() => {}); } // A window Helm can come back to stays open on the owner's screen.
    for (const context of new Set([...this.windowContexts.values(), this.shared].filter(Boolean))) await (context.helmDetach ? context.helmDetach() : context.close()).catch(() => {});
    this.windowContexts.clear(); this.shared = null; await this.shutdownBrowser(); this.tabs.clear(); this.contexts.clear(); clearInterval(this.timer); this.timer = null;
    await this.relay?.stop().catch(() => {}); }
}

/** A machine with no browser to start gets no browser note: it would only steer the agent to a tool that fails. */
// A browser that starts only through its package launcher (a Flatpak) still
// counts where the owner's window can open: the window starts it that way.
export function browserReady({ env = process.env, platform = process.platform, find, playwright = hasPlaywrightChromium, window = () => canOpenWindow(env, platform) } = {}) {
  if (env.HELM_WINDOW_CHROMIUM || env.HELM_CHROMIUM_PATH || env.HELM_TEST_CHROMIUM) return true;
  if (systemChromium(env, platform, find) || playwright()) return true;
  return !!(window() && launchTarget(env, platform, find));
}

export function browserNote(directory = join(HELM_DIR, 'browser'), { screen = canOpenWindow() } = {}) {
  // Extended mode: the owner's own browser already has their logins. It needs a screen.
  const logins = readMode(directory) === 'extended' && screen ? 'Your tabs open in the owner\'s own browser, signed in: never ask for logins. For a profile the owner names, add --profile "<name>" to helm browser open. If a tab opens in Helm\'s window, follow the reply\'s note.' : 'When a site needs a login, pick the fitting profile from helm browser profiles and run helm browser logins "<profile>".';
  return `[Helm browser: Use helm browser on this machine (helm browser --help). localhost reaches your dev servers. With a screen, all chats share one window: close your tabs when done. Use helm browser script for loops and ifs. For an owner step, point with helm browser point; do not click. For a CAPTCHA, run helm browser captcha <tab>; never solve it. Never ask for passwords. ${logins} Never restart the owner's browser or give it a debugging port. Respect the request on signed-in sites.]`;
}
