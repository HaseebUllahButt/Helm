import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { NETWORK_FILE } from '@helm/protocol/network';
import { M } from '@helm/protocol';
import { hubRpc } from './hub-client.js';
import { findWebRoot } from './web-build.js';

const exec = promisify(execFile);
const command = (file, args) => exec(file, args, { timeout: 3000, maxBuffer: 64 * 1024 });
const check = (id, state, message, action) => ({ id, state, message, ...(action ? { action } : {}) });

/** Read only. Do not create registration files or repair a damaged registration. */
async function readNetwork() {
  try { return JSON.parse(await readFile(NETWORK_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function inspectService() {
  if (process.env.HELM_NO_SERVICE === '1') return { state: 'manual' };
  if (platform() === 'darwin') {
    const running = await command('launchctl', ['print', `gui/${process.getuid()}/dev.helm.serve`]).then(() => true, () => false);
    return { state: running ? 'active' : 'unknown' };
  }
  if (platform() !== 'linux') return { state: 'unsupported' };
  const states = await Promise.all(['helm-serve.service', 'helm-agent.service'].map(unit =>
    command('systemctl', ['--user', 'is-active', unit]).then(r => r.stdout.trim(), () => 'unknown')));
  const linger = await command('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value'])
    .then(r => r.stdout.trim(), () => 'unknown');
  return { state: states.includes('active') ? 'active' : 'unknown', linger };
}

/** Never forward credentials or follow redirects to an unregistered address. */
export async function probeHealth(address, network, { fetcher = fetch, timeout = 5000 } = {}) {
  let url;
  try {
    url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return 'invalid-address';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/health`;
  } catch { return 'invalid-address'; }
  try {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) { await response.body?.cancel(); return 'unavailable'; }
    // Health replies are small. Do not collect an arbitrary page into memory.
    const reader = response.body?.getReader();
    if (!reader) return 'invalid-reply';
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8192) { await reader.cancel(); return 'invalid-reply'; }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body?.ok !== true) return 'invalid-reply';
    if (body.network !== network) return 'wrong-network';
    return 'ok';
  } catch { return 'unavailable'; }
}

const validNetwork = net => net && typeof net.id === 'string' && typeof net.self === 'string'
  && typeof net.key === 'string' && net.machines && typeof net.machines === 'object'
  && !Array.isArray(net.machines) && net.machines[net.self]
  && (net.port === undefined || Number.isInteger(net.port) && net.port > 0 && net.port < 65536);

/**
 * Return a small report with no addresses, keys, account data, or raw errors.
 * The probes cannot start services, change settings, or submit work.
 */
export async function diagnose({
  network = readNetwork, service = inspectService, web = findWebRoot,
  health = probeHealth, rpc = hubRpc,
} = {}) {
  const checks = [];
  let net;
  try {
    net = await network();
    if (net && !validNetwork(net)) throw new Error('invalid registration');
  } catch {
    return finish([check('registration', 'error', 'The saved machine registration cannot be read.',
      'Restore its network.json from a trusted backup. Keep the damaged file for review.')]);
  }
  checks.push(net ? check('registration', 'ok', 'This machine has joined a Helm network.')
    : check('registration', 'error', 'This machine has not joined a Helm network.',
      'Run helm join to add this computer, or helm setup to create a home.'));
  const [background, app] = await Promise.all([
    service().catch(() => ({ state: 'unknown' })), Promise.resolve().then(web).catch(() => null),
  ]);
  checks.push(app ? check('app-files', 'ok', 'The built app is present.')
    : check('app-files', 'error', 'The built app is missing.', 'Build the app in this checkout: npm --workspace @helm/web run build'));
  checks.push(background.state === 'active' ? check('background', 'ok', 'The background service is active.')
    : background.state === 'manual' ? check('background', 'info', 'Background service checks are disabled for this copy.')
      : background.state === 'unsupported' ? check('background', 'warning', 'Automatic background startup is not supported on this system.', 'Keep helm up running in a terminal.')
        : check('background', 'warning', 'The background service could not be confirmed.', 'Run helm start if you want Helm to stay running.'));
  if (background.linger === 'no') checks.push(check('logout', 'warning', 'Helm may stop when you log out.',
    'Run loginctl enable-linger. Ask your administrator if it needs permission.'));
  if (!net) return finish(checks);

  const local = `http://127.0.0.1:${net.port ?? 8787}`;
  const localHealth = await health(local, net.id).catch(() => 'unavailable');
  if (localHealth !== 'ok') {
    checks.push(check('local', 'error', localHealth === 'wrong-network'
      ? 'The local app belongs to another Helm network.' : 'The local app did not return a valid health reply.',
    localHealth === 'wrong-network' ? 'Check which Helm copy uses this port before restarting it.' : 'Run helm start, then run helm doctor again.'));
  } else {
    checks.push(check('local', 'ok', 'The local app answers for this Helm network.'));
    // Keep this check local. A working remote home must not hide a broken local service.
    const localNet = { ...net, machines: { [net.self]: { ...net.machines[net.self], endpoints: [] } } };
    const ask = method => rpc(localNet, net.self, method, {}, { timeout: 5000, budget: 5000 });
    const [info, routes] = await Promise.allSettled([ask(M.ENV_INFO), ask(M.NET_ROUTES)]);
    if (info.status === 'rejected') checks.push(check('commands', 'error', 'The app answers, but Helm cannot read this machine through its live connection.',
      'Check the Helm service logs. Do not repeat an unconfirmed command.'));
    else {
      checks.push(check('commands', 'ok', 'The live connection answers read requests.'));
      const value = info.value;
      if (value?.version?.full && value?.web?.commit && value.version.full !== value.web.commit) {
        checks.push(check('app-version', 'warning', 'The app and running Helm use different versions.', 'Check Settings > Updates. Let the current update finish.'));
      }
      if (value?.sync?.reason || value?.sync?.diverged) checks.push(check('updates', 'warning', 'Automatic updates need attention.', 'Open Settings > Updates to see the reason.'));
      if (value?.terminals === 'panes') checks.push(check('terminals', 'warning', 'Terminals use the slower fallback.', 'Check terminal support in the installer before reinstalling.'));
    }
    if (routes.status === 'rejected' || !Array.isArray(routes.value?.machines)) {
      checks.push(check('routes', 'warning', 'Helm could not report its machine connections.', 'Check helm status and Settings > Updates.'));
    } else {
      const machines = routes.value.machines;
      const reached = machines.filter(m => m.attached || m.url || m.direct?.used).length;
      checks.push(check('routes', reached === machines.length ? 'ok' : 'warning',
        `${reached} of ${machines.length} other machines have a route from here.`,
        reached < machines.length ? 'Run helm doctor on an unreachable machine. It may be asleep or disconnected.' : undefined));
      if (routes.value.recovery?.repair) checks.push(check('packet-recovery', 'warning', 'Large network packet recovery needs setup.', 'Run helm network-repair on this machine.'));
    }
  }

  const homes = [...new Set(Object.values(net.machines)
    .filter(m => m && m.kind === 'vm' && !net.revoked?.[m.id])
    .flatMap(m => Array.isArray(m.endpoints) ? m.endpoints : []))];
  const results = await Promise.all(homes.map(address => health(address, net.id).catch(() => 'unavailable')));
  results.forEach((result, i) => checks.push(result === 'ok'
    ? check(`home-${i + 1}`, 'ok', `Home address ${i + 1} answers for this Helm network.`)
    : check(`home-${i + 1}`, 'warning', result === 'wrong-network'
      ? `Home address ${i + 1} belongs to another Helm network.`
      : result === 'invalid-address' ? `Home address ${i + 1} is not a valid Helm address.`
        : `Home address ${i + 1} did not return a valid health reply.`,
    'Check that home, its saved address, and its public web service.')));
  if (!homes.length) checks.push(check('homes', 'info', 'No always-on home address is registered.'));
  return finish(checks);
}

function finish(checks) {
  return { ok: !checks.some(c => c.state === 'error'), checks };
}

export function formatDiagnosis(report) {
  const title = report.checks.some(c => c.state === 'error' || c.state === 'warning')
    ? 'Helm found items to check.' : 'Helm found no problem in these checks.';
  return [title, ...report.checks.map(c => `${c.state.toUpperCase()}: ${c.message}${c.action ? `\n  ${c.action}` : ''}`)].join('\n');
}
