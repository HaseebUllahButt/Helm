// Google's official Antigravity ACP agent - the managed runtime.
//
// The agent is not on any package registry and has no installer command of
// its own; Google ships a zip per platform on dl.google.com (the same
// archive the ACP registry lists). `helm antigravity install` fetches it,
// verifies the pinned sha256 and size, and extracts the executable pair
// under ~/.helm/tools/antigravity-acp/versions/<release>/.
//
// What the running agent needs around it (all handled here):
//   GEMINI_HOME               a helm-owned profile dir per account; the
//                             Google sign-in lands in its antigravity-acp/
//                             subdir, never in the user's real ~/.gemini
//   ANTIGRAVITY_HARNESS_PATH  the localharness_external sibling of the exe
//   AGY_ACP_FORCE_FILE_STORAGE file-backed tokens instead of a keychain
//   TMPDIR                    the exe is a PyInstaller one-file bundle that
//                             unpacks ~1GB per launch; helm owns the dir so
//                             a force kill's leftovers can be reclaimed
//   ambient Google vars       scrubbed so the chosen auth method is the
//                             only credential the agent sees
//
// Auth runs over ACP `authenticate` (oauth-personal or gemini-api-key).
// For the browser flow the agent prints
//   Open the following link to authenticate the ACP server: <url>
// on stdout - drivers/antigravity.js sniffs that line off the wire. The
// user's callback lands on a 127.0.0.1 listener the agent itself runs, so
// on this machine the sign-in just completes; from a phone the final
// redirect page fails to load and the user pastes its address back into
// the chat, which the driver forwards to the listener.
//
// Binary facts verified against Google's release metadata (the ACP
// registry's antigravity-acp/agent.json), 2026-09.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs';
import { mkdir, open, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import http from 'node:http';
import { HELM_DIR, HOME, expand } from './paths.js';

export const ANTIGRAVITY_RELEASE = 'agy_acp_server_1.1.1';

// Platform archive table. Hashes and byte counts are Google's own, from the
// ACP registry manifest - an installer that verifies them cannot be
// redirected onto a tampered archive.
const ASSETS = {
  'darwin-arm64': {
    url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip',
    sha256: 'fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189',
    archiveBytes: 316_014_828,
    exe: 'agy_acp_server.par',
    harness: 'localharness_external',
  },
  'linux-x64': {
    url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip',
    sha256: '38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df',
    archiveBytes: 681_969_407,
    exe: 'agy_acp_server.par',
    harness: 'localharness_external',
  },
  'linux-arm64': {
    url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-arm64.zip',
    sha256: 'ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398',
    archiveBytes: 656_572_786,
    exe: 'agy_acp_server.par',
    harness: 'localharness_external',
  },
  'win32-x64': {
    url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip',
    sha256: '47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8',
    archiveBytes: 468_238_392,
    exe: 'agy_acp_server.exe',
    harness: 'localharness_external.exe',
  },
  'win32-arm64': {
    url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip',
    sha256: '35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc',
    archiveBytes: 468_521_191,
    exe: 'agy_acp_server.exe',
    harness: 'localharness_external.exe',
  },
};

export const ANTIGRAVITY_AUTH_PREFIX =
  'Open the following link to authenticate the ACP server: ';

export const toolsDir = () => join(HELM_DIR, 'tools', 'antigravity-acp');
export const tmpParent = () => join(toolsDir(), 'tmp');

const assetFor = (platform = process.platform, arch = process.arch) =>
  ASSETS[`${platform}-${arch}`] ?? null;

/**
 * The active install: { exe, harness, version, dir } or null when the agent
 * has not been installed. `current` is a symlink to a versions/<release>
 * dir, so replacing it under a running agent only affects the next launch.
 */
export function antigravityInstall() {
  const root = toolsDir();
  const dir = join(root, 'current');
  const asset = assetFor();
  if (!asset) return null;
  try {
    const exe = join(dir, asset.exe);
    const harness = join(dir, asset.harness);
    if (!statSync(exe).isFile() || !statSync(harness).isFile()) return null;
    let version = null;
    try { version = JSON.parse(String(readFileSync(join(root, 'active.json')))).version ?? null; } catch { /* marker gone */ }
    return { exe, harness, version, dir };
  } catch {
    return null;
  }
}

/** What `helm antigravity` reports when nothing is asked of it. */
export function antigravityStatus() {
  const install = antigravityInstall();
  return {
    installed: !!install,
    version: install?.version ?? null,
    exe: install?.exe ?? null,
    supported: !!assetFor(),
  };
}

// ------------------------------------------------------------------- zip

/**
 * Pull `wanted` members out of a zip into `destDir`, streaming each through
 * inflate so a 1.9GB member never lives in memory twice. Just enough of the
 * format for Google's archive: central directory at the tail, stored or
 * deflated entries. Exported for the tests; nothing else should need it.
 */
export async function unzipMembers(zipPath, destDir, wanted, onMember) {
  const fh = await open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 70_000);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip archive (no end-of-directory)');
    const count = tail.readUInt16LE(eocd + 10);
    let off = tail.readUInt32LE(eocd + 16);
    const seen = new Set();
    for (let n = 0; n < count; n++) {
      const head = Buffer.alloc(46);
      await fh.read(head, 0, 46, off);
      if (head.readUInt32LE(0) !== 0x02014b50) throw new Error('corrupt zip central directory');
      const method = head.readUInt16LE(10);
      const csize = head.readUInt32LE(20);
      const nameLen = head.readUInt16LE(28);
      const extraLen = head.readUInt16LE(30);
      const commentLen = head.readUInt16LE(32);
      const localOff = head.readUInt32LE(42);
      const nameBuf = Buffer.alloc(nameLen);
      await fh.read(nameBuf, 0, nameLen, off + 46);
      const name = nameBuf.toString('utf8');
      off += 46 + nameLen + extraLen + commentLen;
      if (!wanted.has(name)) continue;
      if (method !== 0 && method !== 8) throw new Error(`zip member ${name} uses unsupported method ${method}`);

      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, localOff);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`corrupt zip member ${name}`);
      const dataOff = localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);

      const dest = join(destDir, name);
      await mkdir(dirname(dest), { recursive: true });
      // Its own fd: a stream made from the FileHandle closes the handle when
      // it ends, which would take the central-directory reads with it.
      const src = createReadStream(zipPath, { start: dataOff, end: dataOff + csize - 1 });
      const out = createWriteStream(dest, { mode: 0o755 });
      if (method === 8) await pipeline(src, createInflateRaw(), out);
      else await pipeline(src, out);
      seen.add(name);
      onMember?.(name);
    }
    for (const name of wanted) {
      if (!seen.has(name)) throw new Error(`zip did not contain ${name}`);
    }
  } finally {
    await fh.close();
  }
}

// --------------------------------------------------------------- install

/**
 * Download, verify, extract, activate. `onProgress(phase, done, total)`:
 * phase 'download' carries bytes so far; 'extract' and 'done' are markers.
 */
export async function installAntigravity({ onProgress = () => {} } = {}) {
  const asset = assetFor();
  if (!asset) {
    throw new Error(`Google ships no Antigravity ACP build for ${process.platform}-${process.arch}`);
  }
  const root = toolsDir();
  const versionDir = join(root, 'versions', ANTIGRAVITY_RELEASE);
  const zipPath = join(root, 'download.zip');
  await mkdir(versionDir, { recursive: true });

  // Download to a file, hashing as it lands - one pass, no second read.
  // A killed install leaves download.zip in place: a partial file resumes
  // with a Range request instead of re-fetching ~700MB; a complete one is
  // re-hashed and used directly (cheap next to the network trip).
  let received = 0;
  try { received = statSync(zipPath).size; } catch { /* none yet */ }
  let ready = false;
  if (received === asset.archiveBytes) {
    const probe = createHash('sha256');
    for await (const chunk of createReadStream(zipPath)) probe.update(chunk);
    if (probe.digest('hex') === asset.sha256) {
      ready = true;
      onProgress('download', received, asset.archiveBytes);
    } else received = 0;
  } else if (received > asset.archiveBytes) {
    received = 0;
  }
  if (!ready) {
    const hash = createHash('sha256');
    const res = await fetch(asset.url, {
      redirect: 'follow',
      headers: received ? { Range: `bytes=${received}-` } : {},
    });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    let flags = 'w';
    if (received && res.status === 206) {
      flags = 'a';
      for await (const chunk of createReadStream(zipPath)) hash.update(chunk);
    } else received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        hash.update(chunk);
        onProgress('download', received, asset.archiveBytes);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(zipPath, { flags }));
    if (received !== asset.archiveBytes) {
      throw new Error(`download truncated: ${received} bytes, expected ${asset.archiveBytes}`);
    }
    const digest = hash.digest('hex');
    if (digest !== asset.sha256) {
      await rm(zipPath, { force: true });
      throw new Error(`download failed verification (sha256 ${digest})`);
    }
  }

  onProgress('extract');
  await unzipMembers(zipPath, versionDir, new Set([asset.exe, asset.harness]));
  await rm(zipPath, { force: true });

  await writeFile(join(root, 'active.json'), JSON.stringify({ version: ANTIGRAVITY_RELEASE }) + '\n');
  await rm(join(root, 'current'), { force: true, recursive: true });
  await symlink(versionDir, join(root, 'current'), 'dir');

  // Older versions stay on disk only until the next install; nothing pins
  // them, and each one is ~2GB.
  for (const entry of await readdir(join(root, 'versions'))) {
    if (entry !== ANTIGRAVITY_RELEASE) await rm(join(root, 'versions', entry), { recursive: true, force: true });
  }
  onProgress('done');
  return antigravityInstall();
}

export async function uninstallAntigravity() {
  await rm(toolsDir(), { recursive: true, force: true });
}

// ------------------------------------------------------------ environment

// Ambient variables that would silently change which credentials the agent
// picks up. The configured method is the only credential it should see.
const SCRUB_ENV = new Set([
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT',
  'AGY_ACP_CCPA_PROJECT', 'AGY_ACP_ENABLE_OAUTH', 'GEMINI_HOME',
  'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH',
  'PYTHONUNBUFFERED', 'ELECTRON_RUN_AS_NODE',
]);

/** The auth method this launch should use, from the profile's own env. */
export function antigravityAuthMethod(env = {}) {
  // A profile can pick any method the agent advertises; without a choice,
  // a key on the profile means api-key and anything else means browser.
  if (env.AGY_AUTH_METHOD) return env.AGY_AUTH_METHOD;
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'gemini-api-key';
  return 'oauth-personal';
}

// The scrub removes Google variables so ambient state cannot shadow the
// configured method - but the method's own credential has to come back.
const KEEP_BY_METHOD = {
  'gemini-api-key': ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  'agent-platform': [
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT',
    'GOOGLE_GENAI_USE_VERTEXAI', 'AGY_ACP_CCPA_PROJECT',
  ],
};

/**
 * The complete environment for the agent process. `merged` is the env the
 * generic driver already computed (process.env + profile env); this scrubs
 * ambient Google variables, keeps the profile's own credential if it chose
 * the api-key method, and adds the managed-runtime variables.
 */
export function antigravityEnv(merged, { exe, geminiHome, tmpDir }) {
  const env = {};
  for (const [k, v] of Object.entries(merged)) {
    if (!SCRUB_ENV.has(k.toUpperCase())) env[k] = v;
  }
  // The configured method's own credential survives the scrub: an api-key
  // profile's key, an agent-platform profile's project, re-added from the
  // profile env - never whatever happened to be ambient.
  for (const name of KEEP_BY_METHOD[antigravityAuthMethod(merged)] ?? []) {
    if (merged[name]) env[name] = merged[name];
  }
  env.GEMINI_HOME = geminiHome;
  env.AGY_ACP_FORCE_FILE_STORAGE = '1';
  env.PYTHONUNBUFFERED = '1';
  env.ANTIGRAVITY_HARNESS_PATH = join(dirname(exe), assetFor()?.harness ?? 'localharness_external');
  if (process.platform === 'win32') {
    env.TEMP = tmpDir;
    env.TMP = tmpDir;
  } else {
    env.TMPDIR = tmpDir;
  }
  return env;
}

/**
 * Create the profile's directories (0700 - the Google token lands here) and
 * rewrite settings.json so a method change takes effect on this launch.
 * Returns { geminiHome, tmpDir }; tmpDir is per-process under a helm-owned
 * parent, swept of dead unpack dirs first.
 */
export async function prepareAntigravityProfile(env = {}) {
  const geminiHome = expand(env.GEMINI_HOME || '~/.helm/antigravity');
  const acpDir = join(geminiHome, 'antigravity-acp');
  const method = antigravityAuthMethod(env);
  for (const dir of [geminiHome, acpDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const settings = { auth: { type: method } };
  await writeFile(join(acpDir, 'settings.json'), JSON.stringify(settings) + '\n');

  // A fresh unpack dir per process; sweep whatever dead launches left.
  const parent = tmpParent();
  await mkdir(parent, { recursive: true });
  const tmpDir = join(parent, `run-${process.pid}-${Date.now().toString(36)}`);
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  return { geminiHome, tmpDir };
}

/** Reclaim unpack dirs whose process is gone - run on driver start. */
export async function sweepAntigravityTmp() {
  const parent = tmpParent();
  let entries;
  try { entries = await readdir(parent, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries
    .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
    .map((e) => rm(join(parent, e.name), { recursive: true, force: true }).catch(() => {})));
}

// ------------------------------------------------------------------ auth

/**
 * Validate a pasted OAuth redirect against the request the agent actually
 * made: same 127.0.0.1 origin and path, one `state` matching, exactly one
 * `code` or `error`. Returns { callback } or { error }.
 */
export function validateAntigravityRedirect(pending, text) {
  const invalid = (m) => ({ error: m });
  const raw = (text ?? '').trim();
  if (raw.length > 16_384 || /\s/.test(raw)) return invalid('That is not a redirect URL.');
  let url;
  try { url = new URL(raw); } catch { return invalid('Paste the complete redirect URL from the sign-in page.'); }
  const expected = new URL(pending.redirectUri);
  if (
    url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
    url.origin !== expected.origin || url.pathname !== expected.pathname ||
    url.username || url.password || url.hash
  ) return invalid('That redirect URL does not belong to this sign-in.');
  const states = url.searchParams.getAll('state');
  if (states.length !== 1 || states[0] !== pending.state) {
    return invalid('That redirect URL does not belong to this sign-in.');
  }
  const codes = url.searchParams.getAll('code');
  const errors = url.searchParams.getAll('error');
  if (!((codes.length === 1 && codes[0] && errors.length === 0) ||
        (errors.length === 1 && errors[0] && codes.length === 0))) {
    return invalid('The redirect URL must carry one Google sign-in response.');
  }
  return { callback: url };
}

/** Deliver one callback to the agent's own loopback listener. */
export function forwardAntigravityRedirect(callbackUrl) {
  return new Promise((resolve, reject) => {
    const url = typeof callbackUrl === 'string' ? new URL(callbackUrl) : callbackUrl;
    const req = http.request({
      protocol: 'http:', hostname: url.hostname, port: url.port,
      path: `${url.pathname}${url.search}`, method: 'GET', agent: false,
      timeout: 10_000,
    }, (res) => {
      res.resume();
      res.once('end', () => {
        const ok = (res.statusCode ?? 0) >= 200 && res.statusCode < 300;
        ok ? resolve() : reject(new Error('the sign-in listener refused the response'));
      });
      res.once('error', () => reject(new Error('the sign-in listener refused the response')));
    });
    req.once('timeout', () => { req.destroy(); reject(new Error('the sign-in listener did not answer')); });
    req.once('error', () => reject(new Error('the sign-in listener is gone - start sign-in again')));
    req.end();
  });
}

/**
 * `helm antigravity login`: one process, one ACP exchange. initialize →
 * session/new to see whether a sign-in is even needed → authenticate when
 * it is. Prints the OAuth URL the moment the agent emits it.
 */
export async function antigravityLogin({ env = {}, onUrl = () => {}, onLine = () => {} } = {}) {
  const install = antigravityInstall();
  if (!install) throw new Error('the Antigravity runtime is not installed - run `helm antigravity install`');
  const { geminiHome, tmpDir } = await prepareAntigravityProfile(env);
  const spawnEnv = antigravityEnv({ ...process.env, ...env }, { exe: install.exe, geminiHome, tmpDir });
  const child = spawn(install.exe, process.platform === 'linux' ? ['--uid='] : [], {
    env: spawnEnv, cwd: HOME, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    return await new Promise((resolve, reject) => {
      let buf = '';
      const pending = new Map();
      let seq = 0;
      const send = (method, params) => {
        const id = `login-${++seq}`;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return new Promise((res) => pending.set(id, res));
      };
      const fail = (e) => { try { child.kill('SIGKILL'); } catch {} ; reject(e); };
      const timeout = setTimeout(() => fail(new Error('sign-in timed out (5 minutes)')), 300_000);
      child.once('error', fail);
      child.once('exit', (code) => {
        // A dead process leaves every in-flight call hanging; settle them.
        for (const res of pending.values()) res({ error: { message: `the agent exited (code ${code})` } });
        pending.clear();
      });
      child.stderr.on('data', (d) => onLine(`stderr: ${d}`));
      child.stdout.on('data', async (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          if (line.startsWith(ANTIGRAVITY_AUTH_PREFIX)) {
            onUrl(line.slice(ANTIGRAVITY_AUTH_PREFIX.length).trim());
            continue;
          }
          let m;
          try { m = JSON.parse(line); } catch { onLine(`out: ${line.slice(0, 200)}`); continue; }
          if (m.id !== undefined && pending.has(m.id)) {
            const res = pending.get(m.id); pending.delete(m.id); res(m);
          }
        }
      });

      (async () => {
        const init = await send('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'helm', title: 'Helm', version: '0.1.0' },
        });
        if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
        const created = await send('session/new', { cwd: HOME, mcpServers: [] });
        if (!created.error) {
          clearTimeout(timeout);
          return resolve({ alreadySignedIn: true, sessionId: created.result?.sessionId });
        }
        const methodId = antigravityAuthMethod(env);
        const auth = await send('authenticate', { methodId });
        if (auth.error) throw new Error(`authenticate failed: ${auth.error.message}`);
        const retry = await send('session/new', { cwd: HOME, mcpServers: [] });
        if (retry.error) throw new Error(`signed in, but session/new still fails: ${retry.error.message}`);
        clearTimeout(timeout);
        resolve({ alreadySignedIn: false, sessionId: retry.result?.sessionId });
      })().catch((e) => { clearTimeout(timeout); reject(e); });
    });
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
