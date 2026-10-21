import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Client, Environment, SendJob } from '../client';
import { workspaceScope } from '../workspaceCache';

export const sending = (job: SendJob) => ['preparing', 'sending', 'finishing'].includes(job.phase);
export const sendTime = (time: string | number) => typeof time === 'number' ? time : Date.parse(time);
export const sendName = (job: SendJob) => job.source.path.replace(/\/+$/, '').split('/').pop() || job.source.path;
export function sendAction(jobs: SendJob[], sourceId: string, path: string, defaultTarget?: string) {
  const previous = jobs.find(job => job.source.machineId === sourceId && job.source.path === path && job.phase === 'done');
  return previous ? `Send again to ${previous.target.name}` : defaultTarget ? `Send to ${defaultTarget}` : 'Send';
}
export const sendPercent = (job: SendJob) => job.bytes.total && job.bytes.total > 0
  ? Math.min(100, Math.round(job.bytes.sent / job.bytes.total * 100)) : null;

type Snapshot = { jobs: SendJob[]; notices: SendJob[]; errors: Record<string, string> };
/** Shared by all views, scoped to the signed-in Client. No browser-owned transfer jobs. */
export class SendStore {
  private snapshot: Snapshot = { jobs: [], notices: [], errors: {} };
  private listeners = new Set<() => void>();
  private watchers = new Map<object, string[]>();
  private busy = new Set<string>();
  private listed = new Set<string>();
  private seen: Set<string>;
  private pending: Set<string>;
  private key: string;
  private timer?: ReturnType<typeof setInterval>;
  private off?: () => void;
  private ticks = 0;
  constructor(private client: Client) {
    this.key = `helm.send-notified:${workspaceScope(client.token)}`;
    try { this.seen = new Set(JSON.parse(localStorage.getItem(this.key) || '[]')); }
    catch { this.seen = new Set(); }
    try { this.pending = new Set(JSON.parse(localStorage.getItem(this.key + ':active') || '[]')); }
    catch { this.pending = new Set(); }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(snapshot: Snapshot) { this.snapshot = snapshot; this.listeners.forEach(listener => listener()); }
  private remember(id: string) {
    this.seen.add(id);
    try { localStorage.setItem(this.key, JSON.stringify([...this.seen].slice(-100))); } catch { /* storage unavailable */ }
  }
  accept = (job: SendJob, notify = true) => {
    if (!job?.id || !job.source?.machineId) return;
    const previous = this.snapshot.jobs.find(item => item.id === job.id && item.source.machineId === job.source.machineId);
    if (previous && sendTime(previous.updatedAt) > sendTime(job.updatedAt)) return;
    // Equal snapshots from status/list must not announce completion twice.
    const wasPending = this.pending.has(job.id);
    if (sending(job)) this.pending.add(job.id); else this.pending.delete(job.id);
    if (wasPending !== this.pending.has(job.id)) {
      try { localStorage.setItem(this.key + ':active', JSON.stringify([...this.pending])); } catch { /* storage unavailable */ }
    }
    let notices = this.snapshot.notices;
    if (job.phase === 'done' && !this.seen.has(job.id)) {
      this.remember(job.id);
      if (notify || wasPending) notices = [...notices, job];
    }
    const jobs = this.snapshot.jobs.filter(item => !(item.id === job.id && item.source.machineId === job.source.machineId));
    jobs.push(job);
    jobs.sort((a, b) => Number(sending(b)) - Number(sending(a)) || sendTime(b.createdAt) - sendTime(a.createdAt));
    this.publish({ ...this.snapshot, jobs, notices });
  };
  dismiss = (id: string) => this.publish({ ...this.snapshot, notices: this.snapshot.notices.filter(job => job.id !== id) });
  private error(env: string, error?: string) {
    const errors = { ...this.snapshot.errors };
    if (error) errors[env] = error; else delete errors[env];
    this.publish({ ...this.snapshot, errors });
  }
  refresh = async (env: string) => {
    const key = `list:${env}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const { jobs } = await this.client.sendList(env);
      const first = !this.listed.has(env);
      for (const job of jobs) this.accept(job, !first || this.snapshot.jobs.some(item => item.id === job.id && sending(item)));
      this.listed.add(env); this.error(env);
    } catch { this.error(env, 'Helm cannot get send progress. Helm is reconnecting.'); }
    finally { this.busy.delete(key); }
  };
  status = async (env: string, id: string) => {
    const key = `status:${env}:${id}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try { const { job } = await this.client.sendStatus(env, id); this.accept(job); this.error(env); }
    catch { this.error(env, 'Helm cannot get send progress. Helm is reconnecting.'); }
    finally { this.busy.delete(key); }
  };
  private wake = () => {
    if (document.visibilityState === 'hidden') return;
    for (const env of new Set([...this.watchers.values()].flat())) void this.refresh(env);
    this.poll();
  };
  private poll = () => {
    if (document.visibilityState === 'hidden') return;
    const envs = new Set([...this.watchers.values()].flat());
    for (const job of this.snapshot.jobs) if (sending(job) && envs.has(job.source.machineId)) void this.status(job.source.machineId, job.id);
    if (++this.ticks % 8 === 0) for (const env of envs) void this.refresh(env);
  };
  watch(envs: string[]) {
    const owner = {};
    this.watchers.set(owner, envs);
    if (!this.off) {
      this.off = this.client.on((env, kind, payload) => {
        if (kind === 'send.update') this.accept(payload.job);
        if (kind === 'connection' || kind === 'env.online') this.wake();
      });
      this.timer = setInterval(this.poll, 2000);
      window.addEventListener('online', this.wake);
      window.addEventListener('pageshow', this.wake);
      document.addEventListener('visibilitychange', this.wake);
    }
    for (const env of envs) { this.client.subscribe(env); void this.refresh(env); }
    return () => {
      this.watchers.delete(owner);
      if (this.watchers.size) return;
      this.off?.(); this.off = undefined; clearInterval(this.timer);
      window.removeEventListener('online', this.wake);
      window.removeEventListener('pageshow', this.wake);
      document.removeEventListener('visibilitychange', this.wake);
    };
  }
}
const stores = new WeakMap<Client, SendStore>();
export function sendStore(client: Client) {
  let store = stores.get(client);
  if (!store) { store = new SendStore(client); stores.set(client, store); }
  return store;
}
export function useSends(client: Client, envs: Pick<Environment, 'id' | 'online'>[] = []) {
  const store = useMemo(() => sendStore(client), [client]);
  const ids = envs.filter(env => env.online).map(env => env.id).sort().join('\n');
  useEffect(() => store.watch(ids ? ids.split('\n') : []), [store, ids]);
  return { store, ...useSyncExternalStore(store.subscribe, store.getSnapshot) };
}
