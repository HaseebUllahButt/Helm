import { randomBytes } from 'node:crypto';
import { DEFAULT_TIMEOUT_MIN, MAX_TIMEOUT_MIN, TYPES } from './phone.js';

export const PHONE_USAGE = 'helm phone ask "<question>" [--choice <a>]... | photo ["<why>"] | location ["<why>"] | code ["<site>"] | list | cancel <id|all>';

/** Errors that mean "Helm is restarting or the link dropped": ask again. */
const LOST = /timed out|timeout|not connected|did not respond|ECONN|socket|closed|offline|unreachable|restarting|starting/i;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exit codes an agent can test. */
export const EXIT = { answered: 0, refused: 1, usage: 2, timeout: 3, stopped: 130 };

/** `--choice` may come many times; every other flag once. */
export function parsePhoneArgs(args) {
  const options = { choices: [] }, words = [];
  const values = ['choice', 'why', 'timeout', 'site'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if (arg === '--json') { options.json = true; continue; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!values.includes(name)) throw new Error(`unknown option: --${name}`);
    const value = inline ?? args[++i];
    if (value == null || (inline == null && value.startsWith('--'))) throw new Error(`--${name} needs a value`);
    if (name === 'choice') { options.choices.push(value); continue; }
    if (Object.hasOwn(options, name)) throw new Error(`--${name} was given more than once`);
    options[name] = value;
  }
  return { options, words };
}

/**
 * `helm phone`. An agent asks the owner for an answer, a photo, the
 * location or a sign-in code. The owner answers on a card in the Helm app,
 * on the phone or any other controller. This prints the answer.
 */
export async function runPhoneCommand(args, {
  rpc, self, env = process.env, out = process.stdout, err = process.stderr, signals = process, retryMs = 1000,
} = {}) {
  const print = (line) => out.write(`${line}\n`);
  const say = (line) => err.write(`${line}\n`);
  let parsed;
  try { parsed = parsePhoneArgs(args); } catch (error) { say(error.message); say(`Use: ${PHONE_USAGE}`); return EXIT.usage; }
  const { options, words } = parsed;
  const [type, ...rest] = words;

  if (type === 'list') {
    const { requests = [] } = await rpc(self(), 'phone.list', {});
    if (options.json) { print(JSON.stringify(requests)); return 0; }
    if (!requests.length) { print('No phone requests are open on this machine.'); return 0; }
    for (const r of requests) {
      const left = Math.max(0, Math.round((r.until - Date.now()) / 60_000));
      print(`${r.requestId}  ${r.title}${r.question ? `: ${r.question}` : ''}`);
      print(`  Chat: ${r.chat || r.sessionId}. Closes in ${left} min.${r.why ? ` Why: ${r.why}` : ''}`);
    }
    return 0;
  }
  if (type === 'cancel') {
    const which = rest[0];
    if (!which) { say('Say which request to close: helm phone cancel <id|all>. helm phone list shows them.'); return EXIT.usage; }
    const { requests = [] } = await rpc(self(), 'phone.list', {});
    const pick = which === 'all' ? requests : requests.filter((r) => r.requestId === which || r.requestId.startsWith(which));
    if (!pick.length) { print('No open phone request matches that.'); return 0; }
    for (const r of pick) await rpc(self(), 'phone.cancel', { requestId: r.requestId, message: 'The request was closed with helm phone cancel.' });
    print(pick.length === 1 ? 'Closed 1 phone request.' : `Closed ${pick.length} phone requests.`);
    return 0;
  }
  if (!TYPES.includes(type)) {
    say(type ? `helm phone cannot ask for "${type}".` : 'Say what to ask for.');
    say(`Use: ${PHONE_USAGE}`);
    return EXIT.usage;
  }
  if (rest.length > 1) { say('Put the text in quotes, as one word.'); return EXIT.usage; }
  if (options.choices.length && type !== 'ask') { say('--choice is only for helm phone ask.'); return EXIT.usage; }
  if (options.site && type !== 'code') { say('--site is only for helm phone code.'); return EXIT.usage; }
  let minutes = DEFAULT_TIMEOUT_MIN;
  if (options.timeout != null) {
    minutes = Number(options.timeout);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_TIMEOUT_MIN) { say(`--timeout is in minutes, from 1 to ${MAX_TIMEOUT_MIN}.`); return EXIT.usage; }
  }
  const text = rest[0] ?? '';
  if (type === 'ask' && !text.trim()) { say('Give the question: helm phone ask "<question>"'); return EXIT.usage; }

  const sessionId = env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION;
  if (!sessionId) { say('Run helm phone in a Helm chat. The owner answers on a card in that chat.'); return 1; }
  const requestId = `phone-${randomBytes(12).toString('hex')}`;
  const ask = {
    sessionId, requestId, type, timeoutMinutes: minutes,
    ...(type === 'ask' ? { question: text, choices: options.choices } : {}),
    ...(type === 'code' ? { site: options.site ?? text } : {}),
    ...(['photo', 'location'].includes(type) && text ? { why: text } : {}),
    ...(options.why ? { why: options.why } : {}),
  };

  let told = false;
  const call = async (method, params, ms) => {
    for (;;) {
      try { return await rpc(self(), method, params, ms); }
      catch (error) {
        if (!LOST.test(error.message ?? '')) throw error;
        if (!told) { say('Helm is not answering. It may be restarting. Waiting for it.'); told = true; }
        await pause(retryMs);
      }
    }
  };

  let quit = null;
  const end = (code) => () => { void rpc(self(), 'phone.cancel', { requestId }, 5_000).catch(() => {}).finally(() => quit?.(code)); };
  const onInt = end(EXIT.stopped), onTerm = end(143), onHup = end(129);
  signals.on?.('SIGINT', onInt); signals.on?.('SIGTERM', onTerm); signals.on?.('SIGHUP', onHup);
  try {
    return await new Promise((resolve, reject) => {
      quit = resolve;
      (async () => {
        let state = await call('phone.ask', ask, 30_000);
        if (state.state === 'asking') say(`Waiting for the owner to answer on the phone (up to ${minutes} min).`);
        for (;;) {
          if (state.state === 'answered') return printAnswer(type, state.answer ?? {}, { print, json: options.json });
          if (state.state === 'refused') { say(state.message ? `The owner refused: ${state.message}` : 'The owner refused.'); return EXIT.refused; }
          if (state.state === 'timeout') { say(`The owner did not answer in ${minutes} min. Ask again later, or go on without it.`); return EXIT.timeout; }
          if (state.state === 'cancelled') { say(state.message || 'The request was closed.'); return EXIT.stopped; }
          if (state.state === 'unknown') {
            // Helm lost the request (a restart with no record): ask again with the same id.
            state = await call('phone.ask', ask, 30_000);
            continue;
          }
          if (state.state !== 'asking') { say(`Unexpected answer from Helm: ${state.state}`); return 1; }
          state = await call('phone.wait', { requestId, wait: 20_000 }, 60_000);
        }
      })().then(resolve, reject);
    });
  } finally {
    signals.off?.('SIGINT', onInt); signals.off?.('SIGTERM', onTerm); signals.off?.('SIGHUP', onHup);
  }
}

/** The answer, plain for a person or a script, or JSON with --json. */
export function printAnswer(type, answer, { print, json = false }) {
  if (json) { print(JSON.stringify(answer)); return EXIT.answered; }
  if (type === 'ask') print(answer.text ?? '');
  else if (type === 'code') print(answer.code ?? '');
  else if (type === 'photo') print(answer.path ?? '');
  else if (type === 'location') {
    print(`${answer.latitude.toFixed(6)} ${answer.longitude.toFixed(6)}`);
    if (answer.accuracy != null) print(`Accuracy: about ${answer.accuracy} m`);
  }
  return EXIT.answered;
}
