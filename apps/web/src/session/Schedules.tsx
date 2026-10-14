import { useEffect, useState } from 'react';
import { Client, type Environment, type Session } from '../client';

interface Schedule {
  id: string; sessionId: string; name: string; prompt: string; intervalMinutes: number; enabled: boolean;
  type: 'interval' | 'fixed_time' | 'webhook'; timeOfDay?: string; timeZone?: string; weekdays?: number[]; freshThread?: boolean;
  nextRunAt: number | null; lastRunAt?: number; lastError?: string; lastSessionId?: string;
  webhook?: { url: string | null; path: string; hasSecret: boolean; error?: string | null };
  deliveries?: { id: string; at: number; status: string; sessionId?: string }[];
}

export function Schedules({ client, env, session, onOpen }: { client: Client; env: Environment; session: Session; onOpen?: (s: Session) => void }) {
  const [records, setRecords] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null), [creating, setCreating] = useState(false);
  const [name, setName] = useState(''), [prompt, setPrompt] = useState(''), [interval, setIntervalMinutes] = useState(60);
  const [type, setType] = useState<Schedule['type']>('interval'), [timeOfDay, setTimeOfDay] = useState('09:00');
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone), [weekdays, setWeekdays] = useState<number[]>([]);
  const [freshThread, setFreshThread] = useState(false), [hmacSecret, setHmacSecret] = useState(''), [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const load = async () => {
    const result = await client.rpc<{ schedules: Schedule[]; error?: string }>(env.id, 'schedule.list', { sessionId: session.id });
    setRecords(result.schedules ?? []); if (result.error) setError(result.error);
  };
  useEffect(() => {
    let stale = false;
    const refresh = () => client.rpc<{ schedules: Schedule[]; error?: string }>(env.id, 'schedule.list', { sessionId: session.id })
      .then(result => { if (!stale) { setRecords(result.schedules ?? []); if (result.error) setError(result.error); } }).catch(failure => { if (!stale) setError(failure.message); });
    void refresh(); const timer = setInterval(() => { if (env.online && !document.hidden) void refresh(); }, 15000);
    return () => { stale = true; clearInterval(timer); };
  }, [client, env.id, env.online, session.id]);
  const act = async (method: string, params: object) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.rpc<{ skipped?: boolean; reason?: string; sessionId?: string }>(env.id, method, params, 90000);
      if (result.skipped) setNotice(result.reason || 'Waiting for this thread to become idle.');
      else if (method === 'schedule.run') setNotice('Task sent. Its result appears in the execution thread.');
      await load(); return true;
    } catch (failure: any) { setError(failure.message); return false; }
    finally { setBusy(false); }
  };
  const openResult = async (id: string) => {
    try { const result = await client.rpc<{ sessions: Session[] }>(env.id, 'session.list', {}); const found = result.sessions.find(s => s.id === id); if (!found) throw new Error('This result thread is no longer available.'); onOpen?.(found); }
    catch (e: any) { setError(e.message); }
  };
  const edit = (record?: Schedule) => {
    setEditing(record ?? null); setCreating(true); setName(record?.name ?? ''); setPrompt(record?.prompt ?? ''); setIntervalMinutes(record?.intervalMinutes ?? 60);
    setType(record?.type || 'interval'); setTimeOfDay(record?.timeOfDay || '09:00'); setTimeZone(record?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    setWeekdays(record?.weekdays || []); setFreshThread(!!record?.freshThread); setHmacSecret(''); setClearSecret(false);
  };
  return <section className="thread-schedules" aria-label="Automations">
    <h3>Automations</h3>
    <p className="note">Runs on {env.name} with this thread’s account, model and permissions. The machine must be online. Busy threads and pending approvals wait; missed intervals do not pile up. Fixed times missed by more than ten minutes move to the next occurrence.</p>
    <label className="automation-option"><input type="checkbox" checked={!!session.autoResumeLimited} disabled={busy || !env.online || session.external}
      onChange={event => void act('session.auto-resume', { id: session.id, on: event.target.checked })} /> Continue automatically when this account’s usage limit resets</label>
    <p className="note">Requires a reset timestamp reported by the provider. Stop, archive or switching this off cancels the pending continuation.</p>
    {records.map(record => <article className="schedule-card" key={record.id}>
      <div><strong>{record.name}</strong><span>{record.enabled ? 'Active' : 'Paused'}</span></div>
      <p>{record.prompt}</p>
      <small>{record.type === 'webhook' ? 'On webhook' : record.type === 'fixed_time' ? `${record.timeOfDay} · ${record.timeZone}${record.weekdays?.length ? ` · ${record.weekdays.map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}` : ' · Daily'}` : `Every ${record.intervalMinutes} minutes`} · {record.freshThread ? 'Fresh thread each run' : 'This thread'}</small>
      {record.enabled && record.nextRunAt && <small>Next: {new Date(record.nextRunAt).toLocaleString()}</small>}
      {record.lastRunAt && <small>Last sent: {new Date(record.lastRunAt).toLocaleString()}{record.freshThread && ` · Result thread ${record.lastSessionId}`}</small>}
      {record.freshThread && record.lastSessionId && onOpen && <button disabled={!env.online || busy} onClick={() => void openResult(record.lastSessionId!)}>Open latest result</button>}
      {record.webhook && <div className="webhook-endpoint"><label>Secret webhook URL<input readOnly value={record.webhook.url || record.webhook.path} onFocus={event => event.target.select()} /></label>
        {record.webhook.error && <p className="error">Webhook listener unavailable: {record.webhook.error}</p>}
        {!record.webhook.url && <p className="note">A public Helm hostname is required to reach this endpoint from another service.</p>}
        <p className="note">POST · 16 KiB maximum · {record.webhook.hasSecret ? 'HMAC SHA-256 signature required in X-Hub-Signature-256' : 'Anyone with this URL can trigger this task'}.</p>
        <button disabled={busy || !env.online} onClick={() => void act('schedule.save', { id: record.id, rotateToken: true })}>Rotate URL and cancel queued deliveries</button>
        <details><summary>Recent deliveries ({record.deliveries?.length || 0})</summary>{record.deliveries?.slice().reverse().map(d => <p key={d.id}>{new Date(d.at).toLocaleString()} · {d.status}{d.sessionId ? ` · Thread ${d.sessionId}` : ''}</p>)}</details>
      </div>}
      {record.lastError && <p className="error">{record.lastError}</p>}
      <div className="team-actions">
        {record.type !== 'webhook' && <button disabled={busy || !env.online} onClick={() => void act('schedule.run', { id: record.id })}>Run now</button>}
        <button disabled={busy || !env.online} onClick={() => void act('schedule.save', { id: record.id, enabled: !record.enabled })}>{record.enabled ? 'Pause' : 'Resume'}</button>
        <button disabled={busy} onClick={() => edit(record)}>Edit</button>
        <button disabled={busy || !env.online} className="destructive" onClick={() => void act('schedule.delete', { id: record.id })}>Delete</button>
      </div>
    </article>)}
    {!records.length && !creating && <p>No automations for this thread.</p>}
    {creating ? <form className="schedule-form" onSubmit={async event => {
      event.preventDefault();
      if (await act('schedule.save', { id: editing?.id, sessionId: session.id, name, prompt, type, intervalMinutes: interval,
        timeOfDay, timeZone, weekdays, freshThread, ...(type === 'webhook' && (hmacSecret || clearSecret) ? { hmacSecret: clearSecret ? '' : hmacSecret } : {}) })) setCreating(false);
    }}>
      <label>Name<input value={name} onChange={event => setName(event.target.value)} maxLength={100} placeholder="Daily review" /></label>
      <label>Trigger<select value={type} onChange={event => setType(event.target.value as Schedule['type'])}><option value="interval">Interval</option><option value="fixed_time">Fixed time</option><option value="webhook">Webhook</option></select></label>
      <label>Task<textarea required rows={4} value={prompt} maxLength={32000} onChange={event => setPrompt(event.target.value)} placeholder="Describe the task…" /></label>
      {type === 'interval' && <label>Every (minutes)<input type="number" min={5} max={525600} required value={interval} onChange={event => setIntervalMinutes(Number(event.target.value))} /></label>}
      {type === 'fixed_time' && <><label>Time<input type="time" required value={timeOfDay} onChange={event => setTimeOfDay(event.target.value)} /></label>
        <label>Time zone<input required value={timeZone} onChange={event => setTimeZone(event.target.value)} placeholder="America/New_York" /></label>
        <fieldset><legend>Days (none selected means daily)</legend>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, d) => <label className="automation-option" key={day}><input type="checkbox" checked={weekdays.includes(d)} onChange={event => setWeekdays(ds => event.target.checked ? [...ds, d] : ds.filter(v => v !== d))} />{day}</label>)}</fieldset></>}
      {type === 'webhook' && <><p className="note">Use {'{{body}}'}, {'{{body.field}}'}, {'{{query.field}}'} or {'{{headers.name}}'} in the task. Credential headers and query values are excluded. Treat payloads as untrusted data.</p>
        <label>Optional HMAC secret<input type="password" autoComplete="new-password" minLength={16} maxLength={256} value={hmacSecret} onChange={event => { setHmacSecret(event.target.value); setClearSecret(false); }} placeholder={editing?.webhook?.hasSecret ? 'Leave blank to keep the existing secret' : 'At least 16 characters'} /></label>
        {editing?.webhook?.hasSecret && <label className="automation-option"><input type="checkbox" checked={clearSecret} onChange={event => setClearSecret(event.target.checked)} /> Remove signature requirement</label>}</>}
      <label className="automation-option"><input type="checkbox" checked={freshThread} onChange={event => setFreshThread(event.target.checked)} /> Start a fresh thread for each run</label>
      <div className="team-actions"><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="primary" disabled={busy || !env.online}>{busy ? 'Saving…' : 'Save automation'}</button></div>
    </form> : <button className="primary" disabled={!env.online || !!session.delegation || session.external} onClick={() => edit()}>New automation</button>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
