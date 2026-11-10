import { cpus, totalmem, freemem, loadavg, uptime, homedir, platform } from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';

/**
 * What this machine has and how busy it is, for the dashboard. Read only
 * when someone asks (`machine.stats`): no timer runs while nobody looks.
 *
 * CPU use is the share of time the cores were not idle since the last ask.
 * The first ask, or one after a long gap, measures a short window instead.
 */
const SHORT_WINDOW_MS = 300;
const STALE_MS = 60_000;
const MIN_WINDOW_MS = 1000;
const GPU_TIMEOUT_MS = 2000;
const GPU_CACHE_MS = 3000;

const ticks = () => cpus().reduce((sum, c) => {
  const t = c.times;
  sum.idle += t.idle;
  sum.total += t.user + t.nice + t.sys + t.idle + t.irq;
  return sum;
}, { idle: 0, total: 0 });

let last = null;

export function cpuShare(before, after) {
  const total = after.total - before.total;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (after.idle - before.idle) / total) * 1000) / 10));
}

async function cpuUse(now = Date.now()) {
  // Two viewers asking at once: a window of a few milliseconds says nothing.
  if (last && now - last.at < MIN_WINDOW_MS && last.used != null) return last.used;
  let before = last;
  if (!before || now - before.at > STALE_MS) {
    before = { ...ticks(), at: now };
    await new Promise((resolve) => setTimeout(resolve, SHORT_WINDOW_MS));
  }
  const after = { ...ticks(), at: Date.now() };
  after.used = cpuShare(before, after);
  last = after;
  return after.used;
}

/** MemAvailable counts the cache Linux gives back on demand; MemFree does not. */
export function memoryOf(meminfo, total = totalmem(), free = freemem()) {
  const kb = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(meminfo ?? '');
    return m ? Number(m[1]) * 1024 : null;
  };
  const all = kb('MemTotal') ?? total;
  const available = kb('MemAvailable') ?? free;
  return { total: all, used: Math.max(0, all - available) };
}

/** `nvidia-smi` CSV rows: name, use %, memory used MiB, memory total MiB. */
export function parseNvidia(text) {
  return String(text ?? '').split('\n').map((line) => line.split(',').map((x) => x.trim())).filter((r) => r.length >= 4 && r[0])
    .map(([name, use, used, total]) => ({
      name,
      used: Number.isFinite(Number(use)) ? Number(use) : null,
      memory: Number.isFinite(Number(total)) ? { total: Number(total) * 1048576, used: Number(used) * 1048576 } : null,
    }));
}

let gpuCache = null;
let noNvidia = false;
function gpus() {
  if (noNvidia || platform() === 'darwin') return Promise.resolve([]);
  if (gpuCache && Date.now() - gpuCache.at < GPU_CACHE_MS) return gpuCache.work;
  const work = new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: GPU_TIMEOUT_MS }, (error, stdout) => {
        // No driver here: never try again until Helm restarts.
        if (error?.code === 'ENOENT') noNvidia = true;
        resolve(error ? [] : parseNvidia(stdout));
      });
  });
  gpuCache = { at: Date.now(), work };
  return work;
}

function disk() {
  try {
    const s = statfsSync(homedir());
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

export async function machineStats() {
  let meminfo = null;
  if (platform() === 'linux') try { meminfo = readFileSync('/proc/meminfo', 'utf8'); } catch { /* use os numbers */ }
  const list = cpus();
  const [cpu, gpu] = await Promise.all([cpuUse(), gpus()]);
  return {
    at: Date.now(),
    cpu: { cores: list.length, model: list[0]?.model?.trim() || null, used: cpu },
    load: platform() === 'win32' ? null : loadavg().map((n) => Math.round(n * 100) / 100),
    memory: memoryOf(meminfo),
    disk: disk(),
    gpus: gpu,
    uptime: Math.round(uptime()),
  };
}

const gb = (n) => `${Math.round(n / 1e8) / 10} GB`;

/** One line for `helm machines --load`. */
export function statsLine(s) {
  const parts = [];
  if (s?.cpu) parts.push(`CPU ${s.cpu.used ?? '?'}% of ${s.cpu.cores} cores`);
  if (s?.memory) parts.push(`memory ${gb(s.memory.used)} of ${gb(s.memory.total)}`);
  for (const g of s?.gpus ?? []) parts.push(`GPU ${g.name} ${g.used ?? '?'}%${g.memory ? `, ${gb(g.memory.used)} of ${gb(g.memory.total)}` : ''}`);
  if (s?.disk) parts.push(`disk ${gb(s.disk.free)} free`);
  return parts.join(' · ') || 'no numbers';
}
