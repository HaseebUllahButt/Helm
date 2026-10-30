import { useEffect, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import { Sheet } from '../Modal';
import { errorMessage } from '../errors';

type Move = { moveId: string; phase: 'copying-project' | 'copying-chat' | 'opening' | 'done' | 'failed';
  error: string | null; progress: { bytes: number; total: number | null } | null;
  targetName: string; folder: string | null; sessionId: string | null };
type Account = { id: string; label?: string; engine: string; available: boolean };

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (v) => v.toString(16).padStart(2, '0')).join('');

/** Only Claude and Codex keep a conversation file Helm can carry; terminals and helpers stay. */
export const canMove = (env: Environment, s: Session) => env.online && ['claude', 'codex'].includes(s.engine)
  && !!s.engineSessionId && !s.brain && !s.delegation?.parentId && !s.movedAway && !s.moving
  && !s.nativeCli && !s.nativeChat && !(s.external && s.externalActive)
  && !s.id.startsWith('found:') && !s.id.startsWith('pane:');

/** Open a chat on another machine from its id alone. */
export async function openMoved(client: Client, machineId: string, sessionId: string, open: (machineId: string, s: Session) => void) {
  const reply = await client.rpc<{ session: Session }>(machineId, 'session.events', { id: sessionId, tail: 1 });
  open(machineId, reply.session);
}

function stepText(move: Move) {
  const { progress } = move;
  const percent = progress?.total ? ` ${Math.min(100, Math.round(progress.bytes / progress.total * 100))}%` : '';
  if (move.phase === 'copying-project') return `Copying the project folder…${percent}`;
  if (move.phase === 'copying-chat') return `Copying the conversation…${percent}`;
  if (move.phase === 'opening') return `Opening the chat on ${move.targetName}…`;
  return '';
}

/**
 * Move a chat to another machine with its whole conversation. The agent
 * there continues with everything it knew; this copy closes. The machine
 * does the work: closing this window does not stop the move.
 */
export function MoveChat({ client, source, machines, session, onClose, onOpen }: {
  client: Client; source: Environment; machines: Environment[]; session: Session;
  onClose: () => void; onOpen: (machineId: string, s: Session) => void;
}) {
  const targets = machines.filter((m) => m.id !== source.id && m.online);
  const [targetId, setTargetId] = useState(targets.length === 1 ? targets[0].id : '');
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [profileId, setProfileId] = useState('');
  const [folder, setFolder] = useState('');
  const [moveId] = useState(newId);
  const [move, setMove] = useState<Move | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const target = machines.find((m) => m.id === targetId);
  const agent = session.engine === 'codex' ? 'Codex' : 'Claude';

  useEffect(() => {
    if (!targetId) return;
    let live = true;
    setAccounts(null); setProfileId('');
    client.rpc<{ agents: Account[] }>(targetId, 'agent.list', { models: false }, 60_000)
      .then(({ agents }) => {
        if (!live) return;
        const usable = agents.filter((a) => a.engine === session.engine && a.available);
        setAccounts(usable);
        setProfileId((usable.find((a) => a.id === session.profileId) ?? usable[0])?.id ?? '');
      })
      .catch((e) => { if (live) { setAccounts([]); setError(errorMessage(e, { machine: target?.name })); } });
    return () => { live = false; };
  }, [client, targetId, session.engine, session.profileId]);

  // The machine reports each step; ask until the move ends.
  const running = !!move && !['done', 'failed'].includes(move.phase);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      client.rpc<Move>(source.id, 'chat.move-status', { moveId }, 20_000).then(setMove).catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [client, source.id, moveId, running]);

  const start = async (retry = false) => {
    setBusy(true); setError('');
    try {
      setMove(await client.rpc<Move>(source.id, 'chat.move', { moveId, sessionId: session.id, targetMachineId: targetId,
        profileId, targetFolder: folder.trim() || undefined, retry }, 120_000));
    } catch (e) { setError(errorMessage(e, { machine: source.name })); }
    finally { setBusy(false); }
  };

  const locked = busy || !!move;
  return (
    <Sheet onClose={onClose} label="Move chat">
      <div className="modal-title">Move chat to another machine</div>
      {move?.phase === 'done' ? <>
        <div className="modal-body">The chat is on {move.targetName} now{move.folder ? `, in ${move.folder}` : ''}. Your next message continues it there. This copy is archived.</div>
        {error && <div className="banner error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Close</button>
          {move.sessionId && <button className="primary" disabled={busy} onClick={() => {
            setBusy(true);
            openMoved(client, targetId, move.sessionId!, (id, s) => { onClose(); onOpen(id, s); })
              .catch((e) => setError(errorMessage(e, { machine: move.targetName }))).finally(() => setBusy(false));
          }}>Open chat on {move.targetName}</button>}
        </div>
      </> : <>
        <div className="modal-body">
          Helm copies the project folder and the full conversation. The {agent} agent there continues with everything it knew.
          {' '}Keep {source.name} on until the move ends.
        </div>
        <div className="field"><label className="field-label">Machine
          <select className="custom" value={targetId} disabled={locked} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">{targets.length ? 'Choose a machine' : 'No other machine is online'}</option>
            {targets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label></div>
        {targetId && <div className="field"><label className="field-label">{agent} account there
          <select className="custom" value={profileId} disabled={locked || !accounts?.length} onChange={(e) => setProfileId(e.target.value)}>
            {!accounts?.length && <option value="">{accounts ? `No signed-in ${agent} account on ${target?.name}` : 'Loading accounts…'}</option>}
            {accounts?.map((a) => <option key={a.id} value={a.id}>{a.label || a.id}</option>)}
          </select>
        </label></div>}
        {targetId && <div className="field"><label className="field-label">Folder there
          <input className="modal-input" value={folder} disabled={locked} placeholder={`Same place as on ${source.name}`}
            onChange={(e) => setFolder(e.target.value)} />
        </label></div>}
        {running && <div className="banner" role="status">{stepText(move!)}</div>}
        {(error || move?.error) && <div className="banner error" role="alert">{error || move?.error}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>{running ? 'Hide' : 'Cancel'}</button>
          {move?.phase === 'failed'
            ? <button className="primary" disabled={busy} onClick={() => void start(true)}>Try again</button>
            : <button className="primary" disabled={locked || !targetId || !profileId || ['working', 'blocked', 'starting'].includes(session.status)}
                onClick={() => void start()}>{running ? 'Moving…' : 'Move chat'}</button>}
        </div>
        {['working', 'blocked', 'starting'].includes(session.status) && !move && <p className="note">Wait for the reply to finish, then move the chat.</p>}
      </>}
    </Sheet>
  );
}

/** In the old copy of a moved chat: where it went, and a way there. */
export function MovedNotice({ client, session, onOpenSession }: {
  client: Client; session: Session; onOpenSession?: (machineId: string, s: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const to = session.movedAway;
  if (!to && !session.moving) return null;
  return <div className="thread-recovery" role="status"><div>
    <strong>{to ? `Moved to ${to.machineName}` : `Moving to ${session.moving!.machineName}`}</strong>
    <p>{error || (to ? 'The chat continues there. This copy takes no new messages.' : 'Helm is copying this chat. Wait until the move ends.')}</p>
  </div>
    {to && onOpenSession && <button disabled={busy} onClick={() => {
      setBusy(true); setError('');
      openMoved(client, to.machineId, to.sessionId, onOpenSession)
        .catch((e) => setError(errorMessage(e, { machine: to.machineName }))).finally(() => setBusy(false));
    }}>Open it there</button>}
  </div>;
}
