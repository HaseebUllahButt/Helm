import { useEffect, useState } from 'react';
import { Client, type Environment, type Session } from '../client';

interface Schedule {
  id: string; sessionId: string; name: string; prompt: string; intervalMinutes: number; enabled: boolean;
  nextRunAt: number; lastRunAt?: number; lastError?: string;
}

export function Schedules({ client, env, session }: { client: Client; env: Environment; session: Session }) {
  const [records, setRecords] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [interval, setIntervalMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = async () => {
    const result = await client.rpc<{ schedules: Schedule[] }>(env.id, 'schedule.list', { sessionId: session.id });
    setRecords(result.schedules ?? []);
  };
  useEffect(() => {
    let stale = false;
    client.rpc<{ schedules: Schedule[] }>(env.id, 'schedule.list', { sessionId: session.id })
      .then((result) => { if (!stale) setRecords(result.schedules ?? []); })
      .catch((failure) => { if (!stale) setError(failure.message); });
    return () => { stale = true; };
  }, [client, env.id, session.id]);
  const act = async (method: string, params: object) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.rpc<{ skipped?: boolean; reason?: string }>(env.id, method, params);
      if (result.skipped) setNotice(result.reason || 'Waiting for this thread to become idle.');
      else if (method === 'schedule.run') setNotice('Task sent. Its result appears in this conversation.');
      await load();
      return true;
    } catch (failure: any) { setError(failure.message); return false; }
    finally { setBusy(false); }
  };
  const edit = (record?: Schedule) => {
    setEditing(record ?? null); setCreating(true); setName(record?.name ?? ''); setPrompt(record?.prompt ?? ''); setIntervalMinutes(record?.intervalMinutes ?? 60);
  };
  return <section className="thread-schedules" aria-label="Scheduled tasks">
    <h3>Scheduled tasks</h3>
    <p className="note">Runs on {env.name} in this thread, using its current model and permissions. The machine must be online. Busy or stopped threads wait; missed runs do not pile up.</p>
    {records.map((record) => <article className="schedule-card" key={record.id}>
      <div><strong>{record.name}</strong><span>{record.enabled ? 'Active' : 'Paused'}</span></div>
      <p>{record.prompt}</p>
      <small>Every {record.intervalMinutes} minutes · {record.enabled ? `Next: ${new Date(record.nextRunAt).toLocaleString()}` : 'Not scheduled'}</small>
      {record.lastRunAt && <small>Last sent: {new Date(record.lastRunAt).toLocaleString()} · Result in this thread</small>}
      {record.lastError && <p className="error">{record.lastError}</p>}
      <div className="team-actions">
        <button disabled={busy || !env.online} onClick={() => void act('schedule.run', { id: record.id })}>Run now</button>
        <button disabled={busy || !env.online} onClick={() => void act('schedule.save', { id: record.id, enabled: !record.enabled })}>{record.enabled ? 'Pause' : 'Resume'}</button>
        <button disabled={busy} onClick={() => edit(record)}>Edit</button>
        <button disabled={busy || !env.online} className="destructive" onClick={() => void act('schedule.delete', { id: record.id })}>Delete</button>
      </div>
    </article>)}
    {!records.length && !creating && <p>No scheduled tasks for this thread.</p>}
    {creating ? <form className="schedule-form" onSubmit={async (event) => {
      event.preventDefault();
      if (await act('schedule.save', { id: editing?.id, sessionId: session.id, name, prompt, intervalMinutes: interval })) setCreating(false);
    }}>
      <label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Daily review" /></label>
      <label>Task<textarea required rows={4} value={prompt} maxLength={32000} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the recurring task…" /></label>
      <label>Every (minutes)<input type="number" min={5} max={525600} required value={interval} onChange={(event) => setIntervalMinutes(Number(event.target.value))} /></label>
      <div className="team-actions"><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={busy || !env.online}>{busy ? 'Saving…' : 'Save schedule'}</button></div>
    </form> : <button className="primary" disabled={!env.online || !!session.delegation || session.external} onClick={() => edit()}>New scheduled task</button>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
