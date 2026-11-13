// helm browser script: an agent's own JavaScript, with ifs and loops, drives
// tabs in one call. It runs here, in the agent's CLI process, never in the
// Helm service: each step is the same 'browser.action' call the CLI already
// makes, so the service keeps its checks (read-only chats, owner-quiet waits,
// step timeouts) and the script gets no new power.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPTCHA_SLICE_MS } from './browser-targets.js';

const AsyncFunction = (async () => {}).constructor;
const show = value => typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) ?? String(value); } catch { return String(value); } })();
// An element from look() goes by its number; text, a number or {selector}/{role,name} go as they are.
const fields = target => target && typeof target === 'object' ? (target.ref != null ? { ref: target.ref } : target) : typeof target === 'number' || /^\d+$/.test(String(target ?? '').trim()) ? { ref: Number(target) } : { target };
const pick = target => target && typeof target === 'object' && target.ref != null ? target.ref : target;

/** A file is a module when it imports or exports at its top; else it is an async function body. */
export async function loadScript(source, file) {
  if (/^\s*(?:export\s|import\s*[\w{*'"])/m.test(source)) {
    const url = file && file !== '-' ? `${pathToFileURL(resolve(file)).href}?at=${Date.now()}` : `data:text/javascript,${encodeURIComponent(source)}`;
    const run = (await import(url)).default;
    if (typeof run !== 'function') throw new Error('the module has no default export function');
    return run;
  }
  const body = new AsyncFunction('browser', 'log', 'args', 'console', source);
  return (browser, { log, args }) => body(browser, log, args, { log, info: log, warn: log, error: log });
}

/**
 * Run a script against tab `tabId`. `call(method, params, ms)` sends one
 * browser call for this chat. The answer always has ok, log, steps and ms;
 * a failure adds the step that failed, its error and a page read.
 */
export async function runBrowserScript({ source, file, tabId, args = {}, timeout = null, call, now = Date.now }) {
  const started = now(), lines = [], state = { steps: 0, stopped: null, current: null, last: null };
  const log = (...items) => { lines.push(items.map(show).join(' ')); };
  const stepError = (message, step, result) => Object.assign(new Error(message), { helmStep: step, helmResult: result });
  async function send(method, tab, params, name, ms) {
    if (state.stopped) throw new Error(`the script ${state.stopped}, so this step was not sent`);
    const step = { number: ++state.steps, call: name, ...(tab ? { tab } : {}), ...(params.action ? { action: params.action } : params.url ? { url: params.url } : {}) };
    state.current = state.last = step;
    try { return await call(method, { ...(tab ? { tabId: tab } : {}), ...params }, ms); }
    catch (error) { throw stepError(error.message, step); }
    finally { if (state.current === step) state.current = null; }
  }
  // One browser step. By default it does not read the page after it: add look: true for that.
  async function act(tab, action, name, { checks = false } = {}) {
    const result = await send('browser.action', tab, { action }, name, Math.max(60000, (Number(action.timeout) || 0) + 15000));
    if (result && (result.error || result.failedAt != null) && !(checks && result.check)) throw stepError(result.error || `step ${result.failedAt + 1} of the batch failed`, state.last, result);
    return result;
  }
  const quiet = (action, options = {}) => ({ ...options, ...action, look: options.look === true });
  const handle = id => ({
    id,
    look: (options = {}) => act(id, { kind: 'look', ...options }, 'look'),
    click: (target, options) => act(id, quiet({ click: pick(target) }, options), 'click'),
    hover: (target, options) => act(id, quiet({ hover: pick(target) }, options), 'hover'),
    type: (target, text, options) => act(id, quiet({ type: text, ...(target != null ? { into: pick(target) } : {}) }, options), 'type'),
    goto: (url, options) => act(id, quiet({ goto: url }, options), 'goto'),
    key: (name, options) => act(id, quiet({ key: name }, options), 'key'),
    select: (target, option, options) => act(id, quiet({ select: pick(target), option }, options), 'select'),
    scroll: (how = 'down', options) => act(id, quiet(typeof how === 'string' ? { scroll: how } : 'scroll' in how ? how : { kind: 'scroll', ...how }, options), 'scroll'),
    point: (target, options) => act(id, quiet({ kind: 'point', ...fields(target) }, options), 'point'),
    // true or false; a check that fails is an answer, not an error.
    check: async (spec, options) => (await act(id, quiet({ check: spec }, options), 'check', { checks: true })).pass === true,
    evaluate: async (script, options) => (await act(id, quiet({ evaluate: typeof script === 'function' ? `(${script})()` : script }, options), 'evaluate')).value,
    act: action => act(id, { look: false, ...action }, 'act'),
    // The owner solves a CAPTCHA; this waits for them, in calls short enough for the hub (helm browser captcha).
    captcha: async ({ timeout = 600000 } = {}) => {
      const end = Date.now() + timeout;
      for (;;) {
        const left = Math.max(0, end - Date.now()), wait = Math.min(CAPTCHA_SLICE_MS, left);
        const result = await send('browser.captcha', id, { wait, last: left <= CAPTCHA_SLICE_MS }, 'captcha', wait + 30000);
        if (!result?.waiting) return result;
      }
    },
    close: () => send('browser.close', id, {}, 'close', 60000),
  });
  const browser = {
    ...handle(tabId),
    tab: id => handle(id),
    tabs: async () => (await send('browser.list', null, {}, 'tabs', 60000)).tabs,
    open: async (url, { profile } = {}) => { const opened = await send('browser.open', null, { url: url || 'about:blank', ...(profile ? { profile } : {}) }, 'open', profile ? 50000 : 30000); return Object.assign(handle(opened.tab.id), { tab: opened.tab, text: opened.text, elements: opened.elements }); },
    log, args,
  };
  const ms = () => now() - started;
  let run;
  try { run = await loadScript(source, file); } catch (error) { return { ok: false, error: `The script did not load: ${error.message}`, log: lines, steps: 0, ms: ms() }; }
  let timer;
  const outcome = await Promise.race([
    Promise.resolve().then(() => run(browser, { log, args })).then(value => ({ value }), error => ({ error })),
    ...(timeout ? [new Promise(done => { timer = setTimeout(() => done({ timedOut: true }), timeout); })] : []),
  ]);
  clearTimeout(timer);
  // A step the script did not wait for is not sent after the answer.
  const inFlight = state.current;
  state.stopped = outcome.timedOut ? `timed out after ${timeout} ms` : 'ended';
  if (!outcome.timedOut && !outcome.error) return { ok: true, ...(outcome.value !== undefined ? { value: outcome.value } : {}), log: lines, steps: state.steps, ms: ms() };
  const error = outcome.error, step = outcome.timedOut ? inFlight : error?.helmStep, result = error?.helmResult || {};
  const message = outcome.timedOut ? `The script timed out after ${timeout} ms${inFlight ? ` during step ${inFlight.number} (${inFlight.call}). That step may still land` : ''}.` : error instanceof Error ? error.message : show(error);
  const answer = { ok: false, error: message, ...(step ? { step } : state.last ? { afterStep: state.last } : {}), log: lines, steps: state.steps, ms: ms() };
  for (const key of ['failedAt', 'results', 'candidates', 'check']) if (result[key] !== undefined) answer[key] = result[key];
  // A page read, so the agent can go on by hand. A step that failed often has one already.
  if (result.text != null) answer.page = { ...(result.tab ? { tab: result.tab } : {}), text: result.text, elements: result.elements };
  else {
    const where = step?.tab || state.last?.tab || tabId;
    // After a time-out the tab can still be busy with the last step: do not wait long for it.
    try { answer.page = await call('browser.action', { tabId: where, action: { kind: 'look' } }, outcome.timedOut ? 5000 : 60000); }
    catch (readError) { answer.page = { error: `The page was not read: ${readError.message}` }; }
  }
  return answer;
}
