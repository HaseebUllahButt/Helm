import { useCallback, useEffect, useState } from 'react';
import { Client, type Environment, type Session, type ModelList } from '../client';
import { Composer } from './Composer';
import { MAX_ATTACHMENTS, looksLikeImage, prepareImage } from './image';
import { PermissionSheet } from './PermissionSheet';
import { Controls, type Kind } from './Controls';
import { Transcript } from './Transcript';
import { useSessionLog } from './useSessionLog';
import type { Decision } from './types';

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', devin: 'Devin' };
const MARK: Record<string, string> = { claude: 'C', codex: 'X', opencode: 'O', devin: 'D' };
const shortPath = (p: string) => (p ?? '').replace(/^\/home\/[^/]+/, '~').split('/').slice(-2).join('/');

/**
 * A headless agent session: the transcript built from helm's own events,
 * the prompt sheet when the agent is waiting, and the model and permission
 * mode changeable from the header while it runs.
 */
export function DrivenSession({ client, env, session, onBack, onClosed, onArchived, onSession }: {
  client: Client; env: Environment; session: Session;
  onBack: () => void; onClosed: () => void; onArchived: () => void; onSession: (s: Session) => void;
}) {
  const { log, error: logError } = useSessionLog(client, env.id, session.id);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<{ name: string; mime: string; data: string; url: string }[]>([]);
  const [preparingImages, setPreparingImages] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<null | 'more'>(null);
  const [options, setOptions] = useState<ModelList | null>(null);
  const [commands, setCommands] = useState<{ name: string; description?: string; source?: string }[]>([]);
  const engine = ENGINE_LABEL[session.engine] ?? session.engine;
  const status = log.loaded ? log.status : session.status;
  const working = status === 'working';
  const pending = log.pending[0];

  useEffect(() => {
    client.rpc<ModelList>(env.id, 'model.list', { profileId: session.profileId, id: session.id }, 30_000)
      .then(setOptions).catch(() => setOptions({ default: null, models: [] }));
  }, [client, env.id, session.profileId]);

  // What `/` offers. Read from the machine because that is where the
  // commands are: files beside the project, or in that account's config.
  useEffect(() => {
    client.rpc<{ commands: typeof commands }>(env.id, 'session.commands', { id: session.id }, 20_000)
      .then((r) => setCommands(r.commands ?? [])).catch(() => setCommands([]));
  }, [client, env.id, session.id]);

  // The record changes without us asking: the CLI reports which model it
  // actually started with, and another device may change a setting. Take
  // those, or the chips describe a session that no longer exists.
  useEffect(() => client.on((e, kind, payload: any) => {
    if (e === env.id && kind === 'session.update' && payload?.session?.id === session.id) {
      onSession(payload.session);
    }
  }), [client, env.id, session.id, onSession]);

  const call = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  /**
   * Picked, pasted or dropped images, compressed in the browser.
   *
   * Every way this can refuse says so. It used to return silently when the
   * four slots were already full, so picking a photo did nothing at all and
   * nothing explained why - and files past the limit were dropped without a
   * word.
   */
  const onAttach = async (files: FileList) => {
    const chosen = Array.from(files);
    if (!chosen.length) return;
    const failures: string[] = [];
    const available = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (!available) {
      setError(`Image not added — ${MAX_ATTACHMENTS} images is the limit for one message.`);
      return;
    }
    const selected = chosen.slice(0, available);
    if (chosen.length > selected.length) {
      failures.push(`only ${selected.length} of ${chosen.length} fit — ${MAX_ATTACHMENTS} images is the limit`);
    }
    const next: typeof attachments = [];
    setPreparingImages((count) => count + 1);
    setError('');
    try {
      for (const f of selected) {
        if (!looksLikeImage(f)) {
          failures.push(`${f.name}: not an image`);
          continue;
        }
        try {
          next.push(await prepareImage(f));
        } catch (e: any) {
          failures.push(`${f.name}: ${e?.message || 'compression failed'}`);
        }
      }
      if (next.length) setAttachments((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS));
      if (failures.length) setError(`Image not added — ${failures.join('; ')}`);
    } finally {
      setPreparingImages((count) => Math.max(0, count - 1));
    }
  };
  const send = async () => {
    const body = draft.trim();
    if (preparingImages) return;
    if (!body && !attachments.length) return;
    const atts = attachments;
    setDraft(''); setAttachments([]);
    try { await client.rpc(env.id, 'session.input', { id: session.id, data: body, attachments: atts.map(a => ({ filename: a.name, mime: a.mime, data: a.data })) }, 70_000); }
    catch (e: any) { setError(e.message); setDraft(body); setAttachments(atts); }
  };

  const answer = (d: Decision) => pending && call(() => client.rpc(env.id, 'session.answer', { id: session.id, requestId: pending.requestId, decision: d }));
  const stop = () => call(() => client.rpc(env.id, 'session.interrupt', { id: session.id }));
  // model / thinking / permissions / speed all go the same way: tell the
  // daemon, take the session it hands back. Nothing restarts that the driver
  // cannot resume.
  const RPC: Record<Kind, string> = {
    model: 'session.model', effort: 'session.effort',
    mode: 'session.mode', speed: 'session.speed',
  };
  const pick = (kind: Kind, value: string) => call(async () => {
    const r: any = await client.rpc(env.id, RPC[kind], { id: session.id, [kind]: value });
    onSession(r.session);
  });
  const kill = async () => {
    setMenu(null);
    if (!confirm(`Delete "${session.title}"? The agent is closed and this conversation is removed from helm.`)) return;
    await call(async () => { await client.rpc(env.id, 'session.kill', { id: session.id }); onClosed(); });
  };

  const archive = async () => {
    setMenu(null);
    await call(async () => { await client.rpc(env.id, 'session.archive', { id: session.id, archived: !session.archived }); onArchived(); });
  };

  const all = options?.modes ?? [];
  const mode = all.find((m) => m.id === session.mode);

  // shift+tab, the way Claude Code does it at the keyboard. Only the safe
  // modes are on the ring: handing over the whole machine is a deliberate
  // act, not something you land on while tabbing.
  const cycle = useCallback(() => {
    const ring = all.filter((m) => !m.danger);
    if (ring.length < 2) return;
    const at = ring.findIndex((m) => m.id === session.mode);
    pick('mode', ring[(at + 1) % ring.length].id);
  }, [all, session.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      cycle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle]);
  const chip = (s: string) => (s === 'blocked' ? <span className="chip blocked"><i />waiting</span>
    : s === 'working' ? <span className="chip working"><i />working</span> : null);

  const controls = Controls({ options, session, busy, onPick: pick });

  // The clip is only offered when the running model can see images;
  // the daemon enforces the same rule, so this is presentation, not trust.
  const modelNow = session.model || session.engineModel || options?.default || '';
  // Last resort only: `model.list` reports the running driver's own answer
  // once there is one, and the catalogue's before that. This is what is left
  // when neither has said anything yet - a brand-new session whose agent has
  // not started. Every engine helm drives takes images, and a wrong "yes"
  // now ends in a message saying the agent cannot see them, while a wrong
  // "no" means no clip at all on the first message, which is exactly when
  // you want to send a screenshot.
  const canAttach = options?.imagesByModel?.[modelNow] ?? options?.images ?? true;

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub">
            <span className={`mark ${session.engine}`}>{MARK[session.engine] ?? '·'}</span>
            {engine} · {shortPath(session.cwd)}
            {!env.online && <span className="offline"> · offline</span>}
          </span>
        </div>
        {chip(status)}
        <button className="iconbtn" title="more" onClick={() => setMenu(menu === 'more' ? null : 'more')}>⋯</button>
        {menu === 'more' && (
          <div className="menu" onClick={() => setMenu(null)}>
            <button onClick={archive}>{session.archived ? 'Unarchive thread' : 'Archive thread'}</button>
            <button className="destructive" onClick={kill}>Delete thread</button>
          </div>
        )}
      </div>

      <Transcript
        turns={log.turns} status={status} loaded={log.loaded}
        empty={session.alive === false ? 'This conversation resumes with your next message.' : undefined}
      />

      <Composer
        draft={draft} setDraft={setDraft} onSend={send} onStop={stop} working={working}
        engine={engine} keys={false} waiting={!!pending} danger={mode?.danger}
        foot={controls.chips} canAttach={canAttach} preparing={preparingImages > 0}
        onAttach={onAttach} attachments={attachments} onRemoveAttachment={(i) => setAttachments(a => a.filter((_, j) => j !== i))}
        onAttachUnsupported={() => setError(`${engine} cannot be sent images in this session.`)}
        commands={commands}
      >
        {controls.sheet}
        {pending && <PermissionSheet key={pending.requestId} permission={pending} onAnswer={answer} busy={busy} />}
        {log.pending.length > 1 && <div className="note more-pending">{log.pending.length - 1} more waiting</div>}
      </Composer>
      {(error || logError) && <div className="error floating">{error || logError}</div>}
    </>
  );
}
