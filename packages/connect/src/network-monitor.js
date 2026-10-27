import { networkInterfaces, platform } from 'node:os';
import { readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ordered = values => values.map(value => JSON.stringify(value)).sort();

/** Exclude changing route-cache counters while retaining VPN policy and paths. */
export function networkSignature({ interfaces = {}, routes = [], rules = [], dns = '' }) {
  return JSON.stringify({
    interfaces: ordered(Object.entries(interfaces).flatMap(([name, addresses]) =>
      addresses.filter(a => !a.internal).map(a => [name, a.family, a.address, a.netmask, a.scopeid ?? null]))),
    routes: ordered(routes.map(({ dst, gateway, dev, table, type, metric, prefsrc, nexthops }) =>
      ({ dst, gateway, dev, table, type, metric, prefsrc, nexthops }))),
    rules: ordered(rules), dns,
  });
}

async function snapshot() {
  const json = async args => {
    try { return JSON.parse((await exec('ip', args, { timeout: 2000, maxBuffer: 1024 * 1024 })).stdout); }
    catch { return []; }
  };
  const [routes4, routes6, rules4, rules6, dns] = await Promise.all([
    ...(platform() === 'linux' ? [
      json(['-j', 'route', 'show', 'table', 'all']), json(['-6', '-j', 'route', 'show', 'table', 'all']),
      json(['-j', 'rule', 'show']), json(['-6', '-j', 'rule', 'show']),
    ] : [[], [], [], []]),
    readFile('/etc/resolv.conf', 'utf8').catch(() => ''),
  ]);
  return networkSignature({ interfaces: networkInterfaces(), routes: [...routes4, ...routes6],
    rules: [...rules4, ...rules6], dns });
}

const watch = () => platform() === 'linux' && process.env.HELM_NO_SERVICE !== '1' && !process.env.NODE_TEST_CONTEXT
  ? spawn('ip', ['monitor', 'link', 'address', 'route', 'rule'], { stdio: ['ignore', 'pipe', 'ignore'] }) : null;

/**
 * Kernel events give prompt recovery; polling also handles missed events and
 * wake. While the kernel feed runs, a full sample (four `ip` runs) is needed
 * only once a minute; the 5 s tick still notices a wake from the clock alone.
 */
export class NetworkMonitor {
  #stopped = false;
  #signature = null;
  #last = null;
  #pending = null;
  #again = false;
  #timer = null;
  #debounce = null;
  #watcher = null;
  #watching = false;
  #sampled = 0;

  constructor(changed, { sample = snapshot, observe = watch, now = Date.now, every = 5000, watchedEvery = 60_000, wakeAfter = 15_000 } = {}) {
    Object.assign(this, { changed, sample, observe, now, every, watchedEvery, wakeAfter });
  }

  async start() {
    await this.check();
    if (this.#stopped) return this;
    try { this.#watcher = this.observe(); } catch { /* polling remains */ }
    this.#watching = !!this.#watcher;
    // Polling remains when ip is absent or the feed ends.
    this.#watcher?.on('error', () => { this.#watching = false; });
    this.#watcher?.on('exit', () => { this.#watching = false; });
    this.#watcher?.stdout.on('data', () => {
      if (this.#stopped || this.#debounce) return;
      this.#debounce = setTimeout(() => { this.#debounce = null; void this.check(); }, 200);
      this.#debounce.unref?.();
    });
    this.#timer = setInterval(() => this.#tick(), this.every);
    this.#timer.unref?.();
    return this;
  }

  #tick() {
    const now = this.now();
    const woke = this.#last !== null && now - this.#last > this.wakeAfter;
    if (!woke && this.#watching && now - this.#sampled < this.watchedEvery) { this.#last = now; return; }
    void this.check();
  }

  check() {
    if (this.#stopped) return Promise.resolve();
    if (this.#pending) { this.#again = true; return this.#pending; }
    this.#pending = (async () => {
      do {
        this.#again = false;
        const now = this.now();
        const woke = this.#last !== null && now - this.#last > this.wakeAfter;
        this.#last = this.#sampled = now;
        let signature;
        try { signature = await this.sample(); } catch { continue; }
        if (this.#stopped) return;
        const changed = this.#signature !== null && signature !== this.#signature;
        this.#signature = signature;
        if (changed || woke) await this.changed(woke ? 'woke from sleep' : 'network changed');
      } while (this.#again && !this.#stopped);
    })().catch(() => {}).finally(() => { this.#pending = null; });
    return this.#pending;
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    clearTimeout(this.#debounce);
    this.#watcher?.kill();
  }
}
