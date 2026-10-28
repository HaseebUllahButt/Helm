import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** A small status history. It stores machine IDs, never addresses or chat data. */
export class ConnectionHistory {
  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.events = [];
    this.states = Object.create(null);
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(saved.events) && saved.states && typeof saved.states === 'object') {
        this.events = saved.events.filter(e => typeof e.env === 'string' && Number.isFinite(e.at) && e.at >= 0 && e.at <= now()
          && ['connected', 'disconnected', 'path-changed'].includes(e.state)).slice(-100);
        this.states = Object.assign(Object.create(null), saved.states);
      }
    } catch { /* A missing history never prevents a connection. */ }
  }

  observe(machines) {
    let changed = false;
    const at = this.now();
    const ids = new Set(machines.map(m => m.env));
    for (const id of Object.keys(this.states)) if (!ids.has(id)) { delete this.states[id]; changed = true; }
    this.events = this.events.filter(e => ids.has(e.env));
    for (const machine of machines) {
      const path = machine.direct?.used ? 'direct' : machine.attached ? 'attached'
        : machine.url ? `home-${createHash('sha256').update(machine.url).digest('hex')}` : 'none';
      const previous = this.states[machine.env];
      if (previous?.path !== path) {
        this.events.push({ env: machine.env, at, state: path === 'none' ? 'disconnected'
          : previous && previous.path !== 'none' ? 'path-changed' : 'connected' });
        changed = true;
      }
      this.states[machine.env] = { path, lastSeen: path !== 'none' ? at : previous?.lastSeen ?? null };
    }
    this.events = this.events.slice(-100);
    // Save last-answer times too. A later restart must not invent fresh answers.
    if (changed || at - (this.savedAt ?? 0) >= 60_000) {
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ events: this.events, states: this.states }), { mode: 0o600 });
        renameSync(temp, this.file);
        this.savedAt = at;
      } catch { /* Full disks must not stop network recovery. */ }
    }
    return { machines: machines.map(m => ({ ...m, lastSeen: this.states[m.env].lastSeen })), history: this.events.slice() };
  }
}
