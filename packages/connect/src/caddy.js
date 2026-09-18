import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CADDYFILE = '/etc/caddy/Caddyfile';
const CON_CADDYFILE = '/etc/caddy/con.caddy';
const IMPORT_LINE = `import ${CON_CADDYFILE}`;

export function freeHostname(ip) {
  const value = String(ip || '').trim();
  if (isIP(value) !== 4) throw new Error(`could not find this VM's public IPv4 address`);
  return `${value.replaceAll('.', '-')}.sslip.io`;
}

export async function detectPublicIpv4(fetchImpl = fetch) {
  const sources = ['https://api.ipify.org', 'https://ipv4.icanhazip.com'];
  for (const source of sources) {
    try {
      const res = await fetchImpl(source, { signal: AbortSignal.timeout(5000) });
      const value = res.ok ? String(await res.text()).trim() : '';
      if (isIP(value) === 4) return value;
    } catch { /* try the other public-IP service */ }
  }
  throw new Error(`could not find this VM's public IPv4 address`);
}

async function privilegedRead(path) {
  try { return await readFile(path, 'utf8'); }
  catch {
    try { return (await exec('sudo', ['cat', path])).stdout; }
    catch { return null; }
  }
}

async function installFile(source, target) {
  await exec('sudo', ['install', '-m', '0644', source, target]);
}

/** Add one isolated Con site to Caddy while preserving its existing config. */
export async function configureFreeHttps(hostname, port = 8787) {
  try { await exec('caddy', ['version']); }
  catch {
    throw new Error(
      'Caddy is not installed. Install the caddy package, then run `con setup` again.'
    );
  }

  const originalMain = await privilegedRead(CADDYFILE);
  const originalCon = await privilegedRead(CON_CADDYFILE);
  const main = originalMain ?? '';
  const nextMain = main.includes(IMPORT_LINE)
    ? main
    : `${main.trimEnd()}${main.trim() ? '\n\n' : ''}${IMPORT_LINE}\n`;
  const site = `${hostname} {\n    reverse_proxy 127.0.0.1:${port}\n}\n`;
  const temp = await mkdtemp(join(tmpdir(), 'con-caddy-'));
  const mainTemp = join(temp, 'Caddyfile');
  const conTemp = join(temp, 'con.caddy');

  await writeFile(mainTemp, nextMain, { mode: 0o600 });
  await writeFile(conTemp, site, { mode: 0o600 });

  try {
    await installFile(mainTemp, CADDYFILE);
    await installFile(conTemp, CON_CADDYFILE);
    await exec('sudo', ['caddy', 'validate', '--config', CADDYFILE, '--adapter', 'caddyfile']);
    await exec('sudo', ['systemctl', 'enable', '--now', 'caddy']);
    await exec('sudo', ['systemctl', 'reload', 'caddy']);
  } catch (err) {
    // Put pre-existing files back if Con's isolated site does not validate.
    if (originalMain === null) await exec('sudo', ['rm', '-f', CADDYFILE]).catch(() => {});
    else {
      await writeFile(mainTemp, originalMain, { mode: 0o600 });
      await installFile(mainTemp, CADDYFILE).catch(() => {});
    }
    if (originalCon === null) await exec('sudo', ['rm', '-f', CON_CADDYFILE]).catch(() => {});
    else {
      await writeFile(conTemp, originalCon, { mode: 0o600 });
      await installFile(conTemp, CON_CADDYFILE).catch(() => {});
    }
    throw new Error(`could not configure HTTPS with Caddy: ${err.message}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
