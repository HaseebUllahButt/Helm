import { useEffect, useState } from 'react';
import { Client, type Environment, type Session } from '../client';
import { Icon } from '../Icon';

interface Schedule {
  id: string; sessionId: string; name: string; prompt: string; intervalMinutes: number; enabled: boolean;
  nextRunAt: number; lastRunAt?: number; lastError?: string;
}

const EVERY = [15, 30, 60, 180, 360, 720, 1440, 10080];

/** "every 15 minutes", "every hour", "every 3 hours", "every day". */
export const every = (minutes: number) =>
  minutes === 10080 ? 'every week'
    : minutes % 1440 === 0 ? (minutes === 1440 ? 'every day' : `every ${minutes / 1440} days`)
    : minutes % 60 === 0 ? (minutes === 60 ? 'every hour' : `every ${minutes / 60} hours`)
    : `every ${minutes} minutes`;

const clock = (ts: number) => {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
};

/**
 * A message this thread is sent on a timer - "check the build" every hour.
 * It lands in the conversation as if typed, and the answer is read there.
 */
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
      if (result.skipped) setNotice(result.reason || 'It will send once this thread is free.');
      else if (method === 'schedule.run') setNotice('Sent. The reply shows up in the chat.');
      await load();
      return true;
    } catch (failure: any) { setError(failure.message); return false; }
    finally { setBusy(false); }
  };
  const edit = (record?: Schedule) => {
    setEditing(record ?? null); setCreating(true); setName(record?.name && record.name !== 'Scheduled task' ? record.name : ''); setPrompt(record?.prompt ?? ''); setIntervalMinutes(record?.intervalMinutes ?? 60);
  };
  const choices = EVERY.includes(interval) ? EVERY : [...EVERY, interval].sort((a, b) => a - b);
  const blocked = !env.online || !!session.delegation || session.external;
  return <section className="thread-schedules" aria-label="Repeat">
    <p className="schedules-intro">Send this chat the same message on a timer, like <i>“check the build”</i> every hour. Replies show up in the chat. If the chat is busy, it waits its turn.</p>
    {records.map((record) => { const named = record.name && record.name !== 'Scheduled task' ? record.name : ''; return <article className={`schedule-card${record.enabled ? '' : ' paused'}`} key={record.id}>
      <div className="schedule-top">
        <span className="schedule-icon"><Icon name="clock" size={16} /></span>
        <span className="grow">
          <strong>{named || record.prompt.split('\n')[0]}</strong>
          <small>{record.enabled ? `${every(record.intervalMinutes)} · next ${clock(record.nextRunAt)}` : `Paused · ${every(record.intervalMinutes)}`}</small>
        </span>
        <button className={`switch${record.enabled ? ' on' : ''}`} role="switch" aria-checked={record.enabled} aria-label={record.enabled ? 'Pause' : 'Resume'}
          disabled={busy || !env.online} onClick={() => void act('schedule.save', { id: record.id, enabled: !record.enabled })}><i /></button>
      </div>
      {named && <p>{record.prompt}</p>}
      {record.lastError && <p className="error">{record.lastError}</p>}
      <div className="schedule-actions">
        {record.lastRunAt && <small className="grow">Last sent {clock(record.lastRunAt)}</small>}
        <button disabled={busy || !env.online} onClick={() => void act('schedule.run', { id: record.id })}>Send now</button>
        <button disabled={busy} onClick={() => edit(record)}>Edit</button>
        <button disabled={busy || !env.online} className="destructive" onClick={() => void act('schedule.delete', { id: record.id })}>Delete</button>
      </div>
    </article>; })}
    {creating ? <form className="schedule-form" onSubmit={async (event) => {
      event.preventDefault();
      if (await act('schedule.save', { id: editing?.id, sessionId: session.id, name, prompt, intervalMinutes: interval })) setCreating(false);
    }}>
      <label>Message<textarea required rows={3} value={prompt} maxLength={32000} autoFocus onChange={(event) => setPrompt(event.target.value)} placeholder="Check the build and tell me if anything broke." /></label>
      <div className="schedule-row">
        <label>How often<select value={interval} onChange={(event) => setIntervalMinutes(Number(event.target.value))}>
          {choices.map((minutes) => <option key={minutes} value={minutes}>{every(minutes).replace(/^every /, 'Every ')}</option>)}
        </select></label>
        <label><span>Name <span className="optional">· optional</span></span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="Build check" /></label>
      </div>
      <div className="schedule-actions"><span className="grow" /><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={busy || !env.online}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form> : <button className="schedule-new" disabled={blocked} onClick={() => edit()}><Icon name="plus" size={16} />New repeat</button>}
    {!env.online && <p className="note">The machine is offline, so nothing is sent until it is back.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="schedule-notice" role="status">{notice}</p>}
  </section>;
}
