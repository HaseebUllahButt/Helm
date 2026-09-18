import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, createWriteStream,
} from 'node:fs';
import { join } from 'node:path';
import { arch, platform, homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CON_DIR } from './paths.js';

const exec = promisify(execFile);

/**
 * Put a public HTTPS address in front of a locally-served con.
 *
 * Only needed when no machine in the network has a public address of its own.
 * A router will not give a laptop or a phone one, so without a VM somewhere,
 * two machines on different networks have no way to be introduced - and a
 * phone can only install a web app to the home screen from a secure origin.
 *
 * The tunnel carries the app and the introduction. Once two peers connect
 * directly, the session traffic stops going through it.
 *
 * Two providers, because they fail in opposite directions:
 *
 *   ngrok        needs a free account, gives you a permanent address.
 *   cloudflared  needs nothing at all, gives you a different address every
 *                time it starts.
 *
 * There is no third option that is free, permanent and account-free: a
 * permanent name on the internet is something somebody has to hold for you.
 */

const BIN_DIR = join(CON_DIR, 'bin');

const has = async (bin) => {
  try {
    await exec('sh', ['-lc', `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Has ngrok been given an account?
 *
 * Checked before spawning so we can say what to do about it, rather than
 * letting ngrok fail with ERR_NGROK_4018 and a stack of JSON.
 */
export function ngrokAuthed() {
  if (process.env.NGROK_AUTHTOKEN) return true;
  const files = [
    join(homedir(), '.config/ngrok/ngrok.yml'),
    join(homedir(), '.ngrok2/ngrok.yml'),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      // Presence only. The token itself is never read into anything we log.
      if (/^\s*authtoken:\s*\S+/m.test(readFileSync(f, 'utf8'))) return true;
    } catch { /* unreadable is the same as absent */ }
  }
  return false;
}

export const SIGNUP_HELP = `A public address needs one of these:

  A permanent link  (free, about two minutes)
    1. sign up:   https://ngrok.com/signup
    2. on this machine:
         ngrok config add-authtoken <your token>
    3. claim your free domain in the ngrok dashboard
    4. con up --tunnel --domain <that domain>
    Same link forever - safe to add to a phone home screen.

  A link right now  (no account, no signup)
         con up --tunnel --temporary
    Works in seconds. The link CHANGES every restart, so do not
    add it to a home screen - use it to reach this machine today.`;

// --------------------------------------------------------------- cloudflared

const CF_ASSET = {
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
};

/**
 * Find cloudflared, fetching it if we have to.
 *
 * A single static binary, so downloading it is far kinder than telling
 * someone to go and install a package before they can reach their own laptop.
 * Only ever on an explicit --temporary; never silently.
 */
async function ensureCloudflared() {
  if (await has('cloudflared')) return 'cloudflared';

  const local = join(BIN_DIR, 'cloudflared');
  if (existsSync(local)) return local;

  const key = `${platform()}-${arch()}`;
  const asset = CF_ASSET[key];
  if (!asset) {
    throw new Error(`no cloudflared build for ${key} - install it yourself and re-run`);
  }
  if (asset.endsWith('.tgz')) {
    throw new Error(
      'on macOS install cloudflared first:  brew install cloudflared'
    );
  }

  console.log('  fetching cloudflared (one time, ~40MB)...');
  mkdirSync(BIN_DIR, { recursive: true });
  const url =
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`could not download cloudflared: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(local));
  chmodSync(local, 0o755);
  return local;
}

/**
 * Watch cloudflared's output for the address it was given, or the reason it
 * wasn't.
 *
 * Quick tunnels are genuinely flaky - Cloudflare's own API times out fairly
 * often - and "did not report a public address" told you nothing about
 * whether to retry, check your wifi, or give up. Its own words are better
 * than anything we could infer.
 */
function cloudflaredUrl(child, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ url: null, error: null }), timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };

    const scan = (chunk) => {
      const text = String(chunk);
      // Its own API lives on api.trycloudflare.com and appears in the log
      // too; the tunnel is any other subdomain.
      const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(text);
      if (m) return done({ url: m[0], error: null });

      const fail = /failed to (?:request|serve|connect)[^\n]*/i.exec(text);
      if (fail) return done({ url: null, error: fail[0].trim() });
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
  });
}

// ---------------------------------------------------------------------- ngrok

function startNgrok(port, domain) {
  // The address comes out of the log below, not out of the agent's local API,
  // so there is nothing here to point at a particular inspector port - and no
  // risk of reading some other ngrok's tunnel list.
  const args = ['http', String(port), '--log', 'stdout', '--log-format', 'json'];
  // A reserved domain is what makes an installed app keep working: without
  // one the address changes on every restart and the home-screen icon breaks.
  if (domain) args.push(`--url=${domain.replace(/^https?:\/\//, '')}`);
  return spawn('ngrok', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Read the address out of ngrok's own log rather than polling its API.
 *
 * The log also tells us why it failed, which is the difference between
 * "could not get an address" and "your account is not set up yet".
 */
function ngrokUrl(child, timeoutMs = 40_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ url: null, error: null }), timeoutMs);
    let buffer = '';
    const done = (v) => { clearTimeout(timer); resolve(v); };

    const scan = (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.msg === 'started tunnel' && rec.url) return done({ url: rec.url, error: null });
        if (rec.err && rec.err !== '<nil>') {
          return done({ url: null, error: String(rec.err).split('\n')[0].trim() });
        }
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
  });
}

// ----------------------------------------------------------------------- api

/**
 * @param {object}  opts
 * @param {number}  opts.port        the local con port to expose
 * @param {string}  [opts.provider]  'auto' | 'ngrok' | 'cloudflared'
 * @param {string}  [opts.domain]    a reserved ngrok domain, if you have one
 * @param {boolean} [opts.temporary] accept an address that changes each run
 */
export async function openTunnel({ port, provider = 'auto', domain, temporary = false }) {
  let choice = provider === 'auto' ? null : provider;

  if (!choice) {
    // Asking for a tunnel without --temporary means asking for a link worth
    // keeping, so only ngrok can satisfy it.
    if (temporary) choice = 'cloudflared';
    else if ((await has('ngrok')) && ngrokAuthed()) choice = 'ngrok';
    else {
      const why = (await has('ngrok'))
        ? 'ngrok is installed but has no account yet.'
        : 'ngrok is not installed.';
      throw Object.assign(new Error(`${why}\n\n${SIGNUP_HELP}`), { code: 'no_tunnel' });
    }
  }

  if (choice === 'ngrok') {
    if (!(await has('ngrok'))) {
      throw Object.assign(new Error(`ngrok is not installed.\n\n${SIGNUP_HELP}`), { code: 'no_tunnel' });
    }
    if (!ngrokAuthed()) {
      throw Object.assign(
        new Error(`ngrok has no account yet.\n\n${SIGNUP_HELP}`), { code: 'no_tunnel' }
      );
    }
    const child = startNgrok(port, domain);
    child.on('error', () => {});
    const { url, error } = await ngrokUrl(child);
    if (!url) {
      child.kill();
      throw new Error(error || 'ngrok did not report a public address');
    }
    const live = await waitReachable(url);
    const seen = rememberUrl(url, 'ngrok');
    const w = watch(child);
    return {
      url, provider: 'ngrok', live, stop: w.stop, onDown: w.onDown,
      // A reserved domain we asked for is permanent by construction; anything
      // else has to earn the label by turning up twice.
      permanent: !!domain || seen.stable,
      changedFrom: seen.stable ? null : seen.previous,
    };
  }

  const bin = await ensureCloudflared();
  const child = spawn(
    bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.on('error', () => {});
  const { url, error } = await cloudflaredUrl(child);
  if (!url) {
    child.kill();
    throw new Error(
      `${error || 'cloudflared did not report a public address'}\n` +
      "    Cloudflare's quick tunnels fail intermittently; running it again\n" +
      '    usually works. For a link that does not depend on them, see\n' +
      '    con up --tunnel --domain <your ngrok domain>'
    );
  }
  const live = await waitReachable(url);
  const seen = rememberUrl(url, 'cloudflared');
  const w = watch(child);
  return {
    url, provider: 'cloudflared', permanent: false, live,
    stop: w.stop, onDown: w.onDown,
    changedFrom: seen.stable ? null : seen.previous,
  };
}

/**
 * Wait until the address actually serves us.
 *
 * Both providers hand back a URL before it is live - cloudflared says as much
 * in its own banner. Returning at that point means the machine advertises an
 * address that answers nothing, and every peer that dials it fails and backs
 * off before it would have worked. So we ask the address who it is, and only
 * call it ours once it says.
 */
async function waitReachable(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(`${url}/api/health`, {
        signal: ctl.signal,
        headers: { 'ngrok-skip-browser-warning': '1' },
      }).finally(() => clearTimeout(timer));
      if (res.ok && (await res.json())?.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

const SEEN_FILE = join(CON_DIR, 'tunnel.json');

/**
 * Is this address one we can rely on tomorrow?
 *
 * Not something to reason about: ngrok's free plan now hands you your one
 * reserved domain by default, so an address can be permanent even when no
 * --domain was passed, and cloudflared's is never permanent no matter what.
 * The honest test is whether it is the same address we got last time, so we
 * remember it and compare.
 */
function rememberUrl(url, provider) {
  let seen = {};
  try { seen = JSON.parse(readFileSync(SEEN_FILE, 'utf8')); } catch { /* first run */ }
  const previous = seen[provider];
  const stable = previous === url;
  if (previous !== url) {
    mkdirSync(CON_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(SEEN_FILE, JSON.stringify({ ...seen, [provider]: url }, null, 2));
  }
  return { stable, previous: previous ?? null };
}

/**
 * Make sure the tunnel dies with us rather than outliving the process, and
 * that we hear about it if it dies first.
 *
 * A tunnel that has gone away while we keep advertising its address is worse
 * than having no address at all: every peer and phone that knows the network
 * dutifully dials something that answers nothing.
 */
function watch(child) {
  const stop = () => { try { child.kill(); } catch { /* already gone */ } };
  for (const sig of ['SIGINT', 'SIGTERM', 'exit']) process.once(sig, stop);
  return {
    stop,
    onDown: (cb) => child.once('exit', () => cb()),
  };
}
