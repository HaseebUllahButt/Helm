#!/usr/bin/env node
import { hostname, platform } from 'node:os';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { argv, exit } from 'node:process';
import {
  loadNetwork, requireNetwork, forgetNetwork, revoke, allEndpoints, machineToken,
  localKey,
} from '@helm/protocol/network';
import { refreshProfiles, getProfiles } from '../src/profiles.js';
import { proxy } from '../src/proxy.js';
import { createRuntime } from '../src/runtime/index.js';
import { HELM_DIR } from '../src/paths.js';
import { M } from '@helm/protocol';
import { hubRpc } from '../src/hub-client.js';
import { levelOfWav, SILENCE_RMS } from '../src/voice.js';
import {
  render, shortId, readThread, readSnapshot, writeSnapshot, mergeSnapshot,
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

const usage = () => {
  console.log(`helm - control your coding agents from anywhere

  helm setup [https-url]             make this always-on VM your Helm home
  helm open                          open the app here, signed in (no link needed)
  helm app [--remove]                put helm in this desktop's applications

  helm add controller                a phone or browser: controls, runs nothing
  helm add pc                        a laptop or desktop: runs agents, controls others
  helm add vm                        another always-on machine, dialled by the rest
  helm join <CODE> <home-url>        run on the machine being added, whichever kind

  helm join <CODE> <home-url> --foreground   ...run in this terminal instead
  helm status                        show the network and runtime

  helm up [--port N] [--tunnel]      run in the foreground
  helm up --tunnel --domain <d>     permanent public link (needs a free ngrok account)
  helm up --tunnel --temporary      public link right now, no account (link changes)
  helm up --advertise <url>         public address others should reach me at
  helm up --host <address>          local listen address (default 0.0.0.0)
  helm up --install                 keep it running across reboots

  helm link [minutes]               same as 'helm add controller'
  helm join <CODE> --at <url>       long form of 'helm join CODE url'

  helm devices                      controllers that can drive this network
  helm machines                     machines in this network
  helm remove <id>                  remove a controller or machine, permanently
  helm leave                        remove this machine from its network

  helm login [minutes]              new short-lived password for signing in a device
  helm status                       membership, links and runtime
  helm profiles [--refresh]         the agent profiles found here

  helm brain [--on <machine>]       open a machine's own agent (prints how to reach it)
  helm digest [--json]              every machine, folder and running session
  helm thread <id> [-n 40]          the recent conversation of one session
  helm say <id> <text...>           send a prompt into an existing session
  helm spawn <machine> <folder> <account> <text...>   start a session and prompt it

  helm dictate [--to <id>]          speak: once to start, again to stop and transcribe
  helm proxy <host>                 ssh ProxyCommand (used by ~/.ssh/config)
  helm service install|uninstall    background service

Only 'helm add controller' prints a link to open; the others print a code to
type on the machine you are adding. A controller you sign in stays signed in
until you remove it - passwords are only for adding one, and expire in minutes.
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
  console.log(`\n  Open this private link on the phone or browser you are adding:\n`);
  console.log(`    ${pairUrl}\n`);
  console.log(`  It expires in ${valid} minute${valid === 1 ? '' : 's'}.`);
  console.log('  Once paired, that device stays signed in until you remove it.\n');
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

/**
 * `helm add <what>`.
 *
 * Three things can join, and they are different enough that naming them is
 * the whole point: a controller is a screen with no agents on it, a pc runs
 * agents and drives others, a vm runs agents and is somewhere to dial. Only a
 * controller gets a link to open; the machines get a code to type.
 */
const CONTROLLER_WORDS = ['controller', 'mobile', 'phone', 'browser', 'device'];

async function add() {
  const what = (rest.find((a) => !a.startsWith('--')) || '').toLowerCase();

  if (CONTROLLER_WORDS.includes(what)) return printDeviceLink(rest.slice(1));
  if (what === 'pc' || what === 'laptop' || what === 'vm') {
    return inviteMachine(what === 'vm' ? 'vm' : 'pc');
  }

  console.log('\n  What are you adding?\n');
  console.log('    helm add controller    a phone or browser - controls machines, runs nothing');
  console.log('    helm add pc            a laptop or desktop - runs agents, and controls others');
  console.log('    helm add vm            an always-on machine - runs agents, and others dial it\n');
  if (what) console.log(`  ("${what}" is none of those.)\n`);
}

async function inviteMachine(role) {
  const net = requireNetwork();
  const { base: where, value } = await postToHome(net, '/api/invite', { role });
  const { code } = value;
  console.log(`\n  On the ${role === 'vm' ? 'VM' : 'computer'} you are adding, run:\n`);
  console.log(`    helm join ${code} ${where}\n`);
  if (role === 'vm') {
    console.log('  It will take its own https address and start serving, so other');
    console.log('  machines can dial it as well as this one.');
  } else {
    console.log('  It will dial this home; it needs no address of its own.');
  }
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

  // An invite made with `helm add vm` says so, and a vm is a home: it needs an
  // address of its own and https in front of it, which is the rest of what
  // `helm setup` does. Nobody has to remember a second command for it.
  if (net.role === 'vm') {
    console.log('  invited as a vm, so this machine becomes a home as well.\n');
    await setup({ alreadyJoined: true });
    return;
  }

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
  // Arriving from `helm join`, the positionals are the invite code and the
  // home it was redeemed at - neither of which is this machine's own address.
  // Take one only from --advertise there, or work it out below.
  let home = alreadyJoined
    ? cleanEndpoint(strFlag('advertise'))
    : cleanEndpoint(rest.find((a, i) => !a.startsWith('--') && !flagValues.has(i)));
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
  die(`no machine could transcribe that:\n  ${failures.join('\n  ')}`);
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
    if (!audio?.length) { notify('nothing was recorded', true); die('nothing was recorded'); }

    // Nothing reached the microphone: say so here rather than paying Groq to
    // hallucinate a "Thank you." into the owner's prompt.
    const level = levelOfWav(audio);
    if (level && level.rms < SILENCE_RMS) {
      rmSync(DICTATE_WAV, { force: true });
      notify('nothing was said - is the microphone muted?', true);
      die(`nothing was said (loudness ${level.rms.toFixed(4)}, silence is under ${SILENCE_RMS}) - is the microphone muted, or the wrong input selected?`);
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
    if (!text) { notify('nothing was said', true); die('nothing was said'); }

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
  if (!rec) die('no recorder here - install pipewire (pw-record) or alsa-utils (arecord)');
  rmSync(DICTATE_WAV, { force: true });
  const child = spawn(rec.cmd, rec.args, { stdio: 'ignore', detached: true });
  child.unref();
  writeFileSync(DICTATE_PID, String(child.pid));
  notify(to ? `recording for ${to}… press the key again to send` : 'recording… press the key again to transcribe');
  console.log(`recording (${rec.cmd}); run \`helm dictate${to ? ` --to ${to}` : ''}\` again to stop`);
}

// ------------------------------------------------------------------- brain
//
// The network, addressable from a shell. The brain uses these; so can a
// person, which is the reason they print rather than return JSON by default.

const brainRpc = (env, method, params = {}, timeout = 25_000) =>
  hubRpc(requireNetwork(), env, method, params, { timeout });

/** A machine by name, short id or full id. */
function machineId(who) {
  const net = requireNetwork();
  const all = Object.values(net.machines ?? {});
  const want = String(who ?? '').toLowerCase();
  const hit = all.find((m) => m.id === who)
    || all.find((m) => m.name.toLowerCase() === want)
    || all.find((m) => m.id.startsWith(want))
    || all.find((m) => m.name.toLowerCase().startsWith(want));
  if (!hit) die(`no machine called "${who}" - try: ${all.map((m) => m.name).join(', ')}`);
  return hit.id;
}

/** The home machine: where a brain lives unless told otherwise. */
function brainHome() {
  const net = requireNetwork();
  const vm = Object.values(net.machines ?? {}).find((m) => m.role === 'vm' && m.id !== net.self);
  return flagOf('on') ? machineId(flagOf('on')) : (vm?.id ?? net.self);
}

/** Ask every machine for its digest and write the snapshot down. */
async function gather() {
  const net = requireNetwork();
  const fresh = {};
  await Promise.all(Object.keys(net.machines ?? {}).map(async (id) => {
    try {
      const r = await hubRpc(net, id, M.BRAIN_DIGEST, {}, { timeout: 8000 });
      fresh[id] = { name: r.name ?? net.machines[id]?.name ?? id, sessions: r.sessions ?? [] };
    } catch { /* offline: the snapshot keeps what it had, dated */ }
  }));
  const snap = writeSnapshot(mergeSnapshot(readSnapshot(), fresh));
  const now = Date.now();
  const roster = Object.fromEntries(Object.values(net.machines ?? {}).map((m) =>
    [m.id, { name: m.name, online: now - (snap.machines?.[m.id]?.at ?? 0) < 90_000 }]));
  return { snap, roster };
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
  if (!id) die('which session? `helm digest` lists them');
  const { snap } = await gather();
  const hits = [];
  for (const [env, entry] of Object.entries(snap.machines ?? {})) {
    for (const s of entry.sessions ?? []) {
      if (s.id === id || shortId(s.id) === id || s.id.startsWith(id)) {
        hits.push({ env, machine: entry.name, session: s });
      }
    }
  }
  if (!hits.length) die(`no session "${id}" - \`helm digest\` lists them`);
  if (hits.length > 1) {
    die(`"${id}" matches ${hits.length} sessions:\n` +
        hits.map((h) => `  ${h.machine}  ${h.session.id}  ${h.session.title}`).join('\n'));
  }
  return hits[0];
}

async function printThread() {
  const { env, machine, session } = await findSession(rest[0]);
  const n = Number(flagOf('n', flagOf('tail', 40)));
  // The tail: this prints the last n lines of a conversation, and a page is
  // budgeted in bytes now - asking from event 1 would spend it on the oldest
  // part of a long thread and print none of what was asked for.
  const r = await brainRpc(env, M.SESSION_EVENTS, { id: session.id, tail: 1000, limit: 1000 });
  console.log(`${machine}  ${session.id}  ${session.title}`);
  console.log(`${session.engine}${session.model ? ` (${session.model})` : ''} in ${session.cwd} - ${session.status}\n`);
  for (const line of readThread(r.events ?? [], { limit: Math.max(1, n) })) console.log(line);
  const open = (r.pending ?? []).length;
  if (open) console.log(`\n${open} permission request${open === 1 ? '' : 's'} waiting - answer in the app, or with \`helm say\` if it takes words.`);
}

async function say() {
  const [id, ...words] = rest.filter((x) => !x.startsWith('--'));
  const text = words.join(' ');
  if (!text) die('what should it say? `helm say <id> <text>`');
  const { env, machine, session } = await findSession(id);
  await brainRpc(env, M.SESSION_INPUT, { id: session.id, data: text });
  console.log(`sent to ${machine} ${shortId(session.id)} (${session.title})`);
}

async function spawn_() {
  const args = rest.filter((x) => !x.startsWith('--'));
  const [who, folder, account, ...words] = args;
  const text = words.join(' ');
  if (!who || !folder || !account) {
    die('helm spawn <machine> <folder> <account> <text...>');
  }
  const env = machineId(who);
  const { profiles } = await brainRpc(env, M.PROFILE_LIST, {});
  const want = account.toLowerCase();
  const profile = profiles.find((x) => x.id === account)
    || profiles.find((x) => String(x.account ?? '').toLowerCase() === want)
    || profiles.find((x) => x.id.toLowerCase().startsWith(want));
  if (!profile) {
    die(`no account "${account}" on that machine - it has: ${profiles.map((x) => x.id).join(', ')}`);
  }
  const { session } = await brainRpc(env, M.SESSION_START, {
    cwd: folder, profileId: profile.id, model: flagOf('model'), mode: flagOf('mode'),
    title: flagOf('title'),
  }, 60_000);
  if (text) await brainRpc(env, M.SESSION_INPUT, { id: session.id, data: text });
  console.log(`${shortId(session.id)}  ${session.title}  (${profile.engine} on ${who}, ${folder})`);
  if (text) console.log('prompted.');
}

async function openBrain() {
  const env = brainHome();
  const net = requireNetwork();
  const name = net.machines[env]?.name ?? env;
  let account = flagOf('account');
  try {
    const { session, created } = await brainRpc(env, M.BRAIN_OPEN, {
      profileId: account, model: flagOf('model'), mode: flagOf('mode'),
    }, 60_000);
    console.log(`${created ? 'started' : 'resumed'} the brain on ${name}: ${shortId(session.id)} (${session.engine}${session.model ? `, ${session.model}` : ''})`);
    console.log('open it in the app under "brains", or talk to it here:');
    console.log(`  helm say ${shortId(session.id)} "what is waiting on me?"`);
  } catch (err) {
    if (!/needs a profileId/.test(err.message)) throw err;
    const { profiles } = await brainRpc(env, M.PROFILE_LIST, {});
    const usable = profiles.filter((x) => ['claude', 'codex', 'opencode', 'devin'].includes(x.engine));
    console.error(`helm: which account should be the brain on ${name}?\n`);
    for (const x of usable) console.error(`  helm brain --account ${x.id}${' '.repeat(Math.max(1, 22 - x.id.length))}${x.engine}`);
    exit(1);
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
      await add();
      break;

    case 'open':
      await openApp();
      break;

    case 'app': {
      const { installApp, removeApp } = await import('../src/desktop.js');
      if (rest.includes('--remove') || rest.includes('remove')) {
        const { removed, icons } = removeApp();
        console.log(removed
          ? `\n  removed the helm desktop entry and ${icons} icon${icons === 1 ? '' : 's'}.\n`
          : '\n  there was no helm desktop entry here.\n');
        break;
      }
      const net = requireNetwork();
      const at = `http://127.0.0.1:${net.port ?? 8787}/`;
      const pick = rest[rest.indexOf('--browser') + 1];
      const r = installApp({ url: at, browser: rest.includes('--browser') ? pick : undefined });
      console.log(`\n  helm is in your applications, opening ${r.url}`);
      console.log(r.windowed
        ? `  its own window, through ${r.browser}. It signs itself in; there is nothing to type.`
        : '  no chromium-family browser found, so it opens in your default one.');
      console.log('  remove it again with:  helm app --remove\n');
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
      console.log(`machine:  ${me?.name} (${short(net.self)}${net.role ? `, ${net.role}` : ''})`);
      console.log(`members:  ${Object.keys(net.machines).length} machines, ` +
                  `${Object.keys(net.devices).length} controllers`);
      console.log(`reachable at: ${(me?.endpoints ?? []).join(' ') || '(not advertised yet)'}`);

      // A full-tunnel VPN leaves the LAN address on the interface but routes
      // the subnet into the tunnel, so the address helm advertises is one it
      // cannot answer on. Nothing else reports this, and the symptom - a
      // phone on the same wifi quietly relaying through the hub instead of
      // connecting directly - looks like helm being slow.
      const { lanIsRoutable } = await import('../src/net-addr.js');
      const lan = await lanIsRoutable();
      if (lan && !lan.ok) {
        console.log(`
  ! ${lan.address} is advertised for this network, but traffic to it leaves
    over ${lan.via} rather than ${lan.expected}. A device on the same wifi
    cannot reach this machine directly, so sessions relay through your Helm
    home - which is slower, often by a lot.

    Usually a VPN carrying everything. With Tailscale:
      tailscale set --exit-node-allow-lan-access=true`);
      }
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
        console.log('           build one with a compiler installed, then re-run install.sh');
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
    case 'brain':
      await openBrain();
      break;

    case 'digest':
      await printDigest();
      break;

    case 'thread':
      await printThread();
      break;

    case 'say':
      await say();
      break;

    case 'spawn':
      await spawn_();
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
