#!/usr/bin/env node
import { hostname } from 'node:os';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import {
  loadNetwork, requireNetwork, forgetNetwork, revoke, allEndpoints, machineToken,
} from '@helm/protocol/network';
import { refreshProfiles, getProfiles } from '../src/profiles.js';
import { proxy } from '../src/proxy.js';
import { createRuntime } from '../src/runtime/index.js';
import { HELM_DIR } from '../src/paths.js';

// Unix pipelines routinely close their read end early (`helm machines |
// head`). Treat that as successful completion instead of printing an
// unhandled EPIPE stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') exit(0);
    throw err;
  });
}

// A leading flag means no command was given: `helm --port 9000` is the
// quickstart with an option, not an unknown command.
const [, , first, ...others] = argv;
const leadingFlag = first?.startsWith('-') && first !== '-h' && first !== '--help';
const cmd = leadingFlag ? undefined : first;
const rest = leadingFlag ? [first, ...others] : others;

const die = (msg) => { console.error(`helm: ${msg}`); exit(1); };

const usage = () => {
  console.log(`helm - control your coding agents from anywhere

  helm setup [https-url]             make this always-on VM your Helm home
  helm setup --join <CODE> --at <url> [https-url]
                                     add another always-on VM to an existing mesh
  helm link [minutes]                link a phone, browser or desktop app (10 min; max 15)
  helm add                           add another computer
  helm join <CODE> [home-url]        join this computer to a Helm home (installs the service)
  helm join <CODE> [home-url] --foreground   ...but run in this terminal instead
  helm status                        show the network and runtime

  helm up [--port N] [--tunnel]      run in the foreground
  helm up --tunnel --domain <d>     permanent public link (needs a free ngrok account)
  helm up --tunnel --temporary      public link right now, no account (link changes)
  helm up --advertise <url>         public address others should reach me at
  helm up --host <address>          local listen address (default 0.0.0.0)
  helm up --install                 keep it running across reboots

  helm invite                       same as 'helm add'
  helm join <CODE> --at <url>       long form of 'helm join CODE url'

  helm devices                      phones and browsers that can drive this network
  helm machines                     machines in this network
  helm remove <id>                  remove a device or machine, permanently
  helm leave                        remove this machine from its network

  helm login [minutes]              new short-lived password for signing in a device
  helm status                       membership, links and runtime
  helm profiles [--refresh]         the agent profiles found here
  helm proxy <host>                 ssh ProxyCommand (used by ~/.ssh/config)
  helm service install|uninstall    background service

A device you sign in stays signed in until you remove it. Passwords are only
for adding one, and expire in minutes.
`);
};

const flagOf = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = rest[i + 1];
  return !next || next.startsWith('--') ? true : next;
};
const strFlag = (name, fallback) => {
  const v = flagOf(name);
  return typeof v === 'string' ? v : fallback;
};
/** Every occurrence of a repeatable flag, e.g. --advertise a --advertise b. */
const allFlags = (name) => {
  const out = [];
  rest.forEach((a, i) => {
    if (a !== `--${name}`) return;
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) out.push(next.replace(/\/$/, ''));
  });
  return out;
};
const port = () => Number(strFlag('port', 8787));

const cleanEndpoint = (value) => String(value || '').trim().replace(/\/$/, '');

/** Stable HTTPS first, then whatever address the network currently knows. */
const orderedEndpoints = (net) => [...new Set(allEndpoints(net).map(cleanEndpoint))]
  .filter(Boolean)
  .sort((a, b) => Number(!a.startsWith('https://')) - Number(!b.startsWith('https://')));

async function postToHome(net, path, body = {}) {
  let lastError = null;
  for (const base of orderedEndpoints(net)) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${machineToken(net)}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const value = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`);
      return { base, value };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `your Helm home is not reachable${lastError ? `: ${lastError.message}` : ''}\n` +
    '  check the VM, then run `helm status`'
  );
}

async function printDeviceLink() {
  const net = requireNetwork();
  const mins = Number(rest[0]);
  const ttlMs = Number.isFinite(mins) && mins > 0 ? mins * 60_000 : undefined;
  const { base, value } = await postToHome(net, '/api/auth/rotate', { ttlMs });
  const pairUrl = `${base}/#pair=${encodeURIComponent(value.password)}`;
  const valid = Math.max(1, Math.round((value.expiresAt - Date.now()) / 60_000));
  console.log(`\n  Open this private link on your phone or in Helm Desktop:\n`);
  console.log(`    ${pairUrl}\n`);
  console.log(`  It expires in ${valid} minute${valid === 1 ? '' : 's'}.`);
  console.log('  Once paired, the device stays connected until you remove it.\n');
}

/** Point the relay's local database at this machine's helm directory. */
const useHubDb = () => { process.env.HELM_DB = join(HELM_DIR, 'hub.sqlite'); };

const short = (id) => id.slice(0, 8);
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// ---------------------------------------------------------------- commands

async function up() {
  if (rest.includes('--install')) {
    const { installService } = await import('../src/service.js');
    const args = rest.filter((a) => a !== '--install');
    const { installed, unit } = await installService({ mode: 'serve', args });
    if (installed) {
      console.log(`\n  installed ${unit} - helm now starts on boot.`);
      console.log('  watch it with:  journalctl --user -u helm-serve -f');
      console.log('  stop it with:   helm service uninstall --serve\n');
    }
    return;
  }

  useHubDb();
  const { up: bringUp } = await import('../src/serve.js');
  // A tunnel is opt-in now. It exists for the one case that genuinely needs
  // it - a phone reaching a laptop from outside its network, with no machine
  // in the network having a public address - and running it the rest of the
  // time is a dependency on a third party for no benefit.
  const tunnel = rest.includes('--tunnel')
    ? (strFlag('tunnel', true) === true ? 'auto' : strFlag('tunnel'))
    : null;

  await bringUp({
    port: port(),
    password: strFlag('password'),
    name: strFlag('name'),
    tunnel,
    domain: strFlag('domain'),
    advertise: allFlags('advertise'),
    host: strFlag('host', '0.0.0.0'),
    temporary: rest.includes('--temporary'),
  });
}

async function invite() {
  const net = requireNetwork();
  const { base: where, value } = await postToHome(net, '/api/invite');
  const { code } = value;
  console.log(`\n  On the machine you are adding, run:\n`);
  console.log(`    helm join ${code} ${where}\n`);
  console.log('  The invite is single-use and expires in 10 minutes.');
  console.log('  It carries the network key, so treat it like a password.\n');
}

async function joinCmd() {
  const code = rest.find((a) => !a.startsWith('--'));
  if (!code) die('an invite code is required: helm join ABCD-1234 --at http://host:8787');
  const codeIndex = rest.indexOf(code);
  const positionalAt = rest[codeIndex + 1]?.startsWith('--') ? null : rest[codeIndex + 1];
  const at = strFlag('at', positionalAt || process.env.HELM_AT);
  if (!at) die('where should I join? pass --at http://host:8787');

  // Check the runtime before joining, so a machine that cannot actually run
  // agents never shows up in the app as one that can.
  process.stdout.write('checking session runtime... ');
  try {
    const rt = await createRuntime();
    const info = await rt.ensureReady();
    rt.stop();
    console.log(`herdr ${info.version} (protocol ${info.protocol})`);
  } catch (err) {
    console.log('failed');
    die(`${err.message}\n  install it with: curl -fsSL https://herdr.dev/install.sh | sh`);
  }

  process.stdout.write('discovering agent profiles... ');
  const { profiles } = await refreshProfiles();
  console.log(`${profiles.length} found`);

  const { join: joinNet } = await import('../src/serve.js');
  const net = await joinNet({ code, at, name: strFlag('name', hostname()), port: port() });
  console.log(`\n  joined. ${Object.keys(net.machines).length} machines in this network.`);

  // A joined machine should stay reachable after this terminal closes, the
  // same as `helm setup` does for the home - so install the service rather
  // than serving in the foreground. `--foreground` keeps the old behaviour.
  if (!rest.includes('--foreground')) {
    const { installService } = await import('../src/service.js');
    const args = rest.includes('--name') ? ['--name', strFlag('name', hostname())] : [];
    const { installed, unit } = await installService({ mode: 'serve', args });
    if (installed) {
      console.log(`  installed ${unit} - this machine stays in the network across reboots.`);
      console.log('\n  Open the app on your phone: it should show this machine online.');
      console.log('  Check with:     helm status');
      console.log('  Watch logs:     journalctl --user -u helm-serve -f');
      console.log('  Run in front:   helm up  (stop the service first)\n');
      return;
    }
  }
  console.log('  bringing this machine up...\n');
  await up();
}

async function setup() {
  // Joining an existing mesh is opt-in: `--join <code> --at <existing-home>`.
  // A code needs somewhere to redeem it, so the two travel together. Any bare
  // positional is still THIS machine's own https address, exactly as when
  // founding a network, so a second VM reads the same way as the first.
  const joinCode = typeof flagOf('join') === 'string' ? strFlag('join') : null;
  if (rest.includes('--join') && !joinCode) {
    die('--join needs an invite code: helm setup --join ABCD-1234 --at https://home.example');
  }
  const joinAt = joinCode ? cleanEndpoint(strFlag('at', process.env.HELM_AT)) : null;
  if (joinCode && !joinAt) {
    die('where should I join? pass --at https://your-existing-home');
  }

  // The only bare positional setup takes is THIS machine's own https address.
  // Every other value on the line belongs to a flag (--join, --at, --name,
  // --port), so skip flag-value tokens rather than mistaking one for it.
  const flagValues = new Set();
  rest.forEach((a, i) => {
    if (!a.startsWith('--')) return;
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) flagValues.add(i + 1);
  });
  let home = cleanEndpoint(rest.find((a, i) => !a.startsWith('--') && !flagValues.has(i)));
  if (!home) {
    const { configureFreeHttps, detectPublicIpv4, freeHostname } = await import('../src/caddy.js');
    const ip = process.env.HELM_PUBLIC_IP || await detectPublicIpv4();
    const hostname = freeHostname(ip);
    home = `https://${hostname}`;
    console.log(`using free address: ${home}`);
    console.log('no website, domain purchase, or DNS setup is needed.');
    console.log('configuring HTTPS with Caddy (sudo may ask for your password)...');
    await configureFreeHttps(hostname, port());
  }
  let url;
  try { url = new URL(home); } catch { die(`invalid home address: ${home}`); }
  if (url.protocol !== 'https:') die('the Helm home address must start with https://');
  if (url.pathname !== '/' || url.search || url.hash) {
    die('use the home origin only, for example https://helm.example.com');
  }

  // Join the existing mesh before the service starts, so it comes up already
  // holding the shared key rather than founding a network of its own. Skipped
  // when this machine is already a member, which is what makes setup re-runnable.
  if (joinCode) {
    const existing = loadNetwork();
    if (existing) {
      console.log(`already in a network (${existing.id}); re-advertising ${home}.`);
      console.log('to move this machine to a different mesh, run `helm leave` first.');
    } else {
      process.stdout.write(`joining the mesh at ${joinAt}... `);
      try {
        const { join: joinNet } = await import('../src/serve.js');
        const net = await joinNet({
          code: joinCode, at: joinAt, name: strFlag('name', hostname()), port: port(),
        });
        console.log(`joined (${Object.keys(net.machines).length} machines).`);
      } catch (err) {
        console.log('failed');
        die(err.message);
      }
    }
  }

  const { installService } = await import('../src/service.js');
  const result = await installService({
    mode: 'serve',
    args: ['--advertise', home, '--host', '127.0.0.1'],
  });
  if (!result.installed) return;

  process.stdout.write('waiting for your Helm home... ');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${home}/api/health`, { signal: AbortSignal.timeout(2000) });
      const net = loadNetwork();
      if (res.ok && net && allEndpoints(net).map(cleanEndpoint).includes(home)) {
        ready = true;
        break;
      }
    } catch { /* Caddy or helm may still be starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    console.log('not reachable');
    die(`nothing answered at ${home}\n` +
        '  helm:   journalctl --user -u helm-serve -n 50\n' +
        '  https:  sudo journalctl -u caddy -n 50   (ports 80 and 443 must be open)');
  }
  console.log('ready');

  if (joinCode) {
    const net = loadNetwork();
    const count = net ? Object.keys(net.machines).length : 0;
    console.log(`\n  This VM is now part of the mesh at ${home}.`);
    console.log(`  ${count} machine${count === 1 ? '' : 's'} in the network; devices already`);
    console.log('  paired anywhere can reach it, and fail over to it if another');
    console.log('  home goes down. No new pairing link is needed.\n');
    return;
  }
  await printDeviceLink();
}

function listDevices() {
  const net = requireNetwork();
  const devices = Object.values(net.devices);
  if (!devices.length) {
    console.log('no devices yet - run `helm login` and sign in from a phone');
    return;
  }
  for (const d of devices) {
    console.log(`${short(d.id)}  ${(d.label || 'device').padEnd(16)} added ${ago(d.addedAt)}`);
  }
}

function listMachines() {
  const net = requireNetwork();
  for (const m of Object.values(net.machines)) {
    const self = m.id === net.self ? ' (this machine)' : '';
    const where = (m.endpoints ?? []).join(' ') || 'no address advertised';
    console.log(`${short(m.id)}  ${m.name.padEnd(16)} ${where}${self}`);
  }
}

/**
 * Remove a member. This is the only way something leaves a network - which is
 * the point: nothing else, including restarts, reinstalls or an expired
 * password, should ever cost you a device you added.
 */
function remove() {
  const net = requireNetwork();
  const prefix = rest.find((a) => !a.startsWith('--'));
  if (!prefix) die('which one? run `helm devices` or `helm machines` for ids');

  const all = { ...net.devices, ...net.machines };
  const hits = Object.keys(all).filter((id) => id.startsWith(prefix));
  if (!hits.length) die(`no device or machine starts with "${prefix}"`);
  if (hits.length > 1) die(`"${prefix}" matches ${hits.length} members - be more specific`);

  const [id] = hits;
  if (id === net.self) {
    die('that is this machine - use `helm leave` to take it out of the network');
  }
  const label = net.devices[id]?.label ?? net.machines[id]?.name ?? id;
  revoke(net, id);
  console.log(`removed ${label} (${short(id)}).`);
  console.log('it is revoked everywhere as soon as each machine next syncs.');
}

async function leave() {
  const net = loadNetwork();
  if (!net) { console.log('this machine is not in a network'); return; }
  if (!rest.includes('--yes')) {
    console.log(`this will remove "${net.machines[net.self]?.name}" from its network,`);
    console.log('delete this machine\'s copy of the roster and its key, and stop');
    console.log('the helm background service if one is installed.');
    console.log('\nre-run with --yes to confirm.');
    return;
  }
  // Stop the background service first: left running, it would restart and
  // silently create a brand-new network on the next boot.
  const { uninstallService } = await import('../src/service.js');
  await uninstallService({ mode: 'serve' }).catch(() => {});
  await uninstallService({ mode: 'agent' }).catch(() => {});
  forgetNetwork();
  rmSync(join(HELM_DIR, 'hub.sqlite'), { force: true });
  rmSync(join(HELM_DIR, 'hub.sqlite-wal'), { force: true });
  rmSync(join(HELM_DIR, 'hub.sqlite-shm'), { force: true });
  rmSync(join(HELM_DIR, 'local-relay.sqlite'), { force: true });
  rmSync(join(HELM_DIR, 'config.json'), { force: true });
  rmSync(join(HELM_DIR, 'local.json'), { force: true });
  console.log('left the network. `helm up` will start a fresh one.');
  console.log('other machines will drop this one as they sync.');
}

// ---------------------------------------------------------------- dispatch

try {
  switch (cmd) {
    case undefined:
    case 'up':
    case 'serve':
    case 'run':
      await up();
      break;

    case 'setup':
      await setup();
      break;

    case 'add':
    case 'invite':
      await invite();
      break;

    case 'join':
      await joinCmd();
      break;

    case 'devices':
      listDevices();
      break;

    case 'machines':
      listMachines();
      break;

    case 'remove':
    case 'revoke':
      remove();
      break;

    case 'leave':
      await leave();
      break;

    case 'link': {
      await printDeviceLink();
      break;
    }

    // Kept for scripts written against the older command. `helm link` is the
    // human-facing form because it prints one thing a device can open.
    case 'login': {
      requireNetwork();
      useHubDb();
      const { rotatePassword, PASSWORD_TTL_MS } = await import('@helm/relay/http');
      const mins = Number(rest[0]);
      const { password, expiresAt } = rotatePassword(
        null, Number.isFinite(mins) && mins > 0 ? mins * 60_000 : PASSWORD_TTL_MS
      );
      console.log(`\n  password: ${password}`);
      console.log(`  valid for ${Math.round((expiresAt - Date.now()) / 60000)} minutes`);
      console.log('  devices already signed in are unaffected.\n');
      break;
    }

    case 'service': {
      const { installService, uninstallService } = await import('../src/service.js');
      const mode = rest.includes('--serve') ? 'serve' : 'agent';
      if (rest[0] === 'uninstall') await uninstallService({ mode });
      else await installService({ mode });
      break;
    }

    case 'proxy':
      if (!rest[0]) die('usage: helm proxy <host>');
      await proxy(rest[0]);
      break;

    case 'profiles': {
      const profiles = rest.includes('--refresh')
        ? (await refreshProfiles()).profiles
        : await getProfiles();
      for (const p of profiles) {
        const env = Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join(' ');
        console.log(
          `${p.id.padEnd(16)} ${p.engine.padEnd(9)} ${env} ${p.cmd} ${(p.args || []).join(' ')}`
        );
      }
      break;
    }

    case 'status': {
      const net = loadNetwork();
      if (!net) { console.log('not in a network - run `helm up`'); break; }
      const me = net.machines[net.self];
      console.log(`network:  ${net.id}`);
      console.log(`machine:  ${me?.name} (${short(net.self)})`);
      console.log(`members:  ${Object.keys(net.machines).length} machines, ` +
                  `${Object.keys(net.devices).length} devices`);
      console.log(`reachable at: ${(me?.endpoints ?? []).join(' ') || '(not advertised yet)'}`);
      const peers = allEndpoints(net).filter((e) => !(me?.endpoints ?? []).includes(e));
      if (peers.length) console.log(`other hubs:   ${peers.join(' ')}`);
      try {
        const rt = await createRuntime();
        const info = await rt.ensureReady();
        rt.stop();
        console.log(`runtime:  herdr ${info.version} (protocol ${info.protocol})`);
      } catch (err) {
        console.log(`runtime:  unavailable - ${err.message}`);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      usage();
      break;

    default:
      console.error(`helm: unknown command "${cmd}"\n`);
      usage();
      exit(1);
  }
} catch (err) {
  die(err?.message || String(err));
}
