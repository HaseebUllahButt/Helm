import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CADDYFILE = '/etc/caddy/Caddyfile';
const HELM_CADDYFILE = '/etc/caddy/helm.caddy';
const IMPORT_LINE = `import ${HELM_CADDYFILE}`;

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

/**
 * Claim one of the free sslip.io names for this machine and put https for it
 * in front of the hub's port.
 *
 * The name is derived from the public IPv4 the internet already sees, so it
 * needs no account, no DNS setup and no purchase - the trade is that the name
 * moves when the address does. `found` fires once the name is known and
 * before Caddy is touched, so a CLI can say what it is about to claim before
 * sudo asks for a password.
 *
 * Throws rather than returning a partial result: a machine that is becoming
 * the network's home must either get a working https address or stay exactly
 * what it was - there is no half-configured state worth keeping.
 */
export async function claimFreeHttps(port = 8787, { found } = {}) {
  const ip = process.env.HELM_PUBLIC_IP || await detectPublicIpv4();
  const host = freeHostname(ip);
  found?.(host);
  await configureFreeHttps(host, port);
  return `https://${host}`;
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

/** Add one isolated Helm site to Caddy while preserving its existing config. */
export async function configureFreeHttps(hostname, port = 8787) {
  try { await exec('caddy', ['version']); }
  catch {
    throw new Error(
      'Caddy is not installed. Install the caddy package, then run `helm setup` again.'
    );
  }

  const originalMain = await privilegedRead(CADDYFILE);
  const originalHelm = await privilegedRead(HELM_CADDYFILE);
  const main = originalMain ?? '';
  const nextMain = main.includes(IMPORT_LINE)
    ? main
    : `${main.trimEnd()}${main.trim() ? '\n\n' : ''}${IMPORT_LINE}\n`;
  const site = `${hostname} {\n    reverse_proxy 127.0.0.1:${port}\n}\n`;
  const temp = await mkdtemp(join(tmpdir(), 'helm-caddy-'));
  const mainTemp = join(temp, 'Caddyfile');
  const helmTemp = join(temp, 'helm.caddy');

  await writeFile(mainTemp, nextMain, { mode: 0o600 });
  await writeFile(helmTemp, site, { mode: 0o600 });

  try {
    await installFile(mainTemp, CADDYFILE);
    await installFile(helmTemp, HELM_CADDYFILE);
    await exec('sudo', ['caddy', 'validate', '--config', CADDYFILE, '--adapter', 'caddyfile']);
    await exec('sudo', ['systemctl', 'enable', '--now', 'caddy']);
    await exec('sudo', ['systemctl', 'reload', 'caddy']);
  } catch (err) {
    // Put pre-existing files back if Helm's isolated site does not validate.
    if (originalMain === null) await exec('sudo', ['rm', '-f', CADDYFILE]).catch(() => {});
    else {
      await writeFile(mainTemp, originalMain, { mode: 0o600 });
      await installFile(mainTemp, CADDYFILE).catch(() => {});
    }
    if (originalHelm === null) await exec('sudo', ['rm', '-f', HELM_CADDYFILE]).catch(() => {});
    else {
      await writeFile(helmTemp, originalHelm, { mode: 0o600 });
      await installFile(helmTemp, HELM_CADDYFILE).catch(() => {});
    }
    throw new Error(`could not configure HTTPS with Caddy: ${err.message}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
