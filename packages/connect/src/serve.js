import { existsSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { startRelay } from '@helm/relay';
import {
  loadNetwork, saveNetwork, createNetwork, joinNetwork, allEndpoints,
} from '@helm/protocol/network';
import { Daemon } from './agent.js';
import { lanAddresses } from './net-addr.js';
import { HELM_DIR } from './paths.js';

/** Where the built PWA lives when running from a checkout. */
function findWebRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../apps/web/dist', '../web/dist', './web']) {
    const dir = pathJoin(here, rel);
    if (existsSync(pathJoin(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * Bring this machine up as a member of a network.
 *
 * Every machine does exactly this, whether it is a VM with a public address
 * or a laptop on someone's wifi. There is no separate "server" mode, because
 * there is no server: this starts a hub that can authenticate any member of
 * the network, and a daemon that attaches to every other hub it can reach.
 *
 * A phone therefore connects to whichever machine it can see, and reaches all
 * the others through it - so the network is up whenever *any* machine is.
 */
export async function up({
  port = 8787, password, name, tunnel = null, domain, advertise = [],
  temporary = false, host = '0.0.0.0',
} = {}) {
  let net = loadNetwork();
  const fresh = !net;
  if (!net) net = createNetwork({ name: name || hostname(), port });

  const webRoot = findWebRoot();
  let hub;
  try {
    hub = await startRelay({
      port,
      password,
      dbFile: pathJoin(HELM_DIR, 'hub.sqlite'),
      webRoot,
      host,
    });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      throw new Error(
        `port ${port} is already in use - helm is probably already running on this machine.\n` +
        `  check the service:  systemctl --user status helm-serve helm-agent\n` +
        `  watch its logs:     journalctl --user -u helm-serve -f\n` +
        `  or pick a port:     helm up --port ${port + 1}`
      );
    }
    throw err;
  }

  // A tunnel is a hub address like any other, so it has to exist before the
  // daemon advertises where it can be found.
  //
  // Failing to get one is not fatal. A machine with only a LAN address is
  // still a full member: it dials out to every other machine it knows, and
  // is reachable through them. Refusing to start at all - which is what this
  // used to do - turns "no public address" into "no machine", and with one
  // reserved domain between several laptops, not getting it is the norm.
  let publicUrl = null;
  let tunnelError = null;
  let tunnelKind = null;
  let tunnelChanged = null;
  let tunnelHandle = null;
  if (tunnel) {
    try {
      const { openTunnel } = await import('./tunnel.js');
      const t = await openTunnel({ port, provider: tunnel, domain, temporary });
      tunnelHandle = t;
      publicUrl = t.url;
      tunnelKind = t.provider === 'cloudflared' ? 'temporary'
        : t.permanent ? 'permanent' : 'unproven';
      tunnelChanged = t.changedFrom;
      if (!t.live) tunnelError = 'the tunnel opened but is not answering yet';
    } catch (err) {
      tunnelError = err?.message || String(err);
    }
  }

  // Addresses we cannot work out for ourselves. A machine behind a reverse
  // proxy only ever sees its own private IP, so the public name it is
  // actually reached by has to be supplied.
  const daemon = new Daemon({
    name: name || net.machines[net.self]?.name,
    port,
    extra: [...advertise, ...(publicUrl ? [publicUrl] : [])],
    advertised: advertise,
    advertiseLan: !['127.0.0.1', '::1', 'localhost'].includes(host),
  });
  await daemon.start();

  // If the tunnel goes away, stop telling the network it is there.
  tunnelHandle?.onDown?.(() => {
    console.log('[helm] the tunnel closed - no longer advertising that address');
    daemon.setTunnel(null).catch(() => {});
  });

  report({
    net: loadNetwork() ?? net, hub, daemon, port, publicUrl, fresh, webRoot,
    tunnelError, tunnelKind, tunnelChanged, host,
  });
  return { daemon, hub, port, publicUrl };
}

/**
 * Join a network that already exists, using an invite from any of its
 * machines. The invite carries the network key, which is what lets this
 * machine authenticate every device in the network from the first second -
 * including ones it will never meet.
 */
export async function join({ code, at, name, port = 8787 }) {
  if (loadNetwork()) {
    throw new Error('this machine is already in a network - run `helm leave` first');
  }
  const base = at.replace(/\/$/, '');
  const res = await fetch(`${base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: name || hostname() }),
  });
  if (!res.ok) {
    throw new Error(`could not join: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
  }

  const { id, key, machines, devices, revoked, self: inviter } = await res.json();
  joinNetwork({ id, key, name: name || hostname(), port, machines, devices, revoked });

  // We just reached the inviter at `base`, which is not necessarily an address
  // it knows to advertise about itself - it cannot see itself from out here.
  // Credit it to the inviter alone: giving every machine every address was
  // wrong, and made each of them look reachable at the others' addresses.
  const net = loadNetwork();
  const host = net.machines[inviter];
  if (host && !(host.endpoints ?? []).includes(base)) {
    host.endpoints = [...(host.endpoints ?? []), base];
    saveNetwork(net);
  }

  return net;
}

// ----------------------------------------------------------------- printing

function report({
  net, hub, daemon, port, publicUrl, fresh, webRoot, tunnelError, tunnelKind,
  tunnelChanged, host,
}) {
  // Everything this machine answers on, however we came to know it: LAN
  // addresses we found ourselves, a tunnel we opened, an address supplied
  // with --advertise. None of it belongs under "other hubs".
  const mine = net.machines[net.self]?.endpoints ?? [];
  const lan = ['127.0.0.1', '::1', 'localhost'].includes(host)
    ? []
    : lanAddresses().map((a) => `http://${a.address}:${port}`);
  const others = allEndpoints(net).filter(
    (e) => !mine.includes(e) && !lan.includes(e) && e !== publicUrl
  );
  const advertised = mine.filter((e) => !lan.includes(e));
  const primary = publicUrl ?? advertised[0] ?? lan[0] ?? `http://127.0.0.1:${port}`;
  const rule = '-'.repeat(Math.max(primary.length, 26) + 4);
  const mins = Math.max(1, Math.round((hub.expiresAt - Date.now()) / 60000));
  const machines = Object.keys(net.machines).length;

  console.log(`\n  ${rule}`);
  console.log(`    open on your phone:  ${primary}`);
  console.log(`    password:            ${hub.password}   (valid ${mins} min)`);
  console.log(`  ${rule}\n`);

  if (fresh) {
    console.log(`  Started a new network. "${daemon.name}" is its first machine.`);
    console.log('  Add another with:  helm invite\n');
  } else {
    console.log(`  ${machines} machine${machines === 1 ? '' : 's'} in this network.`);
  }

  if (lan.length) console.log(`  On this network:   ${lan.join('  ')}`);
  if (others.length) console.log(`  Other machines:    ${others.join('  ')}`);

  if (!publicUrl && !advertised.length && !others.length) {
    console.log('\n  Reachable on this network only. To install the app to a phone');
    console.log('  home screen you need https - either add a machine with a public');
    console.log('  address, or run once with --tunnel.');
  }
  if (tunnelKind === 'permanent') {
    console.log('\n  This link is permanent - add it to your phone home screen.');
  } else if (tunnelKind === 'unproven') {
    if (tunnelChanged) {
      console.log(`\n  ! The link changed (was ${tunnelChanged}).`);
      console.log('    Anything installed from the old one cannot reach this.');
      console.log('    Claim a free domain in your ngrok dashboard and pass');
      console.log('    --domain <that> to pin it.');
    } else {
      console.log('\n  Run this once more before installing to a home screen,');
      console.log('  to confirm the link is the same every time.');
    }
  } else if (tunnelKind === 'temporary') {
    console.log('\n  ! This link is TEMPORARY. It changes every restart, so');
    console.log('    do not add it to a home screen - use it to reach this');
    console.log('    machine today. For one worth keeping, see: helm up --help');
  }
  if (tunnelError) {
    console.log(`\n  ! no public address.\n`);
    console.log(tunnelError.split('\n').map((l) => `    ${l}`).join('\n'));
    console.log('\n    Carrying on without one - this machine is still reachable');
    console.log('    from any other machine in the network, and on this network.');
  }
  if (!webRoot) {
    console.log('\n  ! the web app is not built - run: npm --workspace @helm/web run build');
  }

  console.log('\n  The password expires. Devices you have already added do not -');
  console.log('  they stay until you remove them, and survive restarts.');
  console.log(`\n  Serving ${daemon.name}. Leave this running; ctrl-c to stop.\n`);
}

// The old name, kept so existing service units and scripts keep working.
export const serve = up;
