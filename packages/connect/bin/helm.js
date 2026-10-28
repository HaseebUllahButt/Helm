#!/usr/bin/env node
import { hostname, platform } from 'node:os';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { argv, exit } from 'node:process';
import {
  loadNetwork, requireNetwork, forgetNetwork, revoke, allEndpoints, hubCredential,
  localKey, describeSelf, saveNetwork, machineKind, MACHINE_KINDS,
  createNetwork,
} from '@helm/protocol/network';
import { HELM_DIR, expand } from '../src/paths.js';
import { M, CONTROLLER_WORDS, CONTROLLER_REFUSAL } from '@helm/protocol';
import { brainHost } from '@helm/protocol/brain-host';
import { hubRpc, hubBroadcastRpc, mergeQueueReceipts } from '../src/hub-client.js';
import { USAGE, OVERVIEW, commandHelp, wantsHelp } from '../src/help.js';
import { reliableInput } from '@helm/protocol/reliable-input';
import {
  render, shortId, readThread, readSnapshot, writeSnapshot, mergeSnapshot, findNetworkSession,
} from '../src/brain.js';

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

const usage = () => console.log(OVERVIEW);

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
const port = () => Number(strFlag('port', loadNetwork()?.port ?? 8787));

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
          authorization: `Bearer ${await hubCredential(net, base)}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      // A body that is not JSON is not an answer, even with a 200 on it.
      // Caddy in front of a hub that is still starting, or any proxy with an
      // interstitial, will hand back HTML - and treating that as `{}` is how
      // `helm link` once printed `#pair=undefined`, valid for NaN minutes,
      // instead of saying the home was unreachable and trying the next
      // address.
      const text = await res.text();
      let value;
      try { value = JSON.parse(text); }
      catch { throw new Error(`${base} answered ${res.status} but not JSON`); }
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

async function printDeviceLink(args = rest) {
  const net = requireNetwork();
  const mins = Number(args[0]);
  const ttlMs = Number.isFinite(mins) && mins > 0 ? mins * 60_000 : undefined;
  const { base, value } = await postToHome(net, '/api/auth/rotate', { ttlMs });
  if (!value.password) throw new Error('your Helm home did not hand back a password');
  const pairUrl = `${base}/#pair=${encodeURIComponent(value.password)}`;
  const valid = Math.max(1, Math.round((value.expiresAt - Date.now()) / 60_000));
  const { terminalQr } = await import('../src/qr-terminal.js');
  console.log(`\n  Scan this code with the phone you want to add, or open the link on it:\n`);
  console.log(terminalQr(pairUrl).split('\n').map((line) => `    ${line}`).join('\n'));
  console.log(`\n    ${pairUrl}\n`);
  console.log(`  It expires in ${valid} minute${valid === 1 ? '' : 's'}.`);
  console.log('  The device stays signed in until you remove it.\n');
}

/**
 * The app, on the machine you are sitting at.
 *
 * No pairing link: the local key in ~/.helm signs this browser in, which is
 * the same trust as being able to read the network key beside it. This is
 * what makes a laptop a controller for every other machine, the VM included.
 */
async function openApp() {
  const net = requireNetwork();
  const url = `http://127.0.0.1:${net.port ?? 8787}/#local=${encodeURIComponent(localKey())}`;
  console.log(`\n    ${url}\n`);
  const opener = platform() === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('  (open that in a browser)\n'));
  child.unref();
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

/**
 * The one shape a Helm home address may take: a bare https origin.
 *
 * https is not optional - the app is installed to home screens and
 * notifications only exist behind a real certificate - and a path or query
 * is never part of the answer, so both are refused rather than silently
 * carried along. Shared by `helm setup` and `helm redesignate vm`.
 */
function checkHome(home) {
  let url;
  try { url = new URL(home); } catch { die(`The home address is not valid: ${home}`); }
  if (url.protocol !== 'https:') die('Start the Helm home address with https://.');
  if (url.pathname !== '/' || url.search || url.hash) {
    die('Use an address without a path, such as https://helm.example.com.');
  }
}

async function up() {
  if (rest.includes('--install')) {
    const { installService } = await import('../src/service.js');
    const args = rest.filter((a) => a !== '--install');
    const { installed, unit } = await installService({ mode: 'serve', args });
    if (installed) {
      console.log(`\n  Helm installed ${unit}. Helm starts when this machine starts.`);
      console.log('  Read logs with: journalctl --user -u helm-serve -f');
      console.log('  Stop it with: helm service uninstall --serve\n');
    }
    return;
  }

  // Helm never follows GitHub by itself any more: a self-hosted install is
  // the owner's to change. Machines keep each other on the newest version
  // the owner saved; the GitHub timer earlier versions installed goes.
  if (process.env.INVOCATION_ID) {
    import('../src/update.js').then((m) => m.removeUpdateTimer()).catch(() => {});
  }

  if (!process.env.HELM_NATIVE_BYPASS) {
    const report = (err) => console.error(`helm: native CLI integration: ${err.message}`);
    try {
      const { integrateNativeCommands } = await import('../src/native-cli.js');
      // Also picks up a CLI installed since the last start.
      try { integrateNativeCommands(); } catch (err) { report(err); }
    } catch (err) { report(err); }
  }
  if (platform() === 'linux') {
    // A new logo reaches the launcher too, not only the app.
    import('../src/desktop.js').then((m) => m.refreshAppIcons())
      .catch((err) => console.error(`helm: app icons: ${err.message}`));
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

  const started = await bringUp({
    port: port(),
    password: strFlag('password'),
    name: strFlag('name'),
    tunnel,
    domain: strFlag('domain'),
    advertise: allFlags('advertise'),
    host: strFlag('host', '0.0.0.0'),
    temporary: rest.includes('--temporary'),
  });
  if (platform() === 'linux') {
    // An older launcher opens Helm under Chromium's bar; update it in the background.
    // The window frame follows the desktop, which can change between starts.
    import('../src/desktop.js').then(async (m) => {
      const r = await m.refreshAppLauncher({ url: `http://127.0.0.1:${started.port}/` });
      if (r.updated) console.log('helm: the Helm app now opens with its own top row');
      m.syncWindowFrame({ onChange: () => console.log('helm: the Helm app window frame now suits this desktop') });
    }).catch((err) => console.error(`helm: app launcher: ${err.message}`));
  }
}

/**
 * `helm add <what>`.
 *
 * Three things can join, and they are different enough that naming them is
 * the whole point: a controller is a screen with no agents on it, a pc runs
 * agents and drives others, a vm also is somewhere to dial. Only a
 * controller gets a link to open; the machines get a code to type.
 *
 * CONTROLLER_WORDS comes from the protocol: the set means the same thing in
 * `helm redesignate`, where a controller is refused rather than invited.
 */
const MACHINE_WORDS = { pc: 'pc', laptop: 'pc', vm: 'vm' };

async function add() {
  const what = (rest.find((a) => !a.startsWith('--')) || '').toLowerCase();

  if (CONTROLLER_WORDS.includes(what)) return printDeviceLink(rest.slice(1));
  if (MACHINE_WORDS[what]) return inviteMachine(MACHINE_WORDS[what]);

  console.log('\n  Pick a device to add.\n');
  console.log('    helm add controller    Add a phone or browser to control machines.');
  console.log('    helm add pc            Add a computer to run agents and control machines.');
  console.log('    helm add vm            Add a VM to run agents and accept connections.\n');
  if (what) console.log(`  ("${what}" is none of those.)\n`);
}

async function inviteMachine(role) {
  const net = requireNetwork();
  const { base: where, value } = await postToHome(net, '/api/invite', { role });
  const { code } = value;
  console.log(`\n  Run this on the ${role === 'vm' ? 'VM' : 'computer'} you want to add:\n`);
  const link = `${where}/#join=${encodeURIComponent(code)}`;
  console.log('    helm join');
  console.log(`    Paste this link: ${link}\n`);
  console.log(`  Or run: helm join '${link}'\n`);
  if (role === 'vm') {
    console.log('  This machine gets its own HTTPS address.');
    console.log('  Other machines can connect to it and this home.');
  } else {
    console.log('  This machine connects to this Helm home without its own address.');
  }
  console.log('  The invitation works once and expires in 10 minutes.');
  console.log('  Keep the invitation private. It contains the network key.\n');
}

async function joinCmd() {
  let input = rest[0]?.startsWith('--') ? undefined : rest[0];
  if (!input) {
    if (!process.stdin.isTTY) die('Paste the private link as an argument: helm join \'https://home.example/#join=…\'.');
    const { createInterface } = await import('node:readline/promises');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { input = (await prompt.question('Private join link: ')).trim(); }
    finally { prompt.close(); }
  }
  let code = input;
  let linkAt;
  if (/^https?:\/\//i.test(input || '')) {
    const link = new URL(input);
    code = new URLSearchParams(link.hash.replace(/^#\/?/, '')).get('join');
    if (!code || link.username || link.password || link.pathname !== '/' || link.search) {
      die('Use the private computer invite link with #join= in it.');
    }
    linkAt = link.origin;
  }
  if (!code) die('Enter a private join link.');
  const codeIndex = rest.indexOf(input);
  const positionalAt = rest[codeIndex + 1]?.startsWith('--') ? null : rest[codeIndex + 1];
  const at = linkAt || strFlag('at', positionalAt || process.env.HELM_AT);
  if (!at) die('Set --at to https://host.example, or http://127.0.0.1:8787 for this machine.');

  // Check the runtime before joining, so a machine that cannot actually run
  // agents never shows up in the app as one that can.
  process.stdout.write('Checking agent software... ');
  try {
    const { createRuntime } = await import('../src/runtime/index.js');
    const rt = await createRuntime();
    const info = await rt.ensureReady();
    rt.stop();
    console.log(`herdr ${info.version} (protocol ${info.protocol})`);
  } catch (err) {
    console.log('failed');
    die(`${err.message}\n  install it with: curl -fsSL https://herdr.dev/install.sh | sh`);
  }

  process.stdout.write('Finding agent accounts... ');
  const { refreshProfiles } = await import('../src/profiles.js');
  const { profiles } = await refreshProfiles();
  console.log(`${profiles.length} found`);

  const previous = loadNetwork();
  if (previous && (!previous.provisional || Object.keys(previous.machines).length !== 1)) {
    die('This machine already belongs to a network. Run `helm leave` first.');
  }
  const localPort = Number(strFlag('port', previous?.port ?? 8787));
  const { pauseServices, resumeServices } = await import('../src/service.js');
  const paused = await pauseServices();
  useHubDb();
  let net;
  try {
    const { join: joinNet } = await import('../src/serve.js');
    net = await joinNet({ code, at, name: strFlag('name', hostname()), port: localPort });
  } catch (err) {
    await resumeServices(paused);
    throw err;
  }
  console.log(`\n  This machine joined the network. The network has ${Object.keys(net.machines).length} machines.`);

  // An invite made with `helm add vm` says so, and a vm is a home: it needs an
  // address of its own and https in front of it, which is the rest of what
  // `helm setup` does. Nobody has to remember a second command for it.
  if (net.role === 'vm') {
    console.log('  This machine joins as a VM and becomes a Helm home.\n');
    await setup({ alreadyJoined: true });
    return;
  }

  // A joined machine should stay reachable after this terminal closes, the
  // same as `helm setup` does for the home - so install the service rather
  // than serving in the foreground. `--foreground` keeps the old behaviour.
  if (!rest.includes('--foreground')) {
    const { installService } = await import('../src/service.js');
    // `--host` is written out rather than left to the default, because what it
    // means here is worth being able to see and change in one place. A pc
    // listens on every interface on purpose: a phone on the same wifi reaching
    // this machine directly is single-digit milliseconds against hundreds
    // through the VM. The cost is that the hub is plain http on whatever
    // network this machine is currently joined to, and a device token crosses
    // it in the clear - so on a network you do not trust, reinstall with
    // `helm up --install --host 127.0.0.1` and reach this machine through the
    // VM instead.
    const host = rest.includes('--host') ? strFlag('host', '0.0.0.0') : '0.0.0.0';
    const args = [
      ...(rest.includes('--name') ? ['--name', strFlag('name', hostname())] : []),
      '--host', host,
      '--port', String(localPort),
    ];
    const { installed, unit } = await installService({ mode: 'serve', args });
    if (installed) {
      console.log(`  Helm installed ${unit}. This machine stays in the network after restarts.`);
      await waitForLocal(net);
      if (host === '0.0.0.0') {
        console.log('  Phones on the same Wi-Fi can connect directly to this machine.');
        console.log('  Reinstall with this command on a network you do not trust:');
        console.log('    helm up --install --host 127.0.0.1');
      }
      await installLocalApp(net);
      console.log('\n  This computer and its web app joined the network.');
      console.log(`  Open http://127.0.0.1:${localPort}/ or run helm open.`);
      console.log('  Check status with: helm status');
      console.log('  Read logs with: journalctl --user -u helm-serve -f');
      console.log('  Stop the service, then run helm up to use this terminal.\n');
      return;
    }
  }
  console.log('  Starting Helm on this machine...\n');
  await up();
}

async function installLocalApp(net) {
  if (platform() !== 'linux') return;
  const { installApp, installWebApp } = await import('../src/desktop.js');
  try {
    const url = `http://127.0.0.1:${net.port ?? 8787}/`;
    installApp({ url, appId: await installWebApp({ url }) });
    console.log('  Helm is in your applications, already signed in.');
  } catch (err) { console.log(`  Helm did not add the app launcher: ${err.message}`); }
}

async function startInstalled() {
  let net = loadNetwork();
  if (!net) {
    net = createNetwork({ name: strFlag('name', hostname()), port: port() });
    // Installation starts a usable local Helm. The first join replaces this
    // temporary network without an intervening leave/setup command.
    net.provisional = true;
    net.role = 'pc';
    describeSelf(net, { kind: 'pc' });
    saveNetwork(net);
  }
  localKey();
  const { startService } = await import('../src/service.js');
  const { installed } = await startService({ port: net.port ?? 8787 });
  if (!installed) die('Helm cannot start the background service on this platform.');
  await waitForLocal(net);
  await installLocalApp(net);
  console.log('\n  Helm is active. Run helm join, then paste your private join link.\n');
}

async function waitForLocal(net) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${net.port ?? 8787}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok && (await res.json()).network === net.id) return;
    } catch { /* the service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the background service did not become ready - check helm status and its logs');
}

async function setup({ alreadyJoined = false } = {}) {
  // Joining an existing mesh is opt-in: `--join <code> --at <existing-home>`.
  // A code needs somewhere to redeem it, so the two travel together. Any bare
  // positional is still THIS machine's own https address, exactly as when
  // founding a network, so a second VM reads the same way as the first.
  //
  // `helm join` with a vm invite arrives here having already joined, and only
  // wants the rest: an address, https in front of it, and the service.
  const joinCode = alreadyJoined || typeof flagOf('join') !== 'string'
    ? null
    : strFlag('join');
  if (!alreadyJoined && rest.includes('--join') && !joinCode) {
    die('--join needs an invite code: helm setup --join ABCD-1234 --at https://home.example');
  }
  const joinAt = joinCode ? cleanEndpoint(strFlag('at', process.env.HELM_AT)) : null;
  if (joinCode && !joinAt) {
    die('Set --at to https://your-existing-home.');
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
  // Arriving from `helm join`, the positionals are the invite code and the
  // home it was redeemed at - neither of which is this machine's own address.
  // Take one only from --advertise there, or work it out below.
  let home = alreadyJoined
    ? cleanEndpoint(strFlag('advertise'))
    : cleanEndpoint(rest.find((a, i) => !a.startsWith('--') && !flagValues.has(i)));
  if (!home) {
    const { claimFreeHttps } = await import('../src/caddy.js');
    home = await claimFreeHttps(port(), {
      found: (hostname) => {
        console.log(`Using free address: https://${hostname}`);
        console.log('You do not need a website, paid domain or DNS setup.');
        console.log('Setting up HTTPS with Caddy. Enter your password if sudo asks.');
      },
    });
  }
  checkHome(home);

  // Join the existing mesh before the service starts, so it comes up already
  // holding the shared key rather than founding a network of its own. Skipped
  // when this machine is already a member, which is what makes setup re-runnable.
  if (joinCode) {
    const existing = loadNetwork();
    if (existing && !existing.provisional) {
      console.log(`This machine already belongs to network ${existing.id}. Helm is sharing its address again: ${home}.`);
      console.log('Run `helm leave` before joining another network.');
    } else {
      process.stdout.write(`Joining the network at ${joinAt}... `);
      const { pauseServices, resumeServices } = await import('../src/service.js');
      const paused = await pauseServices();
      try {
        useHubDb();
        const { join: joinNet } = await import('../src/serve.js');
        const net = await joinNet({
          code: joinCode, at: joinAt, name: strFlag('name', hostname()), port: port(),
        });
        console.log(`joined (${Object.keys(net.machines).length} machines).`);
      } catch (err) {
        await resumeServices(paused);
        console.log('failed');
        die(err.message);
      }
    }
  }

  const { installService } = await import('../src/service.js');
  const result = await installService({
    mode: 'serve',
    args: ['--advertise', home, '--host', '127.0.0.1', '--port', String(port())],
  });
  if (!result.installed) return;

  process.stdout.write('Waiting for your Helm home... ');
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
    die(`Nothing answered at ${home}\n` +
        '  helm:   journalctl --user -u helm-serve -n 50\n' +
        '  https:  sudo journalctl -u caddy -n 50   (ports 80 and 443 must be open)');
  }
  console.log('ready');

  // The thing `helm setup` means: this machine is the network's home. Say so
  // on its record too - it answers "what is this machine for" the same way
  // the address above answers "where is it", and a network founded before
  // kinds existed learns it here without a separate command.
  {
    const net = loadNetwork();
    if (net) {
      net.role = 'vm';
      describeSelf(net, { kind: 'vm' });
      saveNetwork(net);
    }
  }

  if (joinCode) {
    const net = loadNetwork();
    const count = net ? Object.keys(net.machines).length : 0;
    console.log(`\n  This VM joined the network at ${home}.`);
    console.log(`  The network has ${count} machine${count === 1 ? '' : 's'}.`);
    console.log('  Devices signed in to this network can reach this VM.');
    console.log('  Devices can use this VM if another home stops working.\n');
    return;
  }
  await printDeviceLink();
}

function listDevices() {
  const net = requireNetwork();
  const devices = Object.values(net.devices);
  if (!devices.length) {
    console.log('Run `helm login` and sign in from a phone. This network has no control devices.');
    return;
  }
  for (const d of devices) {
    console.log(`${short(d.id)}  ${(d.label || 'device').padEnd(16)} added ${ago(d.addedAt)}`);
  }
}

// ------------------------------------------------------------------ dictate

const DICTATE_PID = '/tmp/helm-dictate.pid';
const DICTATE_WAV = '/tmp/helm-dictate.wav';
const DICTATE_OPUS = '/tmp/helm-dictate.ogg';

/** Say it on the desktop too, the way the owner's own binding already does. */
const notify = (body, urgent = false) => {
  try {
    spawn('notify-send', [...(urgent ? ['-u', 'critical'] : []), 'helm dictate', body], { stdio: 'ignore' }).unref();
  } catch { /* no notification daemon: the terminal output is the fallback */ }
};

/** The first of these that exists. pipewire on this desktop, ALSA elsewhere. */
function recorder() {
  for (const [cmd, args] of [
    ['pw-record', ['--rate=16000', '--channels=1', DICTATE_WAV]],
    ['arecord', ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', DICTATE_WAV]],
  ]) {
    try { if (execFileSync('sh', ['-c', `command -v ${cmd}`]).toString().trim()) return { cmd, args }; }
    catch { /* not installed */ }
  }
  return null;
}

/** Opus if ffmpeg is here, the original WAV if it is not. */
function compress(wav) {
  try {
    execFileSync('sh', ['-c', 'command -v ffmpeg']);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', DICTATE_WAV, '-c:a', 'libopus', '-b:a', '24k', DICTATE_OPUS]);
    const small = readFileSync(DICTATE_OPUS);
    rmSync(DICTATE_OPUS, { force: true });
    if (small.length && small.length < wav.length) return { audio: small, mime: 'audio/ogg' };
  } catch { /* no ffmpeg, or it refused the file: the WAV is fine */ }
  return { audio: wav, mime: 'audio/wav' };
}

/**
 * Transcribe through whichever machine holds a key.
 *
 * This machine first: it is a loopback call and needs no network at all. Then
 * any other that says it can, which is what makes a machine with no key of its
 * own still able to dictate.
 */
async function transcribeSomewhere(audio, mime) {
  const net = requireNetwork();
  const machines = Object.values(net.machines ?? {});
  const order = [net.self, ...machines.map((m) => m.id).filter((id) => id !== net.self)];
  const failures = [];
  for (const id of order) {
    try {
      const r = await hubRpc(net, id, M.VOICE_TRANSCRIBE, { audio, mime }, { timeout: 60_000 });
      return { text: r.text, via: net.machines[id]?.name ?? id };
    } catch (err) { failures.push(`${net.machines[id]?.name ?? id}: ${err.message}`); }
  }
  die(`No machine turned that speech into text:\n  ${failures.join('\n  ')}`);
}

/**
 * Speak a prompt, from a keyboard shortcut.
 *
 * One verb, toggled, because it is bound to one key: the first press starts
 * recording and the second stops it and sends the words somewhere. The owner's
 * existing Super+D binding needed two (start, then Super+Shift+D) and put the
 * result in the clipboard to be pasted; this puts it straight into a session.
 *
 * The recording is made here because this is where the microphone is - the VM
 * has no sound card - while the key may live on any machine. Those are two
 * different machines in this network more often than not.
 */
async function dictate() {
  const to = flagOf('to');

  if (existsSync(DICTATE_PID)) {
    const pid = Number(readFileSync(DICTATE_PID, 'utf8').trim());
    // SIGINT, not SIGKILL: pw-record has to finish writing the WAV header, and
    // a killed recording is a file no decoder will take.
    try { process.kill(pid, 'SIGINT'); } catch { /* already gone */ }
    rmSync(DICTATE_PID, { force: true });
    // Give it a moment to flush before the file is read.
    await new Promise((r) => setTimeout(r, 350));

    let audio;
    try { audio = readFileSync(DICTATE_WAV); } catch { audio = null; }
    if (!audio?.length) { notify('Helm recorded no sound.', true); die('Helm recorded no sound.'); }

    // Nothing reached the microphone: say so here rather than paying Groq to
    // hallucinate a "Thank you." into the owner's prompt.
    const { levelOfWav, SILENCE_RMS } = await import('../src/voice.js');
    const level = levelOfWav(audio);
    if (level && level.rms < SILENCE_RMS) {
      rmSync(DICTATE_WAV, { force: true });
      notify('Helm heard no speech. Check that the microphone is on.', true);
      die(`Nothing was said (loudness ${level.rms.toFixed(4)}, silence is under ${SILENCE_RMS}) - is the microphone muted, or the wrong input selected?`);
    }

    notify('transcribing…');
    // Raw 16kHz WAV is about ten times the size of the same speech as Opus,
    // and every one of those bytes is carried to another machine and then to
    // Groq. Measured on a 12-second clip: 4.9s as WAV, 0.8s as Opus, for the
    // same words. Compression costs ~100ms and is skipped when ffmpeg is not
    // installed, because sending the WAV still works.
    const { audio: body, mime } = compress(audio);
    const { text, via } = await transcribeSomewhere(body.toString('base64'), mime);
    rmSync(DICTATE_WAV, { force: true });
    if (!text) { notify('Helm heard no speech.', true); die('Helm heard no speech.'); }

    if (to) {
      const { env, machine, session } = await findSession(to);
      await brainRpc(env, M.SESSION_INPUT, { id: session.id, data: text });
      notify(`sent to ${session.title}: ${text}`);
      console.log(`${machine} ${shortId(session.id)} (${session.title}) <- ${text}`);
      return;
    }
    // No destination: the clipboard, which is what the owner's own script
    // does and what makes this useful in a browser helm does not own.
    try { const c = spawn('wl-copy', ['-t', 'text/plain'], { stdio: ['pipe', 'ignore', 'ignore'] }); c.stdin.end(text); } catch { /* no wayland clipboard */ }
    notify(`in the clipboard (via ${via}): ${text}`);
    console.log(text);
    return;
  }

  const rec = recorder();
  if (!rec) die('Install pipewire (pw-record) or alsa-utils (arecord) to record sound.');
  rmSync(DICTATE_WAV, { force: true });
  const child = spawn(rec.cmd, rec.args, { stdio: 'ignore', detached: true });
  child.unref();
  writeFileSync(DICTATE_PID, String(child.pid));
  notify(to ? `recording for ${to}… press the key again to send` : 'recording… press the key again to transcribe');
  console.log(`Recording with ${rec.cmd}. Run \`helm dictate${to ? ` --to ${to}` : ''}\` again to stop.`);
}

// ------------------------------------------------------------------- brain
//
// The network, addressable from a shell. The brain uses these; so can a
// person, which is the reason they print rather than return JSON by default.

const brainRpc = (env, method, params = {}, timeout = 25_000) =>
  untilBack(env, () => hubRpc(requireNetwork(), env, method, params, { timeout }));

// A machine restarting Helm answers nothing for a minute or so. While no
// request has gone out, waiting and asking again is safe, and beats telling
// an agent its helper is gone. Anything that may have arrived is not retried.
// Only this machine, or one seen moments ago, is worth the wait; one that has
// been off for an hour gets a quick answer instead.
const WAIT_FOR_MACHINE_MS = 90_000;
const RECENTLY_SEEN_MS = 5 * 60_000;
function worthWaiting(env) {
  if (env === requireNetwork().self) return true;
  return Date.now() - (readSnapshot().machines?.[env]?.at ?? 0) < RECENTLY_SEEN_MS;
}
let toldWaiting = false;
function waitingFor(names) {
  if (toldWaiting) return;
  toldWaiting = true;
  process.stderr.write(`${names} is restarting or busy - retrying for up to ${WAIT_FOR_MACHINE_MS / 1000}s...\n`);
}
async function untilBack(env, call) {
  const deadline = Date.now() + WAIT_FOR_MACHINE_MS;
  for (let delay = 1000; ; delay = Math.min(delay * 2, 10_000)) {
    try {
      return await call();
    } catch (err) {
      if (err.code !== 'unreachable' || !worthWaiting(env) || Date.now() + delay > deadline) throw err;
      waitingFor(requireNetwork().machines?.[env]?.name ?? env);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** A machine by name, short id or full id. */
function machineId(who) {
  const net = requireNetwork();
  const all = Object.values(net.machines ?? {});
  const want = String(who ?? '').toLowerCase();
  const hit = all.find((m) => m.id === who)
    || all.find((m) => m.name.toLowerCase() === want)
    || all.find((m) => m.id.startsWith(want))
    || all.find((m) => m.name.toLowerCase().startsWith(want));
  if (!hit) die(`No machine called "${who}" - try: ${all.map((m) => m.name).join(', ')}.`);
  return hit.id;
}

/** The same home from every terminal, including on the VM itself. */
function brainHome() {
  const net = requireNetwork();
  const vm = brainHost(net.machines);
  if (!vm) die('The Helm brain needs a VM in the network. Set one with `helm redesignate <machine> vm`.');
  if (flagOf('on') && machineId(flagOf('on')) !== vm.id) die(`The Helm brain lives on ${vm.name}. Use \`helm spawn\` for work on another machine.`);
  return vm.id;
}

/** Ask every machine for its digest and write the snapshot down. */
async function gather() {
  const net = requireNetwork();
  const fresh = {};
  await Promise.all(Object.keys(net.machines ?? {}).map(async (id) => {
    try {
      // An offline machine has several dead addresses; trying each for the
      // full 8 s made the whole digest wait 20 s for nothing.
      const r = await hubRpc(net, id, M.BRAIN_DIGEST, {}, { timeout: 8000, budget: 6000 });
      fresh[id] = { name: r.name ?? net.machines[id]?.name ?? id, sessions: r.sessions ?? [], projects: r.projects ?? [] };
    } catch { /* offline: the snapshot keeps what it had, dated */ }
  }));
  const snap = writeSnapshot(mergeSnapshot(readSnapshot(), fresh));
  const now = Date.now();
  const roster = Object.fromEntries(Object.values(net.machines ?? {}).map((m) =>
    [m.id, { name: m.name, online: now - (snap.machines?.[m.id]?.at ?? 0) < 90_000 }]));
  return { snap, roster };
}

/**
 * `helm search <words>`: which chat, on which machine, said these words. Every
 * machine answers from its own index (search-index.js); an offline one is
 * named as such rather than silently missing.
 */
async function printSearch() {
  const json = rest.includes('--json');
  const query = rest.filter((a) => a !== '--json').join(' ').trim();
  if (!query) { console.error('usage: helm search <words...> [--json]'); process.exitCode = 2; return; }
  const net = requireNetwork();
  const machines = Object.values(net.machines ?? {});
  const results = []; const offline = [];
  await Promise.all(machines.map(async (m) => {
    try {
      const r = await hubRpc(net, m.id, M.SESSION_SEARCH, { query, limit: 20 }, { timeout: 15_000, budget: 10_000 });
      for (const hit of r.results ?? []) results.push({ ...hit, machine: m.name, machineId: m.id });
    } catch { offline.push(m.name); }
  }));
  results.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  if (json) { console.log(JSON.stringify({ query, results, offline }, null, 2)); return; }
  if (!results.length) console.log(`No chats match "${query}"${offline.length ? ` on the machines that answered` : ''}.`);
  for (const hit of results) {
    const where = hit.quick ? 'quick chat' : hit.cwd.replace(/^\/(home|Users)\/[^/]+/, '~');
    const who = hit.who === 'you' ? 'you' : hit.who === 'agent' ? 'agent' : 'title';
    console.log(`${hit.id.slice(0, 6)}  ${hit.machine}  ${where}  ${hit.title}${hit.archived ? '  (Settled)' : ''}`);
    if (hit.snippet) console.log(`        ${who}: ${hit.snippet}`);
  }
  if (offline.length) console.log(`\nMachines offline: ${offline.join(', ')}`);
}

async function printDigest() {
  const { snap, roster } = await gather();
  if (rest.includes('--json')) {
    console.log(JSON.stringify({ machines: roster, snapshot: snap }, null, 2));
    return;
  }
  console.log(render(snap, { roster }));
}

/**
 * Which session does this id mean, and on which machine?
 *
 * Ids are short in the digest because they are meant to be typed. Two
 * machines could in principle both hold one starting with the same six
 * characters, so an ambiguous id is an error that lists the candidates -
 * never a guess, because guessing here sends a prompt to the wrong agent.
 */
async function findSession(id) {
  const net = requireNetwork();
  return findNetworkSession(id, {
    machines: net.machines,
    snapshot: readSnapshot(),
    // Every route to this machine ends at the same daemon, so it gets one
    // long try. Another machine's hubs each get half the budget, so one slow
    // hub (a busy local one relaying) cannot use it all before the next.
    rpc: (env, method, params) => hubRpc(net, env, method, params,
      env === net.self ? { timeout: 10_000, budget: 10_000 } : { timeout: 4000, budget: 8000 }),
    waitMs: WAIT_FOR_MACHINE_MS,
    waitFor: worthWaiting,
    onWait: waitingFor,
  });
}

async function printThread() {
  const { env, machine, session } = await findSession(rest[0]);
  const n = Number(flagOf('n', flagOf('tail', 40)));
  // The tail: this prints the last n lines of a conversation, and a page is
  // budgeted in bytes now - asking from event 1 would spend it on the oldest
  // part of a long thread and print none of what was asked for.
  const r = await brainRpc(env, M.SESSION_EVENTS, { id: session.id, tail: 1000, limit: 1000 });
  const linked = r.session ?? session;
  console.log(`${machine}  ${session.id}  ${session.title}`);
  console.log(`${session.engine}${session.model ? ` (${session.model})` : ''} in ${session.cwd} - ${session.status}`);
  if (linked.parent) console.log(`handoff parent: ${linked.parent.machineId}/${linked.parent.sessionId}`);
  if (linked.children?.length) {
    console.log(`handoff children: ${linked.children.map((x) => `${x.machineId}/${x.sessionId}`).join(', ')}`);
  }
  console.log('');
  for (const line of readThread(r.events ?? [], { limit: Math.max(1, n) })) console.log(line);
  const open = (r.pending ?? []).length;
  if (open) console.log(`\nAnswer ${open} approval request${open === 1 ? '' : 's'}. Answer in the app, or use \`helm say\` for text answers.`);
}

async function say() {
  if (process.env.HELM_SESSION_ID) {
    const { runMessageCommand } = await import('../src/agent-message-cli.js');
    return runMessageCommand('say', rest, { rpc: brainRpc, self: requireNetwork().self, findSession });
  }
  const [id, ...words] = rest.filter((x) => !x.startsWith('--'));
  const text = words.join(' ');
  if (!text) die('Enter a message with `helm say <id> <text>`.');
  const { env, machine, session } = await findSession(id);
  await reliableInput((method, params, timeout) => hubRpc(requireNetwork(), env, method, params,
    { timeout, budget: timeout }), { id: session.id, data: text }, { onRetry: () => waitingFor(machine) });
  console.log(`Sent to ${machine} ${shortId(session.id)} (${session.title}).`);
}

async function deleteChat() {
  const id = rest.find((x) => !x.startsWith('-'));
  if (!id) die('Pick a chat: `helm delete <id>`. Run helm digest to list chats.');
  const { env, machine, session } = await findSession(id);
  const own = process.env.HELM_SESSION_ID;
  if (own && session.id.startsWith(own)) die('that is the chat you are running in');
  // Agents told to clean up once read their helpers as test chats and
  // deleted every one, so the owner found the chat's Agents list empty.
  if (own && session.delegation?.parentId && !rest.includes('--helper')) {
    die('That chat is a helper. Keep it: the owner reads helpers under their chat. Add --helper only when the owner asks you to delete it.');
  }
  await brainRpc(env, M.SESSION_KILL, { id: session.id }, 20_000);
  console.log(`Deleted ${machine} ${shortId(session.id)} (${session.title}).`);
}

async function spawn_() {
  const { spawnAgent, parseSpawnArgs } = await import('../src/spawn-cli.js');
  const { machine } = parseSpawnArgs(rest);
  const env = machineId(machine);
  await spawnAgent(rest, { rpc: (method, params, timeout) => brainRpc(env, method, params, timeout),
    write: (text) => process.stdout.write(text) });
}

/**
 * Queue the current task on another machine.
 *
 * The provider credential deliberately does not travel. The target uses one
 * of its own profiles, which must already be authenticated there. When this
 * runs inside a Helm session the source session's tail becomes bounded,
 * redacted context in the prompt; from a plain shell it carries the folder
 * and the typed text, nothing more.
 *
 * The request is durably stored on every reachable home, so the target only
 * has to connect to one of them to receive it. A queued task outlives this
 * process: "queued" is a result, not a failure.
 */
async function handoff() {
  const {
    createCodeSnapshot, sealCodeSnapshot, beginCodeKeyProof, verifyCodeKeyProof,
    signHandoffDigest,
  } = await import('../src/code-transfer.js');
  const { handoffRequestDigest } = await import('../src/handoffs.js');
  const valueFlags = new Set(['--folder', '--target-folder', '--source-folder', '--account', '--model', '--mode', '--title', '--handoff-id']);
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { args.push(rest[i]); continue; }
    if (valueFlags.has(rest[i])) i++;
  }
  const who = args.shift();
  if (!who) die('usage: helm dispatch <machine> [text...]');

  const net = requireNetwork();
  const target = machineId(who);
  if (target === net.self) die('The task move target is this machine.');

  // Inside a Helm-managed session the source session's context and parent
  // link travel with the work. Outside one there is nothing to link back
  // to, and the target profile has to be named explicitly.
  const sourceId = process.env.HELM_SESSION_ID;
  const explicitAccount = rest.includes('--account');

  const sourceFolder = strFlag('source-folder', process.env.HELM_CWD || process.cwd());
  const handoffId = strFlag('handoff-id', randomBytes(12).toString('hex'));
  if (!/^[a-f0-9]{24}$/.test(handoffId)) {
    die('Set --handoff-id to 24 characters: 0–9 and a–f.');
  }
  const requestedTargetFolder = strFlag('target-folder', strFlag('folder', ''));
  const sourceName = net.machines[net.self]?.name ?? 'the source machine';
  const targetName = net.machines[target]?.name ?? who;

  // Which of the target's profiles runs the work. An explicit --account is
  // taken verbatim - the target validates it when the job lands, which is
  // also the fallback when the target cannot be asked right now.
  let profile = null;
  let profileId;
  if (explicitAccount) {
    profileId = strFlag('account', '');
    if (!profileId) die('Set --account to an account ID.');
  } else if (sourceId) {
    const account = strFlag('account', process.env.HELM_PROFILE_ID || '');
    let targetProfiles = null;
    try {
      targetProfiles = (await brainRpc(target, M.PROFILE_LIST, {})).profiles ?? [];
    } catch (err) {
      if (!/offline|not connected|reach|timed out|ECONN|socket|closed/i.test(err.message)) throw err;
      if (!process.env.HELM_PROFILE_ID) {
        die(`${targetName} is unreachable. Pass --account <target-profile-id>.`);
      }
      console.error(`helm: warning: ${targetName} is unreachable; the profile is used as-is and the target validates it when it connects`);
      profileId = process.env.HELM_PROFILE_ID;
    }
    if (targetProfiles) {
      const wanted = account.toLowerCase();
      const prefixHits = targetProfiles.filter((p) => String(p.id).toLowerCase().startsWith(wanted));
      profile = targetProfiles.find((p) => p.id === account)
        || targetProfiles.find((p) => String(p.account ?? '').toLowerCase() === wanted)
        || (prefixHits.length === 1 ? prefixHits[0] : null);
      if (!profile) {
        die(prefixHits.length > 1
          ? `"${account}" matches ${prefixHits.length} accounts on ${targetName}. Pass --account <profile>.`
          : `No matching authenticated account on ${targetName}. Pass --account <profile>.`);
      }
      profileId = profile.id;
    }
  } else {
    die('Use --account <target-profile-id> outside a Helm chat.');
  }

  // Read the source session first: it is where the inherited mode comes
  // from, and its tail becomes the bounded context in the prompt.
  const source = sourceId
    ? await brainRpc(net.self, M.SESSION_EVENTS, { id: sourceId, tail: 500, limit: 500 })
    : null;
  const engine = process.env.HELM_ENGINE;
  const inheritedMode = profile?.engine === engine ? source?.session?.mode : undefined;

  // The roster key is TOFU-pinned: the first code key gossip teaches for a
  // machine is the one trusted from then on, and a later record cannot
  // swap or drop it. The proof is what makes that pinning worth anything:
  // after the key is learned, nobody can substitute an answer for it
  // without holding the private half. It is opportunistic here - a target
  // that cannot answer right now still gets the work, encrypted to the
  // pinned key - but an answer that proves the wrong key stops the handoff.
  const advertisedCodeKey = net.machines[target]?.codePubkey;
  if (!advertisedCodeKey) {
    die(`${targetName} has no code-transfer key yet. Restart Helm on that machine and try again.`);
  }
  let proof = null;
  try {
    const challenge = beginCodeKeyProof(advertisedCodeKey);
    proof = {
      challenge,
      response: await brainRpc(target, M.CODE_KEY, challenge.request, 8_000),
    };
  } catch (err) {
    if (!/offline|not connected|reach|timed out|ECONN|socket|closed/i.test(err.message)) throw err;
    console.error(`helm: warning: ${targetName} did not answer the key proof; trusting its TOFU-pinned key as-is`);
  }
  if (proof) {
    try {
      verifyCodeKeyProof(advertisedCodeKey, proof.challenge.secret, proof.response);
    } catch (err) {
      die(`Helm did not verify the code transfer key for ${targetName}. Refresh the machine list and retry (${err.message}).`);
    }
  }

  const snapshot = createCodeSnapshot(sourceFolder);
  const targetFolder = requestedTargetFolder ||
    `~/.helm/workspaces/${snapshot.rootName}-${handoffId.slice(0, 8)}`;
  const envelope = sealCodeSnapshot(snapshot, advertisedCodeKey, handoffId);

  const context = source
    ? readThread(source.events ?? [], { limit: 28 })
      .join('\n')
      .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:ghp|gho|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
      .replace(/((?:api[_ -]?key|token|secret|password|private[_ -]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
      .replace(/(?:sk|pk|api|auth|token|secret|key)[-_ ]?[a-z0-9]{8,}/gi, '[redacted]')
      .slice(-12_000)
    : '';
  const request = args.join(' ').trim();
  const prompt = [
    `You are taking over a task from ${sourceName} on ${targetName}.`,
    request || 'Continue the task from the handoff context.',
    `Work in ${targetFolder}. No provider credentials or environment files were transferred; use the authenticated account available on this machine.`,
    context ? `\nHandoff context:\n${context}` : '',
  ].filter(Boolean).join('\n\n');

  // One idempotent request, stored on every reachable home under the same
  // handoff id. Whichever home the target next connects to delivers it;
  // duplicate deliveries converge on the target's own handoff record.
  const sessionTitle = flagOf('title') || `Handoff · ${source?.session?.title ?? 'task'}`;
  const params = {
    handoffId,
    sourceMachineId: net.self,
    targetMachineId: target,
    folder: targetFolder,
    envelope,
    snapshotDigest: snapshot.digest,
    profileId,
    model: flagOf('model'),
    mode: rest.includes('--mode') ? flagOf('mode') : inheritedMode,
    title: sessionTitle,
    prompt,
  };
  if (sourceId) {
    params.parent = {
      handoffId,
      machineId: net.self,
      sessionId: sourceId,
      sourceFolder,
      digest: snapshot.digest,
    };
  }
  // The digest travels inside the request and binds every field above: a
  // hub stores the first payload it saw under this id and refuses any
  // retry whose digest - hence whose contents - differs.
  params.requestDigest = handoffRequestDigest(params);
  // And we sign the digest: at the target, the pinned signing key of the
  // source machine is what proves this request is really ours.
  params.sourceSignature = signHandoffDigest(params.requestDigest);
  const submitted = await hubBroadcastRpc(
    net, target, M.DISPATCH_SUBMIT, { targetMachineId: target, params }, { timeout: 120_000 }
  );

  // The target may be online already: give it a few seconds to run before
  // reporting the task as merely queued. Every home keeps its own copy of
  // the row, so poll them all and take the furthest-along answer - the
  // first hub to fail is not a verdict on the rest.
  const seen = new Map(submitted.successes.map((s) => [s.hub, s.value]));
  let accepted = null;
  for (let i = 0; ; i += 1) {
    const rows = [...seen.values()].filter(Boolean);
    const best = mergeQueueReceipts(rows);
    if (best?.status === 'running' && best.receipt) { accepted = best.receipt; break; }
    if (rows.length && rows.every((r) => r.status === 'failed')) {
      die(`handoff ${handoffId} failed on ${targetName}: ${best?.error ?? 'the target refused it'}`);
    }
    if (i >= 16) break;
    await new Promise((r) => setTimeout(r, 500));
    try {
      const round = await hubBroadcastRpc(net, target, M.DISPATCH_STATUS, { handoffId }, { timeout: 5_000 });
      for (const s of round.successes) seen.set(s.hub, s.value);
    } catch { /* every home quiet this round; the next may answer */ }
  }

  if (accepted) {
    // Linking is bookkeeping, not the handoff itself: a failed link must
    // not turn a running target session into a reported failure.
    if (sourceId) {
      try {
        await brainRpc(net.self, M.SESSION_LINK, {
          id: sourceId,
          child: {
            handoffId,
            machineId: target,
            sessionId: accepted.sessionId,
            title: sessionTitle,
            folder: accepted.folder,
            digest: accepted.digest,
          },
        });
      } catch (err) {
        console.error(`helm: warning: the target session is running but the source could not record the link (${err.message})`);
      }
    }
    console.log(`Task ${handoffId} runs on ${targetName}:`);
    console.log(`  ${shortId(accepted.sessionId)}  ${sessionTitle}  (${profile?.engine ?? profileId} on ${targetName}, ${accepted.folder})`);
    const entries = (accepted.skippedEntries ?? []).slice(0, 10);
    console.log(`  Sent ${accepted.files} code files. Skipped ${accepted.skipped} item${accepted.skipped === 1 ? '' : 's'}${entries.length ? ':' : '.'}`);
    for (const e of entries) console.log(`    - ${e.path} (${e.reason})`);
    const omitted = (accepted.skipped ?? 0) - entries.length;
    if (omitted > 0) console.log(`    - … and ${omitted} more`);
    return;
  }

  console.log(`queued ${handoffId} for ${targetName}; it will start when that machine connects.`);
  console.log(`retry/status: helm dispatch-status ${handoffId}`);
}

async function sendTask() {
  const { parseTaskArgs } = await import('../src/task-cli.js');
  const { options, request } = parseTaskArgs(rest, { machineId });
  const net = requireNetwork();
  const { handoffId } = request;
  console.error(`helm: task ${handoffId}; retry with the same arguments and --handoff-id ${handoffId}`);
  const started = Date.now();
  let result = await brainRpc(net.self, M.TASK_SEND, request, 360_000);
  // A big project copies first, in the background; asking again with the
  // same request follows it until the task is running.
  let shown = '';
  while (result.status === 'copying') {
    const p = result.progress ?? {};
    const line = p.phase === 'copying'
      ? `copying to ${result.targetName}:${p.folder} - ${p.percent ?? 0}% of ${Math.round((p.total ?? 0) / 1e6)} MB${p.rate ? ` (${p.rate})` : ''}`
      : p.phase === 'pausing' ? 'pausing the source task' : `starting the agent on ${result.targetName}`;
    if (!options.json && line !== shown) console.error(`helm: ${line}`);
    shown = line;
    await new Promise((r) => setTimeout(r, 2000));
    result = await brainRpc(net.self, M.TASK_SEND, request, 360_000);
  }
  if (options.json) console.log(JSON.stringify(result));
  if (!result.sent) {
    if (!options.json) for (const warning of result.preflight.warnings) console.error(`  ${warning.path || ''}: ${warning.message}`);
    die('Review skipped files and retry with --allow-skipped.');
  }
  if (!options.json) {
    console.log(`Task ${handoffId} ${result.status} on ${result.targetName}.`);
    if (result.receipt) console.log(`  ${result.receipt.sessionId} · ${result.receipt.folder} · ${result.route}`);
    if (result.preflight) {
      console.log(`  ${result.preflight.files} files · ${(result.preflight.bytes / 1e6).toFixed(2)} MB · request completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      for (const warning of result.preflight.warnings ?? []) console.error(`  ${warning.message}`);
    }
    if (result.warning) console.error(result.warning);
  }
}

async function send() {
  if (rest.includes('--grant')) return legacySend();
  const positional = []; let destination, includeEnv = true, dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--no-env') { includeEnv = false; continue; }
    if (arg === '--include-env') continue;
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--to' || arg === '--target-folder') {
      if (destination !== undefined || !rest[i+1] || rest[i+1].startsWith('--')) die(`${arg} needs a value`);
      destination = rest[++i]; continue;
    }
    if (arg.startsWith('-')) die(`helm send: unknown flag ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 2) die(`helm send: unexpected argument ${JSON.stringify(positional[2])}`);
  if (positional.length < 1) die('usage: helm send <machine> <path> [--to <folder>] [--no-env]');
  const path = resolve(expand(positional[1] ?? process.cwd()));
  if (dryRun) {
    const { scanSend } = await import('../src/send-plan.js');
    const plan = await scanSend(path, { includeEnv });
    console.log(`${plan.files} file${plan.files === 1 ? '' : 's'} · ${plan.bytes} bytes to ${positional[0]}:${destination ?? '~/' + plan.name}`);
    console.log(`${plan.envFiles.length} .env file${plan.envFiles.length === 1 ? '' : 's'} ${includeEnv ? 'included. Use --no-env to leave them here.' : 'excluded'}`);
    for (const item of plan.left) console.log(`  ${item.path}: ${item.why}`);
    return;
  }
  const net = requireNetwork(), targetMachineId = machineId(positional[0]);
  let { job } = await brainRpc(net.self, M.SEND_START, { path, targetMachineId, destination, includeEnv });
  console.log(`Sending ${job.id} to ${job.target.name}. Press Ctrl-C to cancel. Retry with send.retry {jobId}.`);
  let cancelling = false;
  const cancel = () => { cancelling = true; void brainRpc(net.self, M.SEND_CANCEL, { jobId: job.id }).catch(e => console.error(e.message)); };
  process.once('SIGINT', cancel);
  try {
    while (['preparing', 'sending', 'finishing'].includes(job.phase)) {
      const bytes = `${(job.bytes.sent / 1048576).toFixed(2)}/${job.bytes.total === null ? '?' : (job.bytes.total / 1048576).toFixed(2)} MiB`;
      const progress = `${job.phase}: ${bytes}, ${job.files.sent}/${job.files.total ?? '?'} files, ${job.rate === null ? '?' : (job.rate / 1048576).toFixed(2)} MiB/s, ETA ${job.eta === null ? '?' : Math.ceil(job.eta) + 's'}`;
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${progress}`); else console.log(progress);
      await new Promise(r => setTimeout(r, 500));
      ({ job } = await brainRpc(net.self, M.SEND_STATUS, { jobId: job.id }));
    }
    if (process.stdout.isTTY) console.log();
    console.log(`${job.phase}: ${job.target.name}:${job.target.path} (${job.id})`);
    if (job.error) console.error(job.error);
    if (job.phase !== 'done') process.exitCode = cancelling ? 130 : 1;
  } finally { process.removeListener('SIGINT', cancel); }
}

async function legacySend() {
  const {
    createCodeSnapshot, sealCodeSnapshot, signHandoffDigest, verifyHandoffSignature,
  } = await import('../src/code-transfer.js');
  const { decodeTransferGrant, transferGrantDigest, transferRequestDigest } =
    await import('../src/transfers.js');
  const { transferPreflight, preflightLines, readinessLines } =
    await import('../src/transfer-check.js');
  const valueFlags = new Set(['--grant', '--target-folder']);
  const boolFlags = new Set(['--include-env', '--dry-run', '--allow-skipped']);
  const args = [];
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('-')) { args.push(a); continue; }
    if (boolFlags.has(a)) continue;
    if (valueFlags.has(a)) {
      if (seen.has(a)) die(`Use ${a} once.`);
      seen.add(a);
      const v = rest[i + 1];
      if (v === undefined || v === '' || v.startsWith('-')) die(`${a} needs a value`);
      i++;
      continue;
    }
    die(`helm send: unknown flag ${a}`);
  }
  if (args.length > 2) {
    die(`helm send: unexpected argument ${JSON.stringify(args[2])}`);
  }
  const [who, folder] = args;
  const dryRun = rest.includes('--dry-run');
  const includeEnv = rest.includes('--include-env');
  const grantToken = strFlag('grant', '');
  if (!who || (!dryRun && !grantToken)) {
    die('usage: helm send <machine> [folder] --grant <token> [--include-env] [--dry-run] [--allow-skipped]');
  }

  const snapshot = createCodeSnapshot(folder || process.cwd(), { includeEnv });
  const preflight = transferPreflight(snapshot);
  for (const line of preflightLines(preflight)) console.log(line);
  if (dryRun) return;
  if (preflight.requiresAcknowledgement && !rest.includes('--allow-skipped')) {
    die('Some files will stay here. Run again with --allow-skipped to send the other files.'
      + (preflight.warnings.some((w) => w.code === 'env-omitted')
        ? ', or --include-env to carry the .env files' : ''));
  }

  const net = requireNetwork();
  const target = machineId(who);
  const targetName = net.machines[target]?.name ?? who;

  const grant = decodeTransferGrant(grantToken);
  if (grant.targetMachineId !== target) {
    die(`That grant is for a different machine, not ${targetName}.`);
  }
  if (grant.sourceMachineId !== net.self) {
    die('That grant is for a different source machine, not this one.');
  }
  if (grant.expiresAt <= Date.now()) {
    die('This transfer permission expired. Run `helm receive` again on the receiving machine.');
  }
  const signPubkey = net.machines[target]?.codeSignPubkey;
  if (!signPubkey) {
    die(`${targetName} has no saved signing key yet. Refresh the member list and retry.`);
  }
  if (!verifyHandoffSignature(signPubkey, transferGrantDigest(grant), grant.signature)) {
    die(`The grant did not verify against ${targetName}'s saved signing key.`);
  }

  const transferId = randomBytes(12).toString('hex');
  const targetFolder = strFlag('target-folder', '')
    || `~/.helm/transfers/${snapshot.rootName}-${transferId.slice(0, 8)}`;
  const envelope = sealCodeSnapshot(snapshot, grant.transferPubkey, transferId);
  const params = {
    transferId,
    sourceMachineId: net.self,
    targetMachineId: target,
    folder: targetFolder,
    envelope,
    snapshotDigest: snapshot.digest,
    grantSecret: grant.secret,
  };
  params.requestDigest = transferRequestDigest(params);
  params.sourceSignature = signHandoffDigest(params.requestDigest);

  const receipt = await hubRpc(net, target, M.TRANSFER_ACCEPT, params, { timeout: 120_000, direct: true });
  console.log(`sent ${receipt.files} file${receipt.files === 1 ? '' : 's'} ` +
    `(${receipt.bytes} bytes) to ${targetName}:${receipt.folder}` +
    (receipt.skipped ? `; ${receipt.skipped} skipped` : ''));
  if (includeEnv) {
    const secrets = snapshot.files.filter((f) => f.secret).length;
    console.log(`  ${secrets} .env file${secrets === 1 ? '' : 's'} included. Only the receiving user can read them.`);
  }
  if (receipt.repository) {
    console.log(`  origin: ${receipt.repository.remote}`);
    console.log(`  ${receipt.repository.configured
      ? 'origin configured; fetch or pull with the target machine’s GitHub login'
      : receipt.repository.error}`);
  }
  if (receipt?.readiness && Array.isArray(receipt.readiness.checks)) {
    for (const line of readinessLines(receipt.readiness)) console.log(line);
  } else {
    console.log('  Run `helm verify` on the receiving machine. It did not report its setup status.');
  }
}

async function verifyFolder() {
  const separator = rest.indexOf('--');
  const before = separator === -1 ? rest : rest.slice(0, separator);
  const runArgs = separator === -1 ? null : rest.slice(separator + 1);
  const badFlag = before.find((a) => a.startsWith('-'));
  if (badFlag) die(`helm verify: unknown flag ${badFlag}`);
  if (before.length !== 1) {
    die('usage: helm verify <folder> [-- <program> [args...]]');
  }
  const folder = before[0];
  if (runArgs !== null && runArgs.length === 0) {
    die('helm verify: `--` needs a program to run');
  }

  const { inspectTransferReadiness, readHandoffSkipped, readinessLines } =
    await import('../src/transfer-check.js');
  const target = resolve(expand(folder));
  const marker = readHandoffSkipped(target);
  const readiness = await inspectTransferReadiness(target, {
    skippedEntries: marker?.skippedEntries ?? [],
    skipped: marker?.skipped ?? 0,
  });
  for (const line of readinessLines(readiness)) console.log(line);
  if (marker?.malformed) {
    console.log('  Helm did not read the task move file list. Helm cannot show which files it skipped.');
  }
  if (runArgs === null) return;

  const code = await new Promise((settle) => {
    const child = spawn(runArgs[0], runArgs.slice(1), {
      cwd: target, stdio: 'inherit', shell: false,
    });
    child.on('error', () => settle(null));
    child.on('close', (status) => settle(status));
  });
  if (code === 0) {
    console.log('  The requested check passed.');
    if (readiness.status === 'needs-setup') {
      console.log('  Finish setup with the checks above.');
    }
    return;
  }
  console.error(code === null
    ? `helm verify: the check could not be started: ${JSON.stringify(runArgs[0])}`
    : `helm verify: the check exited with status ${code}`);
  exit(code ?? 1);
}

async function receive() {
  const args = rest.filter((a) => !a.startsWith('--'));
  if (!args[0]) die('usage: helm receive <source-machine> [minutes]');
  const net = requireNetwork();
  const sourceMachineId = machineId(args[0]);
  const minutes = Number(args[1]);
  const { grant, expiresAt } = await brainRpc(net.self, M.TRANSFER_RECEIVE, {
    sourceMachineId,
    ttlMs: Number.isFinite(minutes) ? minutes * 60_000 : undefined,
  });
  console.log(`\n  ${grant}\n`);
  console.log(`  Use this permission for one transfer within ${Math.max(1, Math.round((expiresAt - Date.now()) / 60000))} minutes.`);
  console.log(`  on ${args[0]}:  helm send ${net.machines[net.self]?.name ?? net.self} [folder] --grant <token>\n`);
}

/** Where a queued handoff is: still waiting, delivered, running or failed. */
async function dispatchStatus() {
  const id = rest.find((a) => !a.startsWith('--'));
  if (!id || !/^[a-f0-9]{24}$/.test(id)) die('usage: helm dispatch-status <handoff-id>');
  const net = requireNetwork();
  // Each home keeps its own copy of the queue; the furthest-along answer
  // wins, so a hub that only ever queued it cannot hide a finished one.
  const { successes } = await hubBroadcastRpc(net, net.self, M.DISPATCH_STATUS, { handoffId: id });
  const row = mergeQueueReceipts(successes.map((s) => s.value));
  if (!row) die('No Helm home answered.');
  const targetName = net.machines[row.targetMachineId]?.name ?? row.targetMachineId;
  console.log(`handoff ${row.handoffId} for ${targetName}: ${row.status}`);
  if (row.receipt?.sessionId) {
    console.log(`  Chat ${row.receipt.sessionId}${row.receipt.folder ? ` in ${row.receipt.folder}` : ''}`);
  }
  if (row.error) console.log(`  error: ${row.error}`);
}

async function openBrain() {
  const { ENGINES } = await import('../src/engines.js');
  const env = brainHome();
  const net = requireNetwork();
  const name = net.machines[env]?.name ?? env;
  let account = flagOf('account');
  try {
    const { session, created } = await brainRpc(env, M.BRAIN_OPEN, {
      profileId: account, model: flagOf('model'), mode: flagOf('mode'),
    }, 60_000);
    console.log(`${created ? 'started' : 'resumed'} the brain on ${name}: ${shortId(session.id)} (${session.engine}${session.model ? `, ${session.model}` : ''})`);
    console.log('Open "Helm brain" in the app, or send a message here:');
    console.log(`  helm say ${shortId(session.id)} "what is waiting on me?"`);
  } catch (err) {
    if (!/needs a profileId/.test(err.message)) throw err;
    const { profiles } = await brainRpc(env, M.PROFILE_LIST, {});
    const usable = profiles.filter((x) => ENGINES[x.engine]?.driver);
    console.error(`helm: which account should be the brain on ${name}?\n`);
    for (const x of usable) console.error(`  helm brain --account ${x.id}${' '.repeat(Math.max(1, 22 - x.id.length))}${x.engine}`);
    exit(1);
  }
}

// ------------------------------------------------------------ redesignate

const KIND_LIST = MACHINE_KINDS.join(', ');

/**
 * `helm redesignate [machine] <kind>` - what a machine is for, changed.
 *
 * The kind lives on the machine's own roster record, which only the machine
 * may write - so a remote target is asked through its daemon, and even this
 * machine is asked that way first when its daemon is up: the running daemon
 * holds the advertised addresses and the service arguments the change
 * touches. Writing the record here is the fallback for when it is down.
 */
async function redesignate() {
  const args = rest.filter((a) => !a.startsWith('--'));
  const net = requireNetwork();
  if (args.length < 1 || args.length > 2) {
    die(`usage: helm redesignate [machine] <${KIND_LIST}>`);
  }
  const [who, given] = args.length === 2 ? args : [null, args[0]];
  const kind = String(given ?? '').toLowerCase();

  // A controller is not a fourth kind and can never become one - nor can a
  // machine be redesignated into one. It holds a device token, runs no
  // daemon, and has nothing to change. The answer is a refusal rather than
  // an error, because it is a guarantee, not a failure.
  if (CONTROLLER_WORDS.includes(kind)) die(CONTROLLER_REFUSAL);
  if (!machineKind(kind)) {
    // One word that is not a kind reads like a member with the kind
    // forgotten; name the mistake when the word names a member.
    const want = String(given ?? '').toLowerCase();
    if (Object.keys(net.devices ?? {}).some((id) => id.startsWith(want))) die(CONTROLLER_REFUSAL);
    const member = Object.values(net.machines ?? {}).find((m) =>
      m.id.startsWith(want) || m.name.toLowerCase() === want || m.name.toLowerCase().startsWith(want));
    die(member
      ? `"${given}" is a machine - say what it becomes: helm redesignate ${given} <${KIND_LIST}>`
      : `a machine's kind is one of: ${KIND_LIST}`);
  }

  if (who) {
    const want = who.toLowerCase();
    const isDevice = Object.keys(net.devices ?? {}).some((id) => id === who || id.startsWith(want))
      || Object.values(net.devices ?? {}).some((d) => String(d.label).toLowerCase().startsWith(want));
    if (isDevice) die(CONTROLLER_REFUSAL);
  }

  const target = who ? machineId(who) : net.self;
  const remote = target !== net.self;
  const record = net.machines[target];
  const from = (remote ? record?.kind : record?.kind ?? net.role) ?? 'pc';
  if (from === kind && record?.kind === kind) {
    console.log(`\n  ${record?.name ?? target} is already a ${kind}.\n`);
    return;
  }

  // Becoming the vm needs an https address before anything is written, so a
  // failure there leaves the machine exactly what it was. For this machine
  // it is claimed here - sudo can ask for a password, which a remote daemon
  // cannot do - and the ready address is handed over. A remote machine
  // claims its own (its daemon runs the same code); --advertise instead
  // says the https already exists, whichever side it is for.
  let home = cleanEndpoint(strFlag('advertise')) || null;
  if (home) checkHome(home);
  if (kind === 'vm' && !remote && !home) {
    home = record?.endpoints?.find((e) => e.startsWith('https://'))
      ?? await claimFreeHome();
  }
  const params = { kind, ...(home ? { address: home } : {}) };

  if (remote) {
    const r = await askKind(net, target, params).catch((err) => {
      if (/unknown method/.test(err.message)) {
        die(`${record?.name ?? target} runs an older helm that cannot be redesignated - update it first`);
      }
      throw err;
    });
    reportKind(record?.name ?? target, r);
    return;
  }

  const r = await askKind(net, net.self, params).catch((err) => {
    // Unreachable, or a daemon from before kinds existed: either way the
    // file-level path below lands the change, and the running daemon picks
    // it up on its next publish - it re-reads the roster every tick.
    if (/could not reach|timed out|unknown method/.test(err.message)) return null;
    throw err;
  });
  if (r) { reportKind(record?.name ?? net.self, r); return; }
  await redesignateLocally(net, kind, { from, home });
}

/** Ask a machine's daemon to redesignate itself. */
async function askKind(net, target, params) {
  return hubRpc(net, target, M.MACHINE_SET_KIND, params, { timeout: 120_000 });
}

function reportKind(name, r) {
  console.log(r.changed
    ? `\n  ${name} is now a ${r.kind}${r.from && r.from !== r.kind ? ` (was ${r.from})` : ''}.`
    : `\n  ${name} is already a ${r.kind}.`);
  for (const note of r.notes ?? []) console.log(`  ${note}`);
  console.log('');
}

/** Claim this machine's free https address, saying so before sudo asks. */
async function claimFreeHome() {
  const { claimFreeHttps } = await import('../src/caddy.js');
  console.log('\n  Getting a free HTTPS address for this machine...');
  return claimFreeHttps(port(), {
    found: (hostname) => {
      console.log(`  Using free address: https://${hostname}`);
      console.log('  Setting up HTTPS with Caddy. Enter your password if sudo asks.');
    },
  });
}

/**
 * The file-level half of `redesignate`, for when this machine's own daemon
 * cannot be asked: write the record, keep the local note in step, and make
 * the installed service agree so the change survives a reboot. When the
 * daemon is up it does all of this itself - and republishes its live
 * endpoint set - so this only runs when nothing answered.
 */
async function redesignateLocally(net, kind, { from, home }) {
  const me = net.machines[net.self] ?? {};
  const fields = { kind };
  if (kind === 'vm') {
    fields.endpoints = [home, ...(me.endpoints ?? []).filter((e) => e !== home)];
  } else if (from === 'vm') {
    // The advertised https address is what made it a home; anything http is
    // a LAN address that stays true of a pc.
    fields.endpoints = (me.endpoints ?? []).filter((e) => !e.startsWith('https://'));
  }
  net.role = kind;
  describeSelf(net, fields);
  saveNetwork(net);

  const { installService } = await import('../src/service.js');
  if (kind === 'vm') {
    const r = await installService({
      mode: 'serve', args: ['--advertise', home, '--host', '127.0.0.1'],
    });
    console.log(`\n  This machine is now a VM at ${home}.`);
    if (!r.installed) {
      console.log('  Run `helm up --install` to start Helm after this machine restarts.');
    }
  } else {
    if (from === 'vm') {
      await installService({ mode: 'serve', args: ['--host', '0.0.0.0'] });
      console.log('\n  Helm no longer shares the old HTTPS address.');
      console.log('  Remove its Caddy site with:');
      console.log('    sudo rm /etc/caddy/helm.caddy && sudo systemctl reload caddy');
    }
    console.log(`\n  this machine is now a ${kind}.`);
  }
  console.log('  every machine in the network sees the new kind as it syncs.\n');
}

function listMachines() {
  const net = requireNetwork();
  for (const m of Object.values(net.machines)) {
    const self = m.id === net.self ? ' (this machine)' : '';
    const kind = m.kind ?? '?';
    const where = (m.endpoints ?? []).join(' ') || 'no address advertised';
    console.log(`${short(m.id)}  ${m.name.padEnd(16)} ${kind.padEnd(3)}  ${where}${self}`);
  }
}

/**
 * `helm share <port>` - a public https link to something running here, served
 * by the network's public home (helm's own ngrok). `list`, `stop <name>`, and
 * `setup` (once, on the public home: lets Caddy issue the links' certificates).
 */
async function shareCmd() {
  const net = requireNetwork();
  const shareLib = await import('@helm/protocol/share');
  const local = await import('../src/shares.js');
  const { checkSharePort } = await import('../src/loopback.js');
  const args = rest.filter((a, i) => !a.startsWith('--') && !['--name', '--password', '--on', '--for', '--to'].includes(rest[i - 1]));
  const verb = /^\d+$/.test(args[0] ?? '') ? 'add' : (args.shift() ?? 'list');
  const on = strFlag('on');
  const target = on ? machineId(on) : net.self;
  const where = net.machines[target]?.name ?? 'this machine';
  const host = shareLib.publicHosts(net)[0];
  const link = (name) => host ? `https://${name}.${host}` : `(no public address: ${name})`;
  const call = async (method, params) => target === net.self
    ? (method === M.SHARE_LIST ? { shares: local.listShares().map(local.publicShare) }
      : method === M.SHARE_REMOVE ? { removed: local.removeShare(params.name) }
      : { share: local.publicShare(local.addShare(params)) })
    : hubRpc(net, target, method, params, { timeout: 15_000 });

  if (verb === 'setup') {
    const { configureShareHttps } = await import('../src/caddy.js');
    const own = (net.machines[net.self]?.endpoints ?? []).map((u) => { try { return new URL(u); } catch { return null; } })
      .find((u) => u?.protocol === 'https:');
    if (!own) die('Run this on the machine with the public https address (your VM).');
    await configureShareHttps(own.hostname, net.port || 8787);
    console.log(`\n  Spins now use https://<name>.${own.hostname}.\n`);
    return;
  }

  if (verb === 'list' || verb === 'ls') {
    const machines = Object.values(net.machines).filter((m) => !net.revoked?.[m.id]);
    const rows = await Promise.all(machines.map(async (m) => {
      try {
        const { shares } = m.id === net.self ? { shares: local.listShares().map(local.publicShare) }
          : await hubRpc(net, m.id, M.SHARE_LIST, {}, { timeout: 5000, budget: 6000 });
        return shares.map((x) => ({ ...x, machine: m.name }));
      } catch { return []; }
    }));
    const all = rows.flat();
    if (!all.length) { console.log('\n  No Spins are open. Run helm share <port> [--name <name>] [--password <pw>].\n'); return; }
    console.log('');
    for (const x of all) {
      const left = x.expiresAt ? `  ends in ${Math.max(1, Math.round((x.expiresAt - Date.now()) / 60_000))} min` : '  kept';
      console.log(`  ${link(x.name)}  ->  ${x.machine}:${x.port}${x.private ? '  (private)' : x.password ? '  (password)' : ''}${left}`);
    }
    console.log('');
    return;
  }

  if (verb === 'stop' || verb === 'rm' || verb === 'remove') {
    const name = args[0];
    if (!name) die('usage: helm share stop <name> [--on <machine>]');
    const { removed } = await call(M.SHARE_REMOVE, { name });
    console.log(removed ? `\n  Stopped ${link(name)}.\n` : `\n  ${where} is not sharing "${name}"\n`);
    return;
  }

  if (verb === 'add' && flagOf('to') !== undefined) return forwardTo();
  if (verb !== 'add') die('usage: helm share <port> [--name <name>] [--password [pw]] [--private] [--for <hours>] [--keep] [--on <machine>] | list | stop <name> | setup');
  const port = Number(args[0]);
  if (target === net.self) await checkSharePort(port);
  const members = !!flagOf('private');
  if (members && flagOf('password') !== undefined) die('Open private links from devices signed in to your Helm. Private links do not use passwords.');
  // An older machine would read "private" as nothing and make the link
  // public, so ask first whether it knows the word. This machine too: the
  // list is written here, but it is the running daemon (maybe older than
  // this command) that hands it to hubs, and an older one hands private
  // links to every hub.
  if (members) {
    const known = await hubRpc(net, target, M.SHARE_LIST, {}, { timeout: 15_000 }).catch(() => null);
    if (!known) die(`could not reach ${where}'s Helm through a hub to check that it can make private links; is it running?`);
    if (!known.features?.includes('private')) die(`${where} runs an older Helm that cannot make private links; update it first`);
  }
  let password = flagOf('password');
  // `--password` with nothing after it: make one up and say what it is.
  if (password === true) password = shareLib.randomShareName() + shareLib.randomShareName();
  const name = strFlag('name');
  if (name && !shareLib.shareName(name)) die(`Use ${shareLib.NAME_RULE} for the link name.`);
  // New remote daemons check names themselves. Local writes and older
  // daemons still need this check; do not repeat a slow network lookup.
  const remoteNameCheck = name && target !== net.self
    && (await hubRpc(net, target, M.SHARE_LIST, {}, { timeout: 4000, budget: 5000 })).features?.includes('name-check');
  if (name && !remoteNameCheck) {
    const others = Object.values(net.machines).filter((m) => m.id !== target && !net.revoked?.[m.id]);
    const clash = (await Promise.all(others.map((m) => hubRpc(net, m.id, M.SHARE_LIST, {}, { timeout: 4000, budget: 5000 })
      .then(({ shares }) => shares.some((x) => x.name === name.toLowerCase()) ? m.name : null).catch(() => null)))).find(Boolean);
    if (clash) die(`"${name}" is already shared from ${clash}. Pick another name.`);
  }
  // Links end after 3 hours unless --keep says otherwise; --for <hours> picks another length.
  const keep = !!flagOf('keep');
  const hours = Number(strFlag('for'));
  if (strFlag('for') !== undefined && !(hours > 0)) die('--for takes a number of hours, e.g. --for 8.');
  const ttlMs = hours > 0 ? hours * 3_600_000 : undefined;
  // A link an agent makes for its own chat stops when that chat is deleted.
  const chat = target === net.self && !keep ? process.env.HELM_SESSION_ID : undefined;
  const { share } = await call(M.SHARE_ADD, { name, port, password: typeof password === 'string' ? password : undefined, keep, ttlMs, replace: true, ...(chat ? { chat } : {}), ...(members ? { private: true } : {}), ...(flagOf('preserve-host') ? { preserveHost: true } : {}) });
  const url = link(share.name);
  const ends = share.expiresAt ? `ends ${new Date(share.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (add --keep to keep it)` : 'kept until you stop it';
  console.log(`\n  ${url}\n  -> ${where}, port ${share.port}, ${ends}${share.password ? `\n  password: ${password}` : ''}`);
  if (share.private) {
    const machine = net.machines[target]?.name ?? 'this-machine';
    console.log(`  private: only devices signed in to your Helm can open it\n  from another of your machines: helm forward ${machine} ${share.port}`);
  }
  if (!host) { console.log('\n  Add a public HTTPS address to a machine in this network before opening this link.\n'); return; }
  // The first visit is when the certificate is made; do it now, so the
  // person you send it to does not wait - and so a problem shows up here.
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    console.log(r.status === 502 ? `\n  The link works. Nothing answered on port ${share.port} here.\n`
      : `\n  Live. Stop it with: helm share stop ${share.name}${on ? ` --on ${on}` : ''}\n`);
  } catch (err) {
    console.log(`\n  Helm saved the link. It did not answer: ${err.cause?.code || err.message}.\n  Run \`helm share setup\` once on your VM for a new link.\n`);
  }
}

/**
 * `helm forward`: a port on one machine, on another machine's localhost.
 *
 *   helm forward <port> [--to <machine>]   this machine's port, on <machine>
 *                                          (no --to: where the owner works)
 *   helm forward <machine> <port>          <machine>'s port, here
 *   helm forward list | stop <id|port|all>
 *
 * The Helm service on each side keeps it (src/forwards.js): it outlives
 * this command, comes back after restarts and needs no public link.
 */
async function forwardCmd() {
  const net = requireNetwork();
  const valued = ['--local', '--to', '--for', '--on'];
  const args = rest.filter((a, i) => !a.startsWith('--') && !valued.includes(rest[i - 1]));
  const usage = 'usage: helm forward <port> [--to <machine>] [--local <port>] [--for <hours>] [--keep]\n'
    + '       helm forward <machine> <port> [--local <port>] | list | stop <id|port|all>';
  const verb = args[0];
  if (verb === 'list' || verb === 'ls') return forwardList(net);
  if (verb === 'stop' || verb === 'rm' || verb === 'remove') return forwardStop(net, args[1]);
  if (!args.length) die(usage);
  // `helm forward 5173 [--to why]`: from here. `helm forward Laptop 5173`: to here.
  const pushing = /^\d+$/.test(args[0]);
  if (!pushing && args.length < 2) die(usage);
  const port = Number(pushing ? args[0] : args[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) die(usage);
  const source = pushing ? net.self : machineId(args[0]);
  const target = pushing ? (strFlag('to') ? machineId(strFlag('to')) : await ownerMachine(net)) : net.self;
  await forwardOpen(net, { source, target, port });
}

/** `helm share <port> --to <machine>` is a forward. */
async function forwardTo() {
  const net = requireNetwork();
  const port = Number(rest.find((a, i) => /^\d+$/.test(a) && rest[i - 1] !== '--to' && rest[i - 1] !== '--for'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) die('usage: helm share <port> --to <machine>');
  const to = flagOf('to');
  const target = typeof to === 'string' ? machineId(to) : await ownerMachine(net);
  await forwardOpen(net, { source: net.self, target, port });
}

const machineName = (net, id) => net.machines[id]?.name ?? id;

/**
 * The machine where the owner used the Helm app last (each hub notes it,
 * see protocol/owner-seen.js). Says which one it picked.
 */
async function ownerMachine(net) {
  const machines = Object.values(net.machines).filter((m) => !net.revoked?.[m.id]);
  const seen = await Promise.all(machines.map(async (m) => {
    try {
      const r = await hubRpc(net, m.id, M.FORWARD_LIST, {}, { timeout: 5000, budget: 6000 });
      return { id: m.id, at: Number(r?.ownerSeenAt) || 0 };
    } catch { return { id: m.id, at: 0 }; }
  }));
  const best = seen.sort((a, b) => b.at - a.at)[0];
  if (!best?.at) {
    die(`Helm does not know which machine the owner uses. Add --to <machine>: ${machines.map((m) => m.name).join(', ')}.`);
  }
  console.log(`\n  The owner used Helm on ${machineName(net, best.id)} last (${ago(best.at)}). Add --to <machine> to pick another.`);
  return best.id;
}

async function forwardOpen(net, { source, target, port }) {
  const from = machineName(net, source);
  const to = machineName(net, target);
  if (source === target) {
    console.log(`\n  That is the same machine. Open http://localhost:${port} on ${to}.\n`);
    return;
  }
  const keep = !!flagOf('keep');
  const hours = Number(strFlag('for'));
  if (strFlag('for') !== undefined && !(hours > 0)) die('--for takes a number of hours, e.g. --for 8.');
  const { FORWARD_TTL_MS, newForwardId } = await import('../src/forwards.js');
  const expiresAt = keep ? undefined : Date.now() + (hours > 0 ? hours * 3_600_000 : FORWARD_TTL_MS);
  const wanted = strFlag('local');
  const localPort = wanted === undefined ? undefined : Number(wanted);
  if (wanted !== undefined && !(Number.isInteger(localPort) && localPort > 0 && localPort < 65536)) die('--local takes a port, e.g. --local 3001.');
  if (source === net.self) {
    const { checkSharePort } = await import('../src/loopback.js');
    await checkSharePort(port).catch(() => console.log(`\n  Nothing runs on port ${port} here yet. The link shows a "not reachable" page until it does.`));
  }
  const id = newForwardId();
  const call = (machine, method, params) => hubRpc(net, machine, method, params, { timeout: 15_000 });
  const older = (err, who) => /unknown method/.test(err?.message || '') ? `${who} runs an older Helm without forwards. Update it first.` : null;
  try { await call(source, M.FORWARD_ADD, { id, side: 'out', peer: target, port, expiresAt }); }
  catch (err) { die(older(err, from) ?? `${from} did not open port ${port}: ${err.message}`); }
  let forward;
  try { ({ forward } = await call(target, M.FORWARD_ADD, { id, side: 'in', peer: source, port, localPort, expiresAt })); }
  catch (err) {
    await call(source, M.FORWARD_REMOVE, { id }).catch(() => {});
    die(older(err, to) ?? `${to} did not start the forward: ${err.message}`);
  }
  const url = `http://localhost:${forward.localPort}`;
  // In hours too: the time of day is this machine's clock, maybe not the owner's.
  const left = expiresAt && Math.round((expiresAt - Date.now()) / 60_000);
  const ends = expiresAt ? `It ends in ${left >= 120 ? `${Math.round(left / 60)} hours` : `${left} min`}, at ${new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} here (add --keep to keep it)` : 'It stays until you stop it';
  console.log(`\n  ${url}  on ${to}  ->  ${from}, port ${port}`);
  console.log(`  ${ends}. Stop it: helm forward stop ${id}`);
  console.log(`  Give the owner only this link: ${url}\n`);
}

/** Both halves of every forward in the network, one line per forward. */
async function forwardRows(net) {
  const machines = Object.values(net.machines).filter((m) => !net.revoked?.[m.id]);
  const answers = await Promise.all(machines.map(async (m) => {
    try {
      const { forwards } = await hubRpc(net, m.id, M.FORWARD_LIST, {}, { timeout: 5000, budget: 6000 });
      return (forwards ?? []).map((f) => ({ ...f, holder: m.id }));
    } catch { return []; }
  }));
  const byId = new Map();
  for (const f of answers.flat()) {
    const row = byId.get(f.id) ?? { id: f.id, holders: [] };
    row.holders.push(f.holder);
    if (f.side === 'in') Object.assign(row, { target: f.holder, source: f.peer, port: f.port, localPort: f.localPort, listening: f.listening, error: f.error, expiresAt: f.expiresAt });
    else Object.assign(row, { source: f.holder, target: row.target ?? f.peer, port: row.port ?? f.port, expiresAt: row.expiresAt ?? f.expiresAt, out: true });
    byId.set(f.id, row);
  }
  return [...byId.values()];
}

async function forwardList(net) {
  const rows = await forwardRows(net);
  if (!rows.length) { console.log('\n  No forwards are open. Run helm forward <port> [--to <machine>].\n'); return; }
  console.log('');
  for (const r of rows) {
    const where = r.localPort ? `http://localhost:${r.localPort} on ${machineName(net, r.target)}` : `${machineName(net, r.target)} (did not answer)`;
    const left = r.expiresAt ? `ends in ${Math.max(1, Math.round((r.expiresAt - Date.now()) / 60_000))} min` : 'kept';
    const state = r.error ? `  not open: ${r.error}` : r.localPort && !r.out ? `  ${machineName(net, r.source)} did not answer` : '';
    console.log(`  ${r.id}  ${where}  ->  ${machineName(net, r.source)}, port ${r.port}  ${left}${state}`);
  }
  console.log('');
}

async function forwardStop(net, which) {
  if (!which) die('usage: helm forward stop <id|port|all>');
  const rows = await forwardRows(net);
  const hits = which === 'all' ? rows : rows.filter((r) => r.id.startsWith(which) || String(r.port) === which || String(r.localPort) === which);
  if (!hits.length) die(`No forward matches "${which}". Run helm forward list.`);
  for (const r of hits) {
    // Either half can stop it: that machine tells the other one.
    let done = false;
    for (const holder of r.holders) {
      try { await hubRpc(net, holder, M.FORWARD_REMOVE, { id: r.id, notify: true }, { timeout: 15_000 }); done = true; break; }
      catch { /* try the other half */ }
    }
    const what = `${r.localPort ? `http://localhost:${r.localPort} on ` : ''}${machineName(net, r.target)} -> ${machineName(net, r.source)}, port ${r.port}`;
    console.log(done ? `\n  Stopped ${what}.` : `\n  Could not stop ${what}: no machine answered.`);
  }
  console.log('');
}

/**
 * Remove a member. This is the only way something leaves a network - which is
 * the point: nothing else, including restarts, reinstalls or an expired
 * password, should ever cost you a device you added.
 */
function remove() {
  const net = requireNetwork();
  const prefix = rest.find((a) => !a.startsWith('--'));
  if (!prefix) die('Pick an ID from `helm devices` or `helm machines`.');

  const all = { ...net.devices, ...net.machines };
  const hits = Object.keys(all).filter((id) => id.startsWith(prefix));
  if (!hits.length) die(`No device or machine starts with "${prefix}".`);
  if (hits.length > 1) die(`"${prefix}" matches ${hits.length} members - be more specific.`);

  const [id] = hits;
  if (id === net.self) {
    die('Run `helm leave` to remove this machine from the network.');
  }
  const label = net.devices[id]?.label ?? net.machines[id]?.name ?? id;
  revoke(net, id);
  console.log(`removed ${label} (${short(id)}).`);
  console.log('Each machine blocks it when it gets the updated member list.');
}

async function leave() {
  const net = loadNetwork();
  if (!net) { console.log('This machine has not joined a network.'); return; }
  if (!rest.includes('--yes')) {
    console.log(`This removes "${net.machines[net.self]?.name}" from its network.`);
    console.log('This deletes the network member list and key from this machine.');
    console.log('This stops the Helm background service if installed.');
    console.log('\nRun again with --yes to confirm.');
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
  console.log('This machine left the network. Run `helm up` to start a new network.');
  console.log('Other machines remove this one when they get the updated member list.');
}

// ---------------------------------------------------------------- dispatch

// `helm help <command>` and `helm <command> --help` print that command's
// usage and details. run and chat pass their arguments on to another program.
const helpFor = cmd === 'help' || cmd === '--help' || cmd === '-h' ? rest[0]
  : cmd && !['run', 'chat'].includes(cmd) && wantsHelp(rest) ? cmd : null;

try {
  if (helpFor === '--all') {
    console.log(USAGE);
    exit(0);
  }
  if (helpFor) {
    const text = commandHelp(helpFor, USAGE);
    if (!text) die(`No command "${helpFor}" - helm help lists them all.`);
    console.log(text);
    exit(0);
  }
  switch (cmd) {
    case 'run':
      if (!rest.includes('--') && rest.some(arg => ['--help', '-h'].includes(arg))) {
        console.log(commandHelp('run', USAGE));
        break;
      }
      if (rest.includes('--') || rest.some(arg => ['--heavy', '--cwd', '--timeout', '--env'].includes(arg))) {
        const { runLocalWork } = await import('../src/execution-cli.js');
        process.exitCode = await runLocalWork(rest);
        break;
      }
      // Keep the original no-command alias for installations using helm run.
    case undefined:
    case 'up':
    case 'serve':
      // A daemon started from inside an agent's shell (a self-update, a
      // sandbox) inherits that agent's identity. Left in place, every
      // terminal and app-server it spawns would claim to be that session.
      for (const k of ['HELM_SESSION_ID', 'HELM_PROFILE_ID', 'HELM_ENGINE', 'HELM_CWD']) delete process.env[k];
      await up();
      break;

    case 'setup':
      await setup();
      break;

    case 'start':
      await startInstalled();
      break;

    case 'add':
    case 'invite':
      await add();
      break;

    case 'open':
      await openApp();
      break;

    case 'app': {
      const { installApp, installWebApp, removeApp } = await import('../src/desktop.js');
      if (rest.includes('--remove') || rest.includes('remove')) {
        const { removed, icons } = removeApp();
        console.log(removed
          ? `\n  Helm removed the app shortcut and ${icons} icon${icons === 1 ? '' : 's'}.\n`
          : '\n  This machine had no Helm app shortcut.\n');
        break;
      }
      const net = requireNetwork();
      const at = `http://127.0.0.1:${net.port ?? 8787}/`;
      const pick = rest[rest.indexOf('--browser') + 1];
      const browser = rest.includes('--browser') ? pick : undefined;
      const r = installApp({ url: at, browser, appId: await installWebApp({ url: at, browser }) });
      console.log(`\n  Helm is in your applications. Opening ${r.url}.`);
      console.log(r.windowed
        ? `  Helm opens in a separate ${r.browser} window and signs in automatically.`
        : '  Helm opens in your default browser because this machine has no Chromium browser.');
      console.log('  Remove it with: helm app --remove\n');
      break;
    }

    case 'join':
      await joinCmd();
      break;

    case 'devices':
      listDevices();
      break;

    case 'machines':
      listMachines();
      break;

    case 'redesignate':
      await redesignate();
      break;

    case 'spin':
    case 'share':
      await shareCmd();
      break;

    case 'forward':
      await forwardCmd();
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
      console.log(`  This password expires in ${Math.round((expiresAt - Date.now()) / 60000)} minutes.`);
      console.log('  Signed-in devices stay signed in.\n');
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
      // ssh hands the port it wants as %p; without it a non-default port was dropped.
      await (await import('../src/proxy.js')).proxy(rest[0], Number(rest[1]) || undefined);
      break;

    case 'self-update':
    case 'update': {
      const { selfUpdate } = await import('../src/update.js');
      // GitHub's version, only when asked. --replace overrides this machine's
      // own changes and keeps them on a backup branch.
      const r = await selfUpdate(undefined, { replace: rest.includes('--replace') });
      if (!r.updated) { console.log(`  not updated - ${r.reason}`); break; }
      if (r.backup) console.log(`  your changes are kept on branch ${r.backup}`);
      console.log(r.restarting?.length
        ? `  Helm updated. ${r.restarting.join(', ')} restart now and keep active chats.`
        : '  Helm updated. Restart Helm to use the update.');
      break;
    }

    case 'ship': {
      const { ship, ShipError } = await import('../src/ship.js');
      const minutes = Number(strFlag('wait', '10'));
      if (!(minutes > 0)) die('--wait takes a number of minutes');
      try {
        const r = await ship({ net: requireNetwork(), rpc: hubRpc, check: !rest.includes('--no-check'), waitMs: minutes * 60_000 });
        if (!r.ok) exit(1);
      } catch (err) {
        if (!(err instanceof ShipError)) throw err;
        die(err.message);
      }
      break;
    }

    case 'restart-services': {
      const { restartServices } = await import('../src/update.js');
      await restartServices(rest);
      break;
    }

    case 'antigravity': {
      const ag = await import('../src/antigravity.js');
      const sub = rest[0] ?? 'status';
      if (sub === 'install') {
        let reported = -1;
        const r = await ag.installAntigravity({
          onProgress: (phase, done, total) => {
            if (phase === 'extract') { process.stdout.write('\n  Checking and unpacking files…'); return; }
            if (phase !== 'download') return;
            const pct = Math.floor((done / total) * 100);
            if (pct !== reported && pct % 5 === 0) {
              reported = pct;
              process.stdout.write(`\r  Downloading Antigravity… ${pct}%`);
            }
          },
        });
        console.log(`\n\n  Antigravity ${r.version ?? ''} is installed.`);
        console.log('  Run helm antigravity login, or start a chat to sign in.\n');
        // The profile cache predates the install; discovery adds the engine now.
        try { await (await import('../src/profiles.js')).refreshProfiles(); } catch { /* the next discovery pass gets it */ }
      } else if (sub === 'login') {
        const at = rest.indexOf('--home');
        const home = (at >= 0 && rest[at + 1]) || '~/.helm/antigravity';
        const env = { GEMINI_HOME: home };
        if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        const r = await ag.antigravityLogin({
          env,
          onUrl: (u) => console.log(`\n  Open this link to sign in to Antigravity:\n\n  ${u}\n\n  Waiting for Google to finish…`),
        });
        console.log(r.alreadySignedIn
          ? '\n  Antigravity is already signed in. Start a chat.\n'
          : '\n  Antigravity is signed in. Start a chat.\n');
      } else if (sub === 'remove' || sub === 'uninstall') {
        await ag.uninstallAntigravity();
        console.log('\n  Helm removed Antigravity. Google sign-ins stay in each account folder.\n');
      } else {
        const s = ag.antigravityStatus();
        console.log(s.installed
          ? `\n  antigravity ${s.version ?? ''} installed\n  ${s.exe}\n`
          : '\n  Antigravity is not installed.\n  Run helm antigravity install.\n');
      }
      break;
    }

    case 'profiles': {
      const { refreshProfiles, getProfiles } = await import('../src/profiles.js');
      const { authStatuses } = await import('../src/auth.js');
      const profiles = rest.includes('--refresh')
        ? (await refreshProfiles()).profiles
        : await getProfiles();
      // The app hides signed-out accounts; list them here, marked, so it's clear why.
      const auth = await authStatuses(profiles, { refresh: rest.includes('--refresh'), waitMs: 30_000 });
      for (const p of profiles) {
        const env = Object.entries(p.env || {}).map(([k, v]) => `${k}=${v}`).join(' ');
        const status = auth.get(p.id) === 'unauthenticated' ? '  (signed out - hidden in the app)' : '';
        console.log(
          `${p.id.padEnd(16)} ${p.engine.padEnd(9)} ${env} ${p.cmd} ${(p.args || []).join(' ')}${status}`
        );
      }
      break;
    }

    case 'doctor': {
      const { diagnose, formatDiagnosis } = await import('../src/doctor.js');
      const report = await diagnose();
      console.log(flagOf('json') ? JSON.stringify(report, null, 2) : formatDiagnosis(report));
      if (!report.ok) process.exitCode = 1;
      break;
    }

    case 'network-repair': {
      const { ensureTcpRecovery } = await import('../src/network-recovery.js');
      const recovery = await ensureTcpRecovery({ interactive: true });
      if (!recovery.supported) console.log('TCP packet-size recovery is not available on this system.');
      else if (recovery.repair) die(`Could not enable packet-size recovery: ${recovery.reason}`);
      else console.log('TCP packet-size recovery is enabled and saved for reboot.');
      break;
    }

    case 'status': {
      const net = loadNetwork();
      if (!net) { console.log('This machine has not joined a network. Run `helm up`.'); break; }
      const me = net.machines[net.self];
      // What this machine is for: the roster record's word for it, falling
      // back to the local note a join left behind before records had one.
      const kind = me?.kind ?? net.role;
      console.log(`network:  ${net.id}`);
      console.log(`machine:  ${me?.name} (${short(net.self)}${kind ? `, ${kind}` : ''})`);
      console.log(`members:  ${Object.keys(net.machines).length} machines, ` +
                  `${Object.keys(net.devices).length} controllers`);
      console.log(`reachable at: ${(me?.endpoints ?? []).join(' ') || '(no address shared yet)'}`);

      // A full-tunnel VPN leaves the LAN address on the interface but routes
      // the subnet into the tunnel, so the address helm advertises is one it
      // cannot answer on. Nothing else reports this, and the symptom - a
      // phone on the same wifi quietly relaying through the hub instead of
      // connecting directly - looks like helm being slow.
      const { lanIsRoutable } = await import('../src/net-addr.js');
      const lan = await lanIsRoutable();
      if (lan && !lan.ok) {
        console.log(`
  ! Helm shares ${lan.address} for this network.
    Traffic uses ${lan.via} instead of ${lan.expected}.
    Devices on the same Wi-Fi cannot connect directly.
    Chats use your Helm home, which slows them.

    Check your VPN settings.
    For Tailscale, run:
      tailscale set --exit-node-allow-lan-access=true`);
      }
      const peers = allEndpoints(net).filter((e) => !(me?.endpoints ?? []).includes(e));
      if (peers.length) console.log(`Other Helm homes:   ${peers.join(' ')}`);

      // Which way each machine is reached from here, and how long a round
      // trip takes - asked of this machine's running daemon, which is the
      // one choosing.
      try {
        const report = await hubRpc(net, net.self, M.NET_ROUTES, {}, { timeout: 5000, budget: 8000 });
        if (report.recovery?.supported) {
          console.log(report.recovery.repair
            ? `Fix large network packet failures with: ${report.recovery.repair}`
            : 'Large network packet recovery stays on after restarts.');
        }
        const { routeLines } = await import('../src/hub-mesh.js');
        console.log('routes:');
        for (const line of routeLines(report)) console.log(line);
      } catch (err) {
        console.log(err.code === 'unknown_method' || /unknown method/.test(err.message)
          ? 'routes:   the Helm running here is too old to say - update it'
          : 'routes:   Helm is not running here, so nothing is being routed');
      }
      try {
        const { createRuntime } = await import('../src/runtime/index.js');
        const rt = await createRuntime();
        const info = await rt.ensureReady();
        rt.stop();
        console.log(`runtime:  herdr ${info.version} (protocol ${info.protocol})`);
      } catch (err) {
        console.log(`runtime:  unavailable - ${err.message}`);
      }

      // Which terminal you actually get. The fallback works but is slow
      // enough to notice, and it used to be invisible until you used it.
      const { loadPty, ptyUnavailable } = await import('../src/pty.js');
      if (await loadPty()) {
        const { TerminalHost } = await import('../src/terminals.js');
        const host = new TerminalHost();
        // `spawn: false`: asking a machine how it is should not change it.
        // Reporting used to start a terminal host as a side effect, so the
        // answer was true partly because the question had been asked.
        const up = await host.ensure({ spawn: false }).catch(() => false);
        const open = up ? host.list().length : 0;
        host.detach();
        console.log(`terminals: own pty${up ? `, host running (${open} open)` : ', host idle'}`);
      } else {
        console.log(`terminals: herdr panes (slow) - no pty: ${ptyUnavailable()}`);
        console.log('           Install a compiler, then run install.sh again to add fast terminal support.');
      }
      break;
    }

    // ------------------------------------------------------------- brain
    //
    // These five are what the brain has instead of an integration. It runs
    // them through its own shell, which is why the same thing works on
    // Claude Code, Codex, opencode and Devin without a line of driver code -
    // and why the permission card the owner already answers on their phone
    // is the brain's guardrail too.
    case 'exec': {
      const { runRemoteWork } = await import('../src/execution-cli.js');
      process.exitCode = await runRemoteWork(rest, { net: requireNetwork(), machineId });
      break;
    }
    // exec-result is the older name, kept for scripts that use it.
    case 'exec-status':
    case 'exec-result': {
      const { parseCommandRef, readRemoteWork } = await import('../src/execution-cli.js');
      const ref = parseCommandRef(rest, cmd, ['--wait', '--json']);
      process.exitCode = await readRemoteWork(ref.machine, ref.id, { ...ref, net: requireNetwork(), machineId });
      break;
    }
    case 'exec-cancel': {
      const { parseCommandRef, cancelRemoteWork } = await import('../src/execution-cli.js');
      const ref = parseCommandRef(rest, cmd, ['--json']);
      process.exitCode = await cancelRemoteWork(ref.machine, ref.id, { ...ref, net: requireNetwork(), machineId });
      break;
    }
    case 'agents':
    case 'delegate':
    case 'delegate-result': {
      const { runAgentCommand } = await import('../src/agent-cli.js');
      // Catalogs and JSON replies can exceed a pipe's buffer. Let stdout
      // drain naturally instead of truncating them with process.exit().
      process.exitCode = await runAgentCommand(cmd, rest, { rpc: brainRpc, self: requireNetwork().self });
      break;
    }
    case 'brain':
      await openBrain();
      break;

    case 'digest':
      await printDigest();
      break;

    case 'search':
      await printSearch();
      break;

    case 'thread':
      await printThread();
      break;

    case 'pickup': {
      const { pickup } = await import('../src/pickup.js');
      const n = rest.findIndex((x) => x === '-n' || x === '--limit');
      const id = rest.find((x, i) => !x.startsWith('-') && (n < 0 || i !== n + 1));
      const net = requireNetwork();
      // Another machine gets 2.5 s in all: an asleep one is read from the
      // saved snapshots instead (this machine's, and the brain's which it
      // keeps fresh), so the page still comes back in a few seconds. Not
      // hubRpc's own budget: it splits the time over every address a machine
      // has, and a busy relay then misses an online VM. Tries still going on
      // dead addresses are left behind; the command exits once it printed.
      const peerRpc = (env, method, params) => Promise.race([
        hubRpc(net, env, method, params, { timeout: 2500 }),
        new Promise((_, fail) => setTimeout(() => fail(Object.assign(new Error('no answer in time'), { code: 'unreachable' })), 2500)),
      ]);
      const brain = brainHost(net.machines);
      const snapshots = [readSnapshot()];
      if (brain && brain.id !== net.self) {
        snapshots.push(peerRpc(brain.id, M.BRAIN_SNAPSHOT, { cached: true }).then((r) => r.snapshot, () => null));
      }
      console.log(await pickup({
        id, self: net.self, selfName: net.machines?.[net.self]?.name, machines: net.machines,
        sessionId: process.env.HELM_SESSION_ID ?? null,
        limit: n < 0 ? 3 : Math.max(1, Number(rest[n + 1]) || 3),
        rpc: brainRpc, peerRpc, find: findSession, snapshots,
      }));
      process.stdout.write('', () => exit(0));
      break;
    }

    case 'messages':
    case 'reply': {
      const { runMessageCommand } = await import('../src/agent-message-cli.js');
      await runMessageCommand(cmd, rest, { rpc: brainRpc, self: requireNetwork().self, findSession });
      break;
    }
    case 'say':
      await say();
      break;

    case 'delete':
      await deleteChat();
      break;

    case 'browser': {
      const { runBrowserCommand } = await import('../src/browser-cli.js');
      await runBrowserCommand(rest, { rpc: brainRpc, self: () => requireNetwork().self, findSession });
      break;
    }
    case 'canvas':
    case 'render':
    case 'preview': {
      const { runVisualCommand } = await import('../src/visual-cli.js');
      await runVisualCommand(cmd, rest, { rpc: brainRpc, self: () => requireNetwork().self, findSession });
      break;
    }

    case 'integrate': {
      const { integrateNativeCommands, removeNativeLaunchers } = await import('../src/native-cli.js');
      const off = rest.includes('--remove');
      const commands = off ? removeNativeLaunchers() : integrateNativeCommands({ enable: true });
      if (off) console.log(commands.length ? `Turned off for: ${commands.join(', ')}. Open a new terminal.` : 'Already off.');
      else console.log(commands.length ? `On for: ${commands.join(', ')}. Open a new terminal, then use them as normal.` : 'Helm found no supported command line app on PATH.');
      break;
    }
    case 'chat': {
      const { connectHub } = await import('../src/hub-client.js');
      const { runChat } = await import('../src/chat-cli.js');
      const net = requireNetwork();
      const connection = await connectHub(net, net.self);
      await runChat(rest, { connection });
      break;
    }

    case 'spawn':
      await spawn_();
      break;

    case 'handoff':
    case 'transfer':
    case 'dispatch':
      await handoff();
      break;

    case 'copy':
      await (await import('../src/copy.js')).copyFolder(rest);
      break;

    case 'copy-proxy':
      process.exitCode = await (await import('../src/copy-proxy.js')).copyProxy(rest);
      break;

    case 'send':
      await send();
      break;

    case 'send-task':
      await sendTask();
      break;

    case 'receive':
      await receive();
      break;

    case 'verify':
      await verifyFolder();
      break;

    case 'dispatch-status':
      await dispatchStatus();
      break;

    case 'dictate':
      await dictate();
      break;

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
