import test from 'node:test';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared by test/sudo and test/sudo-cli: a private Helm folder, a fake sudo
// on PATH and one driven chat. Import it before any Helm module.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-sudo-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1, profiles: [{ id: 'devin', engine: 'devin', cmd: 'devin', source: 'alias' }],
}));

/**
 * The fake sudo. It reads its settings from a file, since Helm starts sudo
 * with a small environment: the right password, or "nopass" for a machine
 * where sudo needs none. Each call is written to the log.
 */
const bin = join(process.env.HELM_DIR, 'bin');
const fakeConfig = join(bin, 'config');
const fakeLog = join(bin, 'calls');
function writeFakeSudo() {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh
echo "$*" >> '${fakeLog}'
want=$(cat '${fakeConfig}')
v=0; n=0
while [ $# -gt 0 ]; do
  case "$1" in
    -k|-S) shift;;
    -n) n=1; shift;;
    -v) v=1; shift;;
    -p) shift 2;;
    --) shift; break;;
    *) break;;
  esac
done
if [ "$n" = 1 ]; then
  if [ "$want" = nopass ]; then exec "$@"; fi
  echo "sudo: a password is required" >&2; exit 1
fi
IFS= read -r typed || typed=""
if [ "$typed" != "$want" ]; then
  echo "Sorry, try again." >&2
  echo "sudo: no password was provided" >&2
  echo "sudo: 1 incorrect password attempt" >&2
  exit 1
fi
[ "$v" = 1 ] && exit 0
exec "$@"
`);
  chmodSync(join(bin, 'sudo'), 0o755);
}
export const setFake = (password) => writeFileSync(fakeConfig, password);

writeFakeSudo();
process.env.PATH = `${bin}:${process.env.PATH}`;

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.status = 'idle'; this.engineSessionId = 'engine-1'; this.pending = new Map(); this.sent = []; this.answers = []; }
  push(type, payload) { if (type === 'status') this.status = payload.status; this.emit('event', { type, ...payload }); }
  async start() {}
  async send(text) { this.sent.push(text); this.push('status', { status: 'working' }); this.push('turn.start', { turnId: `t${this.sent.length}`, text }); }
  async answer(requestId, decision) { this.answers.push({ requestId, decision }); }
  async interrupt() {}
  async kill() { this.push('status', { status: 'exited' }); }
}

let n = 0;
export const newId = () => `sudo-test${String(++n).padStart(8, '0')}`;

export async function setup(t, { password = 'right horse', saved = 'right horse', now } = {}) {
  setFake(password);
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const { AdminRuns, AdminPassword } = await import('../packages/connect/src/sudo.js');
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'sudo-'));
  let driver = null;
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.HELM_DIR, `events-${Math.random().toString(36).slice(2)}`)),
    makeDriver: (engine, opts) => (driver = new FakeDriver({ engine, ...opts })),
  });
  const session = await sessions.start({ cwd: '/tmp', profileId: 'devin' });
  await sessions.input(session.id, 'Work');
  if (saved) new AdminPassword(dir).save(Buffer.from(saved));
  const make = () => {
    const runs = new AdminRuns({ sessions, dir, machineName: () => 'testbox', ...(now ? { now } : {}) });
    sessions.helmAsks = runs;
    return runs;
  };
  const runs = make();
  t.after(() => { sessions.helmAsks?.stop(); return sessions.stop(); });
  const cards = () => sessions.events.pending(session.id).filter((p) => p.requestId.startsWith('sudo-'));
  const events = () => sessions.history(session.id).events;
  const ask = (command, extra = {}) => sessions.helmAsks.ask({ sessionId: session.id, requestId: extra.requestId ?? newId(), command, cwd: '/tmp', ...extra });
  return { sessions, session, runs, make, dir, cards, events, ask, driver };
}

