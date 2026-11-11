import { useMemo } from 'react';
import { pickRoomiest, roomLeft, outUntil, isOut } from '@helm/protocol/balance';
import type { Client, Environment } from '../client';
import { AccountLimits, useAccountLimits, type LimitAccount } from '../AccountLimits';
import { EngineMark } from '../EngineMark';
import { engineOf } from '../engines';
import { BackIcon, Icon } from '../Icon';
import { bytes, memoryShare, useMachineStats, type MachineStats, type StatsState } from '../machineStats';
import { whenPhrase } from '../session/limits';
import { ago } from './common';
import type { HomeMachine } from './Home';

/** How often the screen asks each machine for its load. */
const EVERY_MS = 4000;

const kindName = (e: Environment) => e.kind === 'vm' ? 'VM' : e.kind ? 'Computer' : '';

/**
 * Every machine, the compute that is online and how busy it is, and what
 * each AI account has left, with where the limit balancer sends new work.
 */
export function DashboardView({ client, envs, machines, onBack, onOpenMachine }: {
  client: Client;
  envs: Environment[];
  machines: HomeMachine[];
  onBack: () => void;
  onOpenMachine: (envId: string) => void;
}) {
  const stats = useMachineStats(client, envs, EVERY_MS);
  const limits = useAccountLimits(client, envs);
  const online = envs.filter((e) => e.online);
  const answered = online.map((e) => stats[e.id]).filter((s): s is MachineStats => !!s && typeof s === 'object');
  const cores = answered.reduce((n, s) => n + s.cpu.cores, 0);
  const busyCores = answered.reduce((n, s) => n + (s.cpu.used ?? 0) / 100 * s.cpu.cores, 0);
  const memTotal = answered.reduce((n, s) => n + s.memory.total, 0);
  const memUsed = answered.reduce((n, s) => n + s.memory.used, 0);
  const gpus = answered.flatMap((s) => s.gpus);
  const gpuMemory = gpus.reduce((n, g) => n + (g.memory?.total ?? 0), 0);
  const unread = online.filter((e) => typeof stats[e.id] !== 'object').map((e) => e.name);

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <b>Dashboard</b>
      </div>
      <div className="scroll"><div className="pad usage dash">
        <h2 className="section">Compute online</h2>
        <dl className="usage-stats dash-stats">
          <div><dt>Machines online</dt><dd>{online.length} of {envs.length}</dd>
            <small>{machines.reduce((n, m) => n + m.running, 0)} chats running</small></div>
          <div><dt>CPU</dt><dd>{cores ? `${Math.round(busyCores / cores * 100)}%` : '–'}</dd>
            <small>{cores ? `of ${cores} cores` : 'No machine answered yet'}</small></div>
          <div><dt>Memory</dt><dd>{memTotal ? bytes(memUsed) : '–'}</dd>
            <small>{memTotal ? `in use of ${bytes(memTotal)}` : 'No machine answered yet'}</small></div>
          {gpus.length > 0 && <div><dt>GPUs</dt><dd>{gpus.length}</dd>
            <small>{gpuMemory ? `${bytes(gpuMemory)} of GPU memory` : 'GPU memory unknown'}</small></div>}
        </dl>
        {unread.length > 0 && answered.length > 0 && <p className="usage-limits-note">These totals do not include {unread.join(', ')}.</p>}

        <section className="usage-accounts" aria-label="Machines">
          <h2 className="section">Machines</h2>
          {machines.length ? (
            <div className="usage-panel">
              {machines.map((m) => <MachineBlock key={m.env.id} machine={m} stats={stats[m.env.id]} onOpen={() => onOpenMachine(m.env.id)} />)}
            </div>
          ) : <div className="empty quiet">You have no machines yet.<div className="note">Run <code>helm add pc</code> on a machine in your network.</div></div>}
        </section>

        <Balancer reports={limits.reports} envs={envs} now={limits.now} />
        <AccountLimits targets={envs} limits={limits} />
      </div></div>
    </>
  );
}

/** A meter with its number. Amber with "high" from 80%, red with "full" from 95%. */
function Meter({ label, used, value, detail }: { label: string; used: number | null; value: string; detail?: string }) {
  const level = used === null ? '' : used >= 95 ? ' full' : used >= 80 ? ' high' : '';
  return (
    <div className={`usage-allowance dash-meter${level}`}>
      <span className="usage-window">{label}</span>
      <div className="usage-meter" role="meter" aria-label={`${label} in use`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used ?? 0}>
        <span style={{ width: `${Math.max(0, Math.min(100, used ?? 0))}%` }} />
      </div>
      <b>{value}{level && <em>{level === ' full' ? ' · full' : ' · high'}</em>}</b>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function MachineBlock({ machine: { env, running, waiting }, stats, onOpen }: { machine: HomeMachine; stats: StatsState | undefined; onOpen: () => void }) {
  const s = typeof stats === 'object' ? stats : null;
  const mem = s ? memoryShare(s) : null;
  const facts = [kindName(env), s && `${s.cpu.cores} cores`, s?.disk && `${bytes(s.disk.free)} disk free`, s && s.uptime > 0 && `on for ${upFor(s.uptime)}`].filter(Boolean);
  return (
    <div className={`usage-account dash-machine${env.online ? '' : ' idle'}`}>
      <button type="button" className="dash-machine-name" onClick={onOpen} title={`Open ${env.name}`}>
        <span className={`mdot ${env.online ? 'on' : 'off'}`} />
        <span className="dash-machine-text">
          <b>{env.name}</b>
          <small>
            {!env.online ? (env.lastSeen ? `Offline · seen ${ago(env.lastSeen)}` : 'Never connected')
              : running ? `${running} running` : 'Nothing is running'}
            {waiting > 0 && <span className="attention"> · {waiting} {waiting === 1 ? 'needs' : 'need'} you</span>}
            {facts.length > 0 && ` · ${facts.join(' · ')}`}
          </small>
        </span>
        <span className="chev"><Icon name="forward" size={15} /></span>
      </button>
      {env.online && stats === 'old' && <p className="usage-limits-note">Update Helm on this machine to see its load.</p>}
      {env.online && stats === 'silent' && <p className="usage-limits-note">This machine did not send its load.</p>}
      {env.online && stats === undefined && <p className="usage-limits-note">Reading the load…</p>}
      {s && <div className="usage-account-windows">
        <Meter label="CPU" used={s.cpu.used} value={s.cpu.used === null ? '–' : `${Math.round(s.cpu.used)}%`}
          detail={s.load ? `Load ${s.load.map((n) => n.toFixed(1)).join(', ')}` : undefined} />
        <Meter label="Memory" used={mem} value={`${bytes(s.memory.used)} of ${bytes(s.memory.total)}`} />
        {s.gpus.map((g, i) => (
          <Meter key={i} label={s.gpus.length > 1 ? `GPU ${i + 1}` : 'GPU'} used={g.used} value={g.used === null ? '–' : `${Math.round(g.used)}%`}
            detail={[g.name, g.memory && `${bytes(g.memory.used)} of ${bytes(g.memory.total)} memory`].filter(Boolean).join(' · ')} />
        ))}
      </div>}
    </div>
  );
}

function upFor(seconds: number) {
  const h = Math.floor(seconds / 3600);
  return h >= 48 ? `${Math.floor(h / 24)} days` : h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(seconds / 60))}m`;
}

/**
 * Per AI tool with more than one account: how much each account has left,
 * and which one gets new work that nobody pinned to an account.
 */
function Balancer({ reports, envs, now }: { reports: Record<string, { accounts: LimitAccount[] }>; envs: Environment[]; now: number }) {
  const tools = useMemo(() => {
    // The same login read on two machines is one account.
    const seen = new Map<string, { key: string; engine: string; name: string; windows: LimitAccount['windows']; where: string[] }>();
    for (const env of envs) for (const a of reports[env.id]?.accounts ?? []) {
      const key = a.identity ?? `${env.id}:${a.account}`;
      const was = seen.get(key);
      if (was) {
        was.where.push(env.name);
        if (Math.max(0, ...a.windows.map((w) => w.at)) > Math.max(0, ...was.windows.map((w) => w.at))) was.windows = a.windows;
      } else seen.set(key, { key, engine: a.engine, name: a.displayLabel ?? a.label, windows: a.windows, where: [env.name] });
    }
    const byTool = new Map<string, typeof seen extends Map<string, infer V> ? V[] : never>();
    for (const a of seen.values()) byTool.set(a.engine, [...(byTool.get(a.engine) ?? []), a]);
    return [...byTool.entries()].filter(([, list]) => list.length > 1);
  }, [reports, envs]);
  if (!tools.length) return null;
  return (
    <section className="usage-accounts" aria-label="Limit balancer">
      <h2 className="section">Limit balancer</h2>
      <p className="usage-limits-note">
        When an account is out of limit, new chats and helpers go to the account of the same tool with the most limit left.
        An account you pick by hand always wins.
      </p>
      <div className="usage-panel">
        {tools.map(([engine, list]) => {
          const next = pickRoomiest(list, now);
          return (
            <div className="usage-account" key={engine}>
              <div className="usage-account-name">
                <EngineMark engine={engineOf(engine).cls} className="usage-share-mark" />
                <b>{engineOf(engine).label} <span>· next pick: {next?.name ?? 'none'}</span></b>
              </div>
              <ul className="dash-balance">
                {[...list].sort((a, b) => (roomLeft(b.windows, now) ?? -1) - (roomLeft(a.windows, now) ?? -1)).map((a) => {
                  const room = roomLeft(a.windows, now);
                  const out = isOut(a.windows, now);
                  const until = out ? outUntil(a.windows, now) : null;
                  return (
                    <li key={a.key} className={out ? 'out' : a === next ? 'next' : ''}>
                      <span>{a.name}{envs.length > 1 && <small> · {a.where.join(', ')}</small>}</span>
                      <b>{out ? (until ? `Out · back ${whenPhrase(until * 1000, now)}` : 'Out of limit')
                        : room === null ? 'No report yet' : `${Math.round(room)}% left`}</b>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
