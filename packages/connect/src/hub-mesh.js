import { randomUUID } from 'node:crypto';
import { T } from '@helm/protocol';

export class HubMesh {
  constructor(network, changed, event, signalEvent) {
    this.network = network;
    this.changed = changed;
    this.event = event;
    this.signalEvent = signalEvent;
    this.signals = new Map();
    this.links = new Map();
    this.pending = new Map();
    this.subscriptions = [];
  }

  up(link) {
    this.links.set(link, new Map());
    link.send(T.HUB_WATCH, { envs: this.subscriptions });
  }

  down(link) {
    this.links.delete(link);
    for (const [key, route] of this.signals) {
      if (route.link === link) this.signals.delete(key);
    }
    for (const [id, request] of this.pending) {
      if (request.link !== link) continue;
      this.pending.delete(id);
      clearTimeout(request.timer);
      request.reject(new Error('hub link disconnected; delivery may be uncertain'));
    }
    this.changed();
  }

  watch(envs) {
    this.subscriptions = [...envs];
    for (const link of this.links.keys()) link.send(T.HUB_WATCH, { envs: this.subscriptions });
  }

  machines() {
    const network = this.network();
    const machines = new Map();
    for (const [link, snapshot] of this.links) {
      if (!link.connected) continue;
      for (const [id, machine] of snapshot) {
        if (id !== network?.self && Object.hasOwn(network?.machines ?? {}, id) && !network.revoked?.[id]) machines.set(id, machine);
      }
    }
    return machines;
  }

  receive(link, frame) {
    if (!this.links.has(link)) return false;
    if (frame.t === T.HUB_SIGNAL) {
      const route = this.signals.get(`${frame.peer}:${frame.env}`);
      if (route?.link === link && this.machines().has(frame.env)
          && [T.SIGNAL, T.SIGNAL_READY].includes(frame.kind)) this.signalEvent?.(frame);
      return true;
    }
    if (frame.t === T.HUB_STATE && Array.isArray(frame.machines)) {
      this.links.set(link, new Map(frame.machines.filter(machine => typeof machine?.id === 'string').map(machine => [machine.id, machine])));
      this.changed();
      return true;
    }
    if (frame.t === T.HUB_EVENT) {
      const network = this.network();
      if (this.links.get(link).has(frame.env) && Object.hasOwn(network?.machines ?? {}, frame.env) && !network.revoked?.[frame.env]) this.event(frame);
      return true;
    }
    if (frame.t !== T.RPC_RESULT) return false;
    const request = this.pending.get(frame.id);
    if (!request || request.link !== link) return false;
    this.pending.delete(frame.id);
    clearTimeout(request.timer);
    if (frame.ok) request.resolve(frame.result);
    else request.reject(Object.assign(new Error(frame.error?.message ?? 'remote request failed'), { code: frame.error?.code }));
    return true;
  }

  call(env, method, params, { sub, timeout = 130_000 } = {}) {
    const network = this.network();
    if (!Object.hasOwn(network?.machines ?? {}, env) || network.revoked?.[env]) return Promise.reject(new Error('unknown machine'));
    const link = [...this.links].find(([candidate, machines]) => candidate.connected && machines.has(env))?.[0];
    if (!link) return Promise.reject(Object.assign(new Error('environment is not connected'), { code: 'offline' }));
    return new Promise((resolve, reject) => {
      const id = `mesh-${randomUUID()}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('remote request timed out; delivery may be uncertain'), { code: 'timeout' }));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { link, resolve, reject, timer });
      link.send(T.HUB_RPC, { id, env, method, params, sub: sub ?? network.self });
    });
  }

  signal(env, peer, payload, device) {
    if (!this.machines().has(env)) return;
    const key = `${peer}:${env}`;
    let route = this.signals.get(key);
    if (!route || payload?.type === 'offer') {
      const link = [...this.links].find(([candidate, machines]) => candidate.connected && machines.has(env))?.[0];
      if (!link) return;
      route = { link, peer, env };
      this.signals.set(key, route);
    }
    route.link.send(T.HUB_SIGNAL, { env, peer, payload, device });
  }

  forgetPeer(peer) {
    const links = new Set();
    for (const [key, route] of this.signals) {
      if (route.peer !== peer) continue;
      links.add(route.link);
      this.signals.delete(key);
    }
    for (const link of links) link.send(T.HUB_SIGNAL_CLOSE, { peer });
  }

  stop() {
    for (const link of [...this.links.keys()]) this.down(link);
  }
}
