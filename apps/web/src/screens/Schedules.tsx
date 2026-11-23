import { useEffect, useState } from 'react';
import { Client, type Environment } from '../client';
import { errorMessage } from '../errors';
import { BackIcon } from '../Icon';

interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  event?: { label?: string };
  intervalMinutes?: number;
  timeOfDay?: string;
  timeZone?: string;
  lastRunAt?: number;
  lastResult?: { state: 'running' | 'succeeded' | 'failed'; message?: string };
  lastError?: string;
  checkError?: string;
  pausedAfterFailures?: boolean;
}
interface MachineSchedules { schedules: Schedule[]; error?: string }
const resultLabel = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed' };

function startsOn(task: Schedule) {
  if (task.event) return task.event.label ?? 'Event';
  if (task.type === 'webhook') return 'Webhook POST';
  if (task.type === 'fixed_time') return `${task.timeOfDay} · ${task.timeZone}`;
  return `Every ${task.intervalMinutes} min`;
}

export function SchedulesView({ client, envs, onBack }: { client: Client; envs: Environment[]; onBack: () => void }) {
  const [byMachine, setByMachine] = useState<Record<string, MachineSchedules>>({});
  const machineKey = envs.map(env => `${env.id}:${env.online}`).join(',');
  useEffect(() => {
    let closed = false;
    let next: ReturnType<typeof setTimeout>;
    async function load() {
      await Promise.all(envs.filter(env => env.online).map(async env => {
        try {
          const data: MachineSchedules = await client.rpc(env.id, 'schedule.list', { includeLinks: false });
          if (!closed) setByMachine(all => ({ ...all, [env.id]: data }));
        } catch (error) {
          if (!closed) setByMachine(all => ({ ...all, [env.id]: {
            schedules: all[env.id]?.schedules ?? [], error: errorMessage(error, { machine: env.name }),
          } }));
        }
      }));
      if (!closed) next = setTimeout(load, 5000);
    }
    void load();
    return () => { closed = true; clearTimeout(next); };
  }, [client, machineKey]); // A new roster object alone does not change the machines to ask.

  return <>
    <div className="bar">
      <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
      <div className="titles"><h1>Schedules</h1></div>
    </div>
    <div className="scroll"><div className="pad column">
      {!envs.length && <div className="empty quiet">No machines available.</div>}
      {envs.map(env => {
        const data = byMachine[env.id];
        return <section key={env.id}>
          <div className="section">{env.name}</div>
          {!env.online && <div className="empty quiet">Machine offline.</div>}
          {env.online && !data && <div className="empty quiet">Loading schedules…</div>}
          {env.online && data?.error && <p className="note">{data.error}</p>}
          {env.online && data && !data.error && !data.schedules.length && <div className="empty quiet">No scheduled tasks.</div>}
          {!!data?.schedules.length && <div className="rows">{data.schedules.map(task => {
            const start = task.type === 'event' ? 'Last fire' : 'Last run';
            const date = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : 'Never';
            const result = task.lastResult;
            return <div className="row" key={task.id}>
              <div className="grow" style={{ overflowWrap: 'anywhere' }}>
                <div className="rt">{task.name}</div>
                <div className="rm">{startsOn(task)}{!task.enabled && ' · Paused'}</div>
                <div className="rm">{start} · {date}{result && ` · ${resultLabel[result.state]}`}</div>
                {result?.message && <div className="rm">{result.message}</div>}
                {task.pausedAfterFailures && <div className="rm">Helm paused this trigger after three failures.</div>}
                {(task.checkError || task.lastError) && <div className="rm">{task.checkError || task.lastError}</div>}
              </div>
            </div>;
          })}</div>}
        </section>;
      })}
    </div></div>
  </>;
}
