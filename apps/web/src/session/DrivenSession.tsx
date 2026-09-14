import { useEffect, useState } from 'react';
import { Client, type Environment, type Session, type ModelList } from '../client';
import { Composer } from './Composer';
import { PermissionSheet } from './PermissionSheet';
import { Transcript } from './Transcript';
import { useSessionLog } from './useSessionLog';
import type { Decision } from './types';

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode' };

/**
 * A headless agent session: the transcript built from helm's own events,
 * the prompt sheet when the agent is waiting, and the model and permission
 * mode changeable from the header while it runs.
 */
export function DrivenSession({ client, env, session, onBack, onClosed, onSession }: {
  client: Client; env: Environment; session: Session;
  onBack: () => void; onClosed: () => void; onSession: (s: Session) => void;
}) {
  const { log, error: logError } = useSessionLog(client, env.id, session.id);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<null | 'more' | 'model' | 'mode'>(null);
  const [options, setOptions] = useState<ModelList | null>(null);
  const engine = ENGINE_LABEL[session.engine] ?? session.engine;
  const status = log.loaded ? log.status : session.status;
  const working = status === 'working';
  const pending = log.pending[0];

  useEffect(() => {
    client.rpc<ModelList>(env.id, 'model.list', { profileId: session.profileId }, 30_000)
      .then(setOptions).catch(() => setOptions({ default: null, models: [] }));
  }, [client, env.id, session.profileId]);

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    try { await client.rpc(env.id, 'session.input', { id: session.id, data: body }, 70_000); }
    catch (e: any) { setError(e.message); setDraft(body); }
  };

  const answer = (d: Decision) => pending && call(() => client.rpc(env.id, 'session.answer', { id: session.id, requestId: pending.requestId, decision: d }));
  const stop = () => call(() => client.rpc(env.id, 'session.interrupt', { id: session.id }));
  const setMode = (mode: string) => { setMenu(null); call(async () => { const r: any = await client.rpc(env.id, 'session.mode', { id: session.id, mode }); onSession(r.session); }); };
  const setModel = (model: string) => { setMenu(null); call(async () => { const r: any = await client.rpc(env.id, 'session.model', { id: session.id, model }); onSession(r.session); }); };
  const kill = async () => {
    setMenu(null);
    if (!confirm(`End "${session.title}"? The agent is closed and this conversation is removed from helm.`)) return;
    await call(async () => { await client.rpc(env.id, 'session.kill', { id: session.id }); onClosed(); });
  };

  const mode = options?.modes?.find((m) => m.id === session.mode);
  const chip = (s: string) => (s === 'blocked' ? <span className="chip blocked"><i />waiting</span>
    : s === 'working' ? <span className="chip working"><i />working</span> : null);

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub pickers">
            <span>{engine}</span>
            <button className="pick" onClick={() => setMenu(menu === 'model' ? null : 'model')}>{session.model || options?.default || 'default model'}</button>
            <button className="pick" onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>{mode?.label ?? session.mode ?? 'mode'}</button>
            {!env.online && <span className="offline">· offline</span>}
          </span>
        </div>
        {chip(status)}
        <button className="iconbtn" title="more" onClick={() => setMenu(menu === 'more' ? null : 'more')}>⋯</button>
        {menu === 'more' && (
          <div className="menu" onClick={() => setMenu(null)}>
            <button onClick={kill}>End session</button>
          </div>
        )}
        {menu === 'model' && options && (
          <div className="menu wide">
            <div className="menu-title">model</div>
            <button className={!session.model ? 'on' : ''} onClick={() => setModel('')}>default{options.default ? ` (${options.default})` : ''}</button>
            {options.models.filter((m) => m !== options.default).map((m) => (
              <button key={m} className={session.model === m ? 'on' : ''} onClick={() => setModel(m)}>{m}</button>
            ))}
          </div>
        )}
        {menu === 'mode' && options?.modes && (
          <div className="menu wide">
            <div className="menu-title">permissions</div>
            {options.modes.map((m) => (
              <button key={m.id} className={session.mode === m.id ? 'on' : ''} onClick={() => (m.danger && !confirm(`${m.label}: ${m.hint}. Sure?`)) || setMode(m.id)}>
                <span className="rt">{m.label}</span>{m.hint && <span className="rm">{m.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <Transcript
        turns={log.turns} status={status} loaded={log.loaded}
        empty={session.alive === false ? 'This conversation resumes with your next message.' : undefined}
      />

      <Composer draft={draft} setDraft={setDraft} onSend={send} onStop={stop} working={working} engine={engine} keys={false} waiting={!!pending}>
        {pending && <PermissionSheet key={pending.requestId} permission={pending} onAnswer={answer} busy={busy} />}
        {log.pending.length > 1 && <div className="note more-pending">{log.pending.length - 1} more waiting</div>}
      </Composer>
      {(error || logError) && <div className="error floating">{error || logError}</div>}
    </>
  );
}
