import { useDismiss } from '../useDismiss';
import { useCallback, useEffect, useState } from 'react';
import { Client, type Environment, type Session, type ModelList } from '../client';
import { useNow, waitingSince } from '../useNow';
import { Composer } from './Composer';
import { MAX_ATTACHMENTS, looksLikeImage, prepareImage } from './image';
import { EngineMark } from '../EngineMark';
import { PermissionSheet } from './PermissionSheet';
import { Controls, type Kind } from './Controls';
import { Transcript, splitNote } from './Transcript';
import { Confirm, TextPrompt } from '../Modal';
import { loadDraft, saveDraft } from '../draftStore';
import { recacheCost, recacheWarning } from '@helm/usage/recache';
import { money } from '../format';
import { loadModels, saveModels } from '../modelCache';
import { useSessionLog } from './useSessionLog';
import type { Decision, Turn } from './types';

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', opencode2: 'OpenCode 2', devin: 'Devin' };
const shortPath = (p: string) => (p ?? '').replace(/^\/home\/[^/]+/, '~').split('/').slice(-2).join('/');

/**
 * A headless agent session: the transcript built from helm's own events,
 * the prompt sheet when the agent is waiting, and the model and permission
 * mode changeable from the header while it runs.
 */
export function DrivenSession({ client, env, session, conn, onBack, onClosed, onArchived, onSession, onTranscribe, onSettings }: {
  client: Client; env: Environment; session: Session;
  /** The socket's own health, so a dropped connection shows where it matters. */
  conn?: { online: boolean; reachable: boolean };
  onBack: () => void; onClosed: () => void; onArchived: () => void; onSession: (s: Session) => void;
  /** Absent when no machine in the network holds a Groq key. */
  onTranscribe?: (audio: string, mime: string) => Promise<string>;
  /** Only on the brain: the way to what it is made of. */
  onSettings?: () => void;
}) {
  const { log, error: logError, earlier, loadingEarlier, loadEarlier } = useSessionLog(client, env.id, session.id);
  // The draft outlives the view: leaving to answer another thread and coming
  // back finds the sentence where it was left, not an empty composer.
  const [draft, setDraftRaw] = useState(() => loadDraft(env.id, session.id));
  const setDraft = useCallback((v: string) => {
    setDraftRaw(v);
    saveDraft(env.id, session.id, v);
  }, [env.id, session.id]);
  const [attachments, setAttachments] = useState<{ name: string; mime: string; data: string; url: string }[]>([]);
  const [preparingImages, setPreparingImages] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<null | 'more'>(null);
  useDismiss(menu !== null, useCallback(() => setMenu(null), []));
  const [options, setOptions] = useState<ModelList | null>(null);
  const [commands, setCommands] = useState<{ name: string; description?: string; source?: string }[]>([]);
  const engine = ENGINE_LABEL[session.engine] ?? session.engine;
  const status = log.loaded ? log.status : session.status;
  const working = status === 'working';
  const pending = log.pending[0];
  // Queued messages are the daemon's outbox rendered in the composer, not
  // transcript turns: they only become a bubble once the agent echoes them.
  const queuedTurns = log.turns.filter((turn) => turn.queued && !turn.done);
  const transcriptTurns = log.turns.filter((turn) => !turn.queued);

  // The catalogue this device last heard, then the machine's answer behind it.
  // Without the first half the model chip reads "default" and the picker is
  // empty until a CLI has been spawned and a round trip has come back.
  useEffect(() => {
    let stale = false;
    loadModels(env.id, session.profileId).then((cached) => {
      if (!stale && cached) setOptions((now) => now ?? cached);
    });
    client.rpc<ModelList>(env.id, 'model.list', { profileId: session.profileId, id: session.id }, 30_000)
      .then((r) => { if (!stale) { setOptions(r); saveModels(env.id, session.profileId, r); } })
      .catch(() => setOptions((now) => now ?? { default: null, models: [] }));
    return () => { stale = true; };
  }, [client, env.id, session.profileId]);

  // What `/` offers. Read from the machine because that is where the
  // commands are: files beside the project, or in that account's config.
  useEffect(() => {
    let stale = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = (tries = 1) => client.rpc<{ commands: typeof commands }>(env.id, 'session.commands', { id: session.id }, 20_000)
      .then((r) => { if (!stale) setCommands(r.commands ?? []); })
      .catch(() => {
        // A cold machine can time the RPC out while the lazy driver boots
        // the CLI; one retry is the difference between a palette and none.
        if (stale) return;
        if (tries > 0) timer = setTimeout(() => load(tries - 1), 4_000);
        else setCommands([]);
      });
    void load();
    // A daemon upgrade can add commands while this conversation remains
    // open. Refresh after either the hub reconnects or this machine's direct
    // route comes back, so `/` changes without requiring a page reload.
    const off = client.on((e, kind, payload: any) => {
      if ((kind === 'connection' && payload?.online) || (e === env.id && kind === 'transport' && payload?.direct)) void load();
    });
    return () => { stale = true; clearTimeout(timer); off(); };
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
  const sendText = async (body: string, atts: typeof attachments) => {
    setDraft(''); setAttachments([]);
    try { await client.rpc(env.id, 'session.input', { id: session.id, data: body, attachments: atts.map(a => ({ filename: a.name, mime: a.mime, data: a.data })) }, 70_000); }
    catch (e: any) { setError(e.message); setDraft(body); setAttachments(atts); }
  };
  const send = async () => {
    const body = draft.trim();
    if (preparingImages) return;
    if (!body && !attachments.length) return;
    await sendText(body, attachments);
  };
  /**
   * The "resend" on a failed turn. The words are taken from the turn itself,
   * attachments included when their bytes were kept - so what goes out is
   * what went in, not a paraphrase typed a second time.
   */
  const resend = (turn: Turn) => {
    const atts = (turn.attachments ?? []).filter((a) => a.data)
      .map((a) => ({ name: a.filename, mime: a.mime, data: a.data!, url: `data:${a.mime};base64,${a.data}` }));
    void sendText(turn.text.trim(), atts);
  };

  // A queue action in flight, by ticket: the daemon's events are the source
  // of truth for what left the queue, so the button just waits it out.
  const [queueBusy, setQueueBusy] = useState('');

  /**
   * Pull a queued message back before the agent sees it: the daemon drops
   * it from the queue and closes the bubble, and the words go back into the
   * draft - behind whatever is already typed there, not over it. helm's own
   * note is not restored: it was never the owner's typing.
   */
  const withdraw = async (turn: Turn) => {
    if (queueBusy) return;
    setQueueBusy(turn.id);
    try {
      const r: any = await client.rpc(env.id, 'session.dequeue', { id: session.id, turnId: turn.id });
      if (r?.found) {
        const back = splitNote(turn.text).text ?? turn.text;
        setDraft(draft ? `${draft.replace(/\s*$/, '')}\n${back}` : back);
      }
    } catch (e: any) { setError(e.message); }
    finally { setQueueBusy(''); }
  };

  /**
   * Send a queued message into the turn already running, without
   * interrupting it. Real steering, not a queue trick: Codex's app-server
   * turn/steer is currently the only true in-flight primitive Helm has -
   * Claude's print stream queues a second frame as its own later turn and
   * ACP v1 has no equivalent, so those engines keep FIFO plus withdraw.
   */
  const sendQueuedNow = async (turn: Turn) => {
    if (queueBusy) return;
    setQueueBusy(turn.id);
    try {
      await client.rpc(env.id, 'session.send-now', { id: session.id, turnId: turn.id });
    } catch (e: any) { setError(e.message); }
    finally { setQueueBusy(''); }
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
  /**
   * Model and thinking level are the two that cost something to change here:
   * both break the provider's prompt-cache prefix, so the whole conversation
   * is written to cache again on the next turn. Mode and speed do not, and are
   * not worth a confirmation. Below the threshold in `recache.ts` none of them
   * are - a short thread costs nothing to re-cache and a dialog would be noise.
   */
  const [ask, setAsk] = useState<null | 'kill' | 'rename' | { kind: Kind; value: string; warn: string }>(null);
  const pick = (kind: Kind, value: string) => {
    if (kind === 'model' || kind === 'effort') {
      const cost = recacheCost(log.turns, modelNow, session.engine);
      if (cost) { setAsk({ kind, value, warn: recacheWarning(kind, cost) }); return; }
    }
    void call(async () => {
      const r: any = await client.rpc(env.id, RPC[kind], { id: session.id, [kind]: value });
      onSession(r.session);
    });
  };
  const confirmPick = () => {
    if (typeof ask === 'object' && ask) {
      const { kind, value } = ask;
      setAsk(null);
      void call(async () => {
        const r: any = await client.rpc(env.id, RPC[kind], { id: session.id, [kind]: value });
        onSession(r.session);
      });
    }
  };
  const kill = async () => {
    setMenu(null);
    setAsk('kill');
  };

  const archive = async () => {
    setMenu(null);
    await call(async () => { await client.rpc(env.id, 'session.archive', { id: session.id, archived: !session.archived }); onArchived(); });
  };

  // The name a session gave itself is a good guess from two prompts; this is
  // how a guess gets corrected. What is typed here is never overwritten.
  const rename = async (next: string) => {
    if (!next || next === session.title) return;
    await call(async () => {
      const r: any = await client.rpc(env.id, 'session.title', { id: session.id, title: next });
      onSession(r.session);
    });
  };

  // "Ping me when it finishes": one ring, once, the next time the thread
  // settles. New sessions start enabled; the owner can silence this thread.
  const toggleNotify = () => call(async () => {
    const r: any = await client.rpc(env.id, 'session.notify', { id: session.id, on: !session.notifyDone });
    onSession(r.session);
  });

  // Watching a long turn with the screen going dark every thirty seconds is
  // the other half of "working": hold a wake lock while asked. The OS drops
  // it when the page hides, so it is re-taken every time the page comes back.
  const [keepAwake, setKeepAwake] = useState(false);
  const wakeable = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  useEffect(() => {
    if (!keepAwake) return;
    let live = true;
    let sentinel: { release: () => Promise<void> } | null = null;
    const hold = async () => {
      try { sentinel = await (navigator as any).wakeLock.request('screen'); } catch { /* battery saver */ }
    };
    const again = () => { if (live && document.visibilityState === 'visible') hold(); };
    hold();
    document.addEventListener('visibilitychange', again);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', again);
      sentinel?.release().catch(() => {});
    };
  }, [keepAwake]);

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
  // How long the turn in flight has been going - "working" alone cannot
  // tell a turn that just started from one that has been thinking for a
  // while. The open turn's own start beats the record's last transition,
  // which also moves when a permission is answered.
  const now = useNow();
  const openTurn = transcriptTurns.filter((t) => !t.done).at(-1);
  const since = status === 'working' && openTurn ? openTurn.at : session.updatedAt;
  const age = since ? waitingSince(since, now) : '';
  const chip = (s: string) => {
    const ago = age && age !== 'just now' ? ` ${age}` : '';
    return s === 'blocked' ? <span className="chip blocked"><i />waiting{ago}</span>
      : s === 'working' ? <span className="chip working"><i />working{ago}</span> : null;
  };

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
        <button className="iconbtn back" aria-label="Back" onClick={onBack}>‹</button>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub">
            <EngineMark engine={session.engine} />
            {[engine, shortPath(session.cwd), money(session.costUsd)].filter(Boolean).join(' · ')}
            {!env.online && <span className="offline"> · machine offline</span>}
            {env.online && conn && !conn.online && (
              <span className="offline"> · {conn.reachable ? 'reconnecting' : 'connection down'}</span>
            )}
          </span>
        </div>
        {chip(status)}
        {/* Completion notifications are on for new threads. The daemon holds
            the preference, so it is the same on every device and survives
            this one closing. */}
        <button
          className={`iconbtn bell${session.notifyDone ? ' on' : ''}`}
          title={session.notifyDone ? 'completion notifications on — tap to turn off' : 'completion notifications off — tap to turn on'}
          aria-label={session.notifyDone ? 'turn completion notifications off' : 'turn completion notifications on'}
          aria-pressed={!!session.notifyDone}
          onClick={toggleNotify}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
            <path d="M13.7 20a2 2 0 01-3.4 0" />
          </svg>
        </button>
        {/* The brain has no folder to go back to and no siblings to compare
            it with, so what it is made of has to be reachable from inside it.
            Ordinary threads keep the ⋯ menu alone. */}
        {session.brain && onSettings && (
          <button className="iconbtn" title="what this brain is made of" aria-label="brain settings" onClick={onSettings}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 2.8v2.6M12 18.6v2.6M4.5 4.5l1.9 1.9M17.6 17.6l1.9 1.9M2.8 12h2.6M18.6 12h2.6M4.5 19.5l1.9-1.9M17.6 6.4l1.9-1.9" />
            </svg>
          </button>
        )}
        <button className="iconbtn" title="more" aria-label="more" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}>⋯</button>
        {menu === 'more' && (
          <div className="menu" onClick={() => setMenu(null)}>
            <button onClick={() => { setMenu(null); setAsk('rename'); }}>Rename thread</button>
            {wakeable && (
              <button aria-pressed={keepAwake} onClick={() => setKeepAwake((v) => !v)}>
                {keepAwake ? 'Let the screen sleep' : 'Keep the screen awake'}
              </button>
            )}
            <button onClick={archive}>{session.archived ? 'Unarchive thread' : 'Archive thread'}</button>
            <button className="destructive" onClick={kill}>Delete thread</button>
          </div>
        )}
      </div>

      <Transcript
        turns={transcriptTurns} status={status} loaded={log.loaded}
        earlier={earlier} loadingEarlier={loadingEarlier} onEarlier={loadEarlier}
        onResend={resend} onWithdraw={withdraw}
        empty={session.alive === false ? 'This conversation resumes with your next message.' : undefined}
      />

      <Composer
        onTranscribe={onTranscribe}
        draft={draft} setDraft={setDraft} onSend={send} onStop={stop} working={working}
        engine={engine} keys={false} waiting={!!pending} danger={mode?.danger}
        foot={controls.chips} canAttach={canAttach} preparing={preparingImages > 0}
        onAttach={onAttach} attachments={attachments} onRemoveAttachment={(i) => setAttachments(a => a.filter((_, j) => j !== i))}
        onAttachUnsupported={() => setError(`${engine} cannot be sent images in this session.`)}
        commands={commands}
        queued={queuedTurns.map((turn) => ({
          turn, text: splitNote(turn.text).text ?? turn.text,
          attachments: turn.attachments?.length ?? 0,
        }))}
        onWithdrawQueued={withdraw}
        onSendQueuedNow={session.engine === 'codex' ? sendQueuedNow : undefined}
        queueBusy={queueBusy}
        history={log.turns.map((turn) => splitNote(turn.text).text ?? '').filter(Boolean)}
      >
        {/* Above the input, not under it: below the composer it landed in
            the home-bar zone and pushed the input up. A tap dismisses it. */}
        {(error || logError) && <div className="error floating" role="alert" onClick={() => setError('')}>{error || logError}</div>}
        {controls.sheet}
        {pending && <PermissionSheet key={pending.requestId} permission={pending} onAnswer={answer} busy={busy} />}
        {log.pending.length > 1 && <div className="note more-pending">{log.pending.length - 1} more waiting</div>}
      </Composer>

      {ask === 'kill' && (
        <Confirm
          title={`Delete "${session.title}"?`}
          body="The agent is closed and this conversation is removed from helm."
          confirmLabel="Delete" danger busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={async () => {
            setAsk(null);
            await call(async () => { await client.rpc(env.id, 'session.kill', { id: session.id }); onClosed(); });
          }}
        />
      )}
      {ask === 'rename' && (
        <TextPrompt
          title="Name this thread" value={session.title} submitLabel="Rename" busy={busy}
          onCancel={() => setAsk(null)}
          onSubmit={async (v) => { setAsk(null); await rename(v); }}
        />
      )}
      {typeof ask === 'object' && ask && (
        <Confirm
          title="Change it anyway?"
          body={ask.warn}
          confirmLabel="Change" busy={busy}
          onCancel={() => setAsk(null)}
          onConfirm={confirmPick}
        />
      )}
    </>
  );
}
