import { useDismiss } from '../useDismiss';
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { Client, type Environment, type Session, type ModelList } from '../client';
import { useNow, waitingSince } from '../useNow';
import { Composer } from './Composer';
import { looksLikeImage, prepareImage } from './image';
import { EngineMark } from '../EngineMark';
import { PermissionSheet } from './PermissionSheet';
import { RecoveryCard } from './RecoveryCard';
import { Controls, type Kind } from './Controls';
import { Transcript, splitNote } from './Transcript';
import { useGitStatus } from './Changes';
import { expandPastes } from './pasteStore';
import { Confirm, TextPrompt } from '../Modal';
import { loadDraft, saveDraft } from '../draftStore';
import { useDraftImages } from './useDraftImages';
import { recacheCost, recacheWarning } from '@helm/usage/recache';
import { money, busyStatus } from '../format';
import { loadModels, saveModels } from '../modelCache';
import { followModelRefresh } from '../modelRefresh';
import { useSessionLog } from './useSessionLog';
import type { Decision, Turn } from './types';
import { useThreadTeam } from './TeamSummary';
import { ThreadDetails, type DetailsTab } from './ThreadDetails';
import { ExternalSessionNotice } from './ExternalSessionNotice';
import { QueueEdit } from './QueueEdit';
import { BackIcon, Icon } from '../Icon';
import { Route } from '../Route';
import { TaskReturn } from './TaskReturn';
import { LimitsLine } from './LimitsLine';
import { current, limitWindows, rememberLimits, rememberedLimits, type LimitWindow } from './limits';

const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', opencode2: 'OpenCode 2', devin: 'Devin',
  grok: 'Grok', cursor: 'Cursor', pi: 'Pi', omp: 'OMP', rovo: 'Rovo Dev',
  agy: 'Antigravity CLI', antigravity: 'Antigravity', gemini: 'Gemini', kimi: 'Kimi', muse: 'Muse',
};

type Attachment = { name: string; mime: string; data: string; url: string };

/**
 * A headless agent session: the transcript built from helm's own events,
 * the prompt sheet when the agent is waiting, and the model and permission
 * mode changeable from the header while it runs.
 */
export function DrivenSession({ client, env, session, conn, onBack, onClosed, onArchived, onSession, onTranscribe, onSettings, onOpenSession, onSendTask, onOpenMachineSession }: {
  client: Client; env: Environment; session: Session;
  /** The socket's own health, so a dropped connection shows where it matters. */
  conn?: { online: boolean; reachable: boolean };
  onBack: () => void; onClosed: () => void; onArchived: () => void; onSession: (s: Session) => void;
  /** Absent when no machine in the network holds a Groq key. */
  onTranscribe?: (audio: string, mime: string) => Promise<string>;
  /** Only on the brain: the way to what it is made of. */
  onSettings?: () => void;
  /** Open a branch, subagent, or its parent conversation. */
  onOpenSession?: (s: Session) => void;
  onSendTask?: () => void;
  onOpenMachineSession?: (machineId: string, session: Session) => void;
}) {
  const { log, error: logError, syncing, earlier, loadingEarlier, loadEarlier } = useSessionLog(client, env.id, session.id);
  // The draft outlives the view: leaving to answer another thread and coming
  // back finds the sentence where it was left, not an empty composer.
  const [draft, setDraftRaw] = useState(() => loadDraft(env.id, session.id));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editRevision = useRef(0);
  const setDraft = useCallback((v: string) => {
    editRevision.current += 1;
    draftRef.current = v;
    setDraftRaw(v);
    saveDraft(env.id, session.id, v);
  }, [env.id, session.id]);
  const [error, setError] = useState('');
  const { images: attachments, setImages: setAttachmentsRaw, loading: loadingImages, saving: savingImages } = useDraftImages<Attachment>(env.id, session.id, setError);
  const setAttachments = useCallback((next: SetStateAction<Attachment[]>) => {
    editRevision.current += 1;
    return setAttachmentsRaw(next);
  }, [setAttachmentsRaw]);
  const [preparingImages, setPreparingImages] = useState(0);
  const [sendingImages, setSendingImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<null | 'more'>(null);
  const [details, setDetails] = useState<DetailsTab | null>(null);
  const [editingQueue, setEditingQueue] = useState<Turn | null>(null);
  const [references, setReferencesRaw] = useState<{ id: string; title: string }[]>([]);
  const setReferences = useCallback((next: SetStateAction<{ id: string; title: string }[]>) => {
    editRevision.current += 1;
    setReferencesRaw(next);
  }, []);
  const [referenceOptions, setReferenceOptions] = useState<{ id: string; title: string }[]>([]);
  const team = useThreadTeam(client, env.id, session.id);
  useEffect(() => {
    let stale = false;
    client.rpc<{ sessions: Session[] }>(env.id, 'session.list', {}).then((result) => {
      if (!stale) setReferenceOptions((result.sessions ?? []).filter((item) => item.id !== session.id && !!item.driver && !item.archived).map(({ id, title }) => ({ id, title })));
    }).catch(() => {});
    return () => { stale = true; };
  }, [client, env.id, session.id]);
  /** The message a branch was asked for from, while the confirmation is up. */
  const [branching, setBranching] = useState<Turn | null>(null);
  useDismiss(menu !== null, useCallback(() => setMenu(null), []));
  const [options, setOptions] = useState<ModelList | null>(null);
  const [commands, setCommands] = useState<{ name: string; description?: string; source?: string }[]>([]);
  const engine = ENGINE_LABEL[session.engine] ?? session.engine;
  const status = log.loaded ? log.status : session.status;
  // Starting is work in progress too: Stop is the useful button, and a
  // stale problem card from the last run is not.
  const childrenWorking = !!session.team?.working || team.some(({ session: child }) => ['working', 'starting'].includes(child.delegation?.status ?? child.status));
  const working = busyStatus(status) || childrenWorking;
  const [reviewingRequest, setReviewingRequest] = useState(() => session.ask?.requestId ?? '');
  useEffect(() => { setReviewingRequest(session.ask?.requestId ?? ''); }, [session.id]);
  const pending = log.pending.find(request => request.requestId === reviewingRequest) ?? log.pending[0];
  const permissionBox = useRef<HTMLDivElement>(null);
  const reviewRequest = useCallback((requestId: string) => setReviewingRequest(requestId), []);
  useEffect(() => {
    if (!reviewingRequest || pending?.requestId !== reviewingRequest) return;
    permissionBox.current?.scrollIntoView({ block: 'nearest' });
    permissionBox.current?.querySelector<HTMLElement>('button:not(:disabled), input, textarea')?.focus({ preventScroll: true });
  }, [reviewingRequest, pending?.requestId]);
  const childrenWaiting = team.filter(({ session: child }) => (child.delegation?.status ?? child.status) === 'blocked' || !!child.pending);
  // Queued messages are the daemon's outbox rendered in the composer, not
  // transcript turns: they only become a bubble once the agent echoes them.
  const queueOrder = new Map((session.queueOrder ?? []).map((id, index) => [id, index]));
  const queuedTurns = log.turns.filter((turn) => turn.queued && !turn.done).sort((left, right) => (queueOrder.get(left.id) ?? Infinity) - (queueOrder.get(right.id) ?? Infinity));
  const transcriptTurns = log.turns.filter((turn) => !turn.queued);

  // The catalogue this device last heard, then the machine's answer behind it.
  // Without the first half the model chip reads "default" and the picker is
  // empty until a CLI has been spawned and a round trip has come back.
  useEffect(() => {
    let stale = false;
    setOptions(null);
    loadModels(env.id, session.profileId).then((cached) => {
      if (!stale && cached) setOptions((now) => now ?? cached);
    });
    const catalog = followModelRefresh(
      () => client.rpc<ModelList>(env.id, 'model.list', { profileId: session.profileId, id: session.id }, 30_000),
      (r) => { setOptions(r); saveModels(env.id, session.profileId, r); },
      () => setOptions((now) => now ?? { default: null, models: [] }),
    );
    const off = client.on((e, kind, payload: any) => {
      if ((kind === 'connection' && payload?.online) || (e === env.id && kind === 'transport' && payload?.direct)) void catalog.refresh();
    });
    return () => { stale = true; catalog.stop(); off(); };
  }, [client, env.id, session.profileId, session.id, session.model, session.engineModel]);

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
  // An orphaned helper is listed on its own; its parent is gone, so there is no thread to go back to.
  const parentThread = !!session.delegation?.parentId && !session.unhomed;
  const openParent = () => {
    const parentId = session.delegation?.parentId;
    if (!parentId || !onOpenSession) return;
    void call(async () => {
      const r = await client.rpc<{ session: Session }>(env.id, 'session.events', { id: parentId, limit: 1 });
      onOpenSession(r.session);
    });
  };

  /**
   * Picked, pasted or dropped images, compressed in the browser.
   *
   * Every decode failure says so; all chosen images are prepared.
   */
  const onAttach = async (files: FileList | File[]) => {
    if (loadingImages || savingImages || sendingImages) return 0;
    const chosen = Array.from(files);
    if (!chosen.length) return 0;
    const failures: string[] = [];
    const next: typeof attachments = [];
    setPreparingImages((count) => count + 1);
    setError('');
    try {
      for (const f of chosen) {
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
      if (next.length) await setAttachments((current) => [...current, ...next]);
      if (failures.length) setError(`Image not added — ${failures.join('; ')}`);
      return next.length;
    } finally {
      setPreparingImages((count) => Math.max(0, count - 1));
    }
  };
  const sendText = async (body: string, atts: Attachment[], sentReferences = references) => {
    setReferences([]);
    if (!atts.length) setDraft('');
    if (atts.length) setSendingImages(true);
    const clearedAt = editRevision.current;
    try {
      await client.rpc(env.id, 'session.input', { id: session.id, data: body, references: sentReferences.map((item) => item.id), attachments: atts.map(a => ({ filename: a.name, mime: a.mime, data: a.data })) }, 70_000);
      if (atts.length) {
        if (editRevision.current === clearedAt) setDraft('');
        await setAttachments(current => current.filter(image => !atts.includes(image)));
      }
    }
    catch (e: any) {
      setError(e.message);
      // Only restore the failed send if the composer is still exactly in the
      // state produced by clearing it. A newer draft or attachment edit -
      // including one from another pending send - belongs to the owner and
      // must not be overwritten by a late RPC failure.
      if (editRevision.current === clearedAt) {
        setDraft(body);
        setReferences(sentReferences);
      }
    } finally { if (atts.length) setSendingImages(false); }
  };
  const send = async () => {
    const body = expandPastes(draft.trim());
    if (preparingImages || loadingImages || savingImages || sendingImages) return;
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
    void sendText(turn.text.trim(), atts, (turn.references ?? []).map((id) => referenceOptions.find((item) => item.id === id) ?? { id, title: id }));
  };
  // A failed turn is sent again as it was written; anything else (a pause,
  // a limit, a stop) carries on from the saved conversation.
  // The last message's turn, past a bare turn holding only the error line.
  const lastTurn = [...transcriptTurns].reverse().find((turn) => turn.text?.trim());
  const retry = session.recovery?.kind === 'error' && lastTurn?.done?.status === 'error'
    ? () => resend(lastTurn)
    : () => void call(() => client.rpc(env.id, 'session.recover', { id: session.id }));

  // A queue action in flight, by ticket: the daemon's events are the source
  // of truth for what left the queue, so the button just waits it out.
  const [queueBusy, setQueueBusy] = useState('');
  const queueAction = async (turn: Turn, method: string, params: object = {}) => {
    if (queueBusy) return false;
    setQueueBusy(turn.id); setError('');
    try { await client.rpc(env.id, method, { id: session.id, turnId: turn.id, ...params }); return true; }
    catch (failure: any) { setError(failure.message); return false; }
    finally { setQueueBusy(''); }
  };
  const moveQueued = (turn: Turn, direction: -1 | 1) => {
    const ids = queuedTurns.filter((entry) => !entry.delivered).map((entry) => entry.id);
    const index = ids.indexOf(turn.id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    void queueAction(turn, 'session.queue-reorder', { turnIds: ids });
  };

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
        setDraft(draftRef.current ? `${draftRef.current.replace(/\s*$/, '')}\n${back}` : back);
        if (turn.references?.length) setReferences((current) => [...current, ...turn.references!.filter((id) => !current.some((item) => item.id === id)).map((id) => referenceOptions.find((item) => item.id === id) ?? { id, title: id })].slice(0, 3));
        if (turn.attachments?.length) setAttachments((current) => [...current, ...turn.attachments!.filter((item) => item.data).map((item) => ({ name: item.filename, mime: item.mime, data: item.data!, url: `data:${item.mime};base64,${item.data}` }))]);
      }
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
      if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[aria-modal="true"]')) return;
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
  const since = working && openTurn ? openTurn.at : session.updatedAt;
  const age = since ? waitingSince(since, now) : '';
  const chip = (s: string) => {
    const ago = age && age !== 'just now' ? ` ${age}` : '';
    return s === 'blocked' ? <span className="chip blocked"><i />waiting{ago}</span>
      : s === 'starting' ? <span className="chip working"><i />starting</span>
      : s === 'working' ? <span className="chip working"><i />working{ago}</span>
      // Its own turn is over, but child tasks are not: the sidebar calls
      // this working, so the open chat must not look finished.
      : childrenWorking ? <span className="chip working" title="Child tasks are still working"><i />working</span>
      : s === 'unknown' ? <span className="chip exited" title="The machine could not tell whether this agent is working">status unavailable</span>
      : null;
  };

  // Favorites and new-chat defaults live on the machine, so a phone and a laptop
  // open the same picker. Older machines answer without `favs`, and the
  // sheet falls back to this browser's own favorites.
  const saveFavs = (next: string[]) => {
    setOptions((now) => now && { ...now, favs: next });
    client.rpc(env.id, 'picker.prefs', { favs: { [session.engine]: next } }, 15_000).catch((e) => setError(e.message));
  };
  const saveEffortFavs = (model: string, next: string[]) => {
    const others = (options?.effortFavs ?? []).filter((entry) => {
      try { return JSON.parse(entry)[0] !== model; } catch { return false; }
    });
    const effortFavs = [...others, ...next.map((effort) => JSON.stringify([model, effort]))];
    setOptions((now) => now && { ...now, effortFavs });
    client.rpc(env.id, 'picker.prefs', { favs: { [`${session.engine}-effort`]: effortFavs } }, 15_000).catch((e) => setError(e.message));
  };
  const saveDefault = async (kind: Kind, value: string) => {
    if (!options) return;
    setError('');
    try {
      if (kind === 'model') {
        const r: any = await client.rpc(env.id, 'model.prefs', {
          profileId: session.profileId, default: value, approved: options.prefs?.approved ?? [],
        }, 15_000);
        setOptions((now) => now && { ...now, prefs: r.prefs });
      } else {
        const r: any = await client.rpc(env.id, 'profile.defaults', {
          profileId: session.profileId, ...(options.defaults ?? {}), [kind]: value,
        }, 15_000);
        setOptions((now) => now && { ...now, defaults: r.defaults });
      }
    } catch (e: any) { setError(e.message); throw e; }
  };
  const controls = Controls({ options, session, busy, onPick: pick, onFavs: saveFavs, onEffortFavs: saveEffortFavs, onDefault: saveDefault });
  // The account's limits, as this chat last heard them or any chat on the
  // same account did before it.
  const limitAccount = `${env.id}:${session.profileId}`;
  const liveLimits = useMemo(() => limitWindows(log.limits), [log.limits]);
  useEffect(() => { rememberLimits(limitAccount, liveLimits); }, [limitAccount, liveLimits]);
  // Before this chat hears its own, the machine's latest reading for the
  // account - from any chat on it, on any device - beats what this browser
  // happens to remember.
  const [machineLimits, setMachineLimits] = useState<LimitWindow[]>([]);
  useEffect(() => {
    if (!session.profileId || session.brain || session.engine === 'shell') return;
    let live = true;
    const read = () => client.rpc<{ accounts: { engine: string; aliases: string[]; windows: LimitWindow[] }[] }>(env.id, 'usage.limits', {}, 15_000)
      .then((r) => {
        const mine = r.accounts.find((a) => a.engine === session.engine && a.aliases.includes(session.profileId!));
        if (live) setMachineLimits(mine?.windows.map(({ label, used, resetsAt }) => ({ label, used, resetsAt })) ?? []);
      }).catch(() => { /* older machine or offline: the remembered reading stands */ });
    read();
    const timer = setInterval(read, 120_000);
    return () => { live = false; clearInterval(timer); };
  }, [client, env.id, session.profileId, session.engine, session.brain]);
  const limits = current(liveLimits.length ? liveLimits : machineLimits.length ? machineLimits : rememberedLimits(limitAccount));
  // Which account this chat runs on: with several logins per CLI the mark
  // alone does not say whose plan is being spent. It sits with that plan's
  // limits under the composer rather than crowding the title.
  const account = session.profileId && !session.brain && session.engine !== 'shell' ? session.profileId : '';

  // Everything this chat runs with - the account, model, thinking, permissions
  // and speed - becomes what a new chat on this machine starts with, for
  // every device, until it is changed again.
  const [notice, setNotice] = useState('');
  const saveAsDefaults = () => call(async () => {
    if (!options) throw new Error('Still reading this chat\'s settings - try again in a moment.');
    // What the model chip shows is what this chat runs with.
    const model = session.model || session.engineModel || options.default || '';
    const effort = session.effort || session.engineEffort || '';
    const mode = session.mode && session.mode !== 'plan' ? session.mode : '';
    const speed = session.speed || '';
    if (model) {
      const r: any = await client.rpc(env.id, 'model.prefs', {
        profileId: session.profileId, default: model, approved: options.prefs?.approved ?? [],
      }, 15_000);
      setOptions((now) => now && { ...now, prefs: r.prefs });
    }
    const d: any = await client.rpc(env.id, 'profile.defaults', {
      profileId: session.profileId, effort: effort || undefined, mode: mode || undefined, speed: speed || undefined,
    }, 15_000);
    setOptions((now) => now && { ...now, defaults: d.defaults });
    if (options.account) await client.rpc(env.id, 'picker.prefs', { agent: options.account }, 15_000);
    const label = (m: string) => options.labels?.[m] ?? m;
    setNotice(`New chats on ${env.name} now start with ${[engine, model && label(model), effort, mode && (options.modes?.find((x) => x.id === mode)?.short ?? mode), speed].filter(Boolean).join(' · ')}.`);
    setTimeout(() => setNotice(''), 5000);
  });
  // What the folder looks like to git. Asked again whenever a turn ends,
  // which is when something has usually just changed.
  const git = useGitStatus(client, env, session.cwd, working ? 'working' : `rest:${session.updatedAt ?? 0}`);
  const changed = git.status?.repo ? (git.status.files?.length ?? 0) + (git.status.more ?? 0) : 0;

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
      <div className="bar session-bar">
        <button className="iconbtn back" aria-label={parentThread && onOpenSession ? 'Back to parent thread' : 'Back'}
          onClick={parentThread && onOpenSession ? openParent : onBack}><BackIcon /></button>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub">
            <EngineMark engine={session.engine} />
            <Route machine={env.name} folder={session.brain ? undefined : session.cwd} />
            {session.nativeCodex && <span> · Live CLI</span>}
            {[session.brain ? engine : '', money(session.costUsd)].filter(Boolean).map((part) => (
              <span key={part}><span className="sep"> · </span>{part}</span>
            ))}
            {log.loaded && (logError || (!env.online && syncing))
              ? <span className="offline" role="status"> · Saved chat · reconnecting…</span>
              : syncing && <span role="status"> · Syncing chat…</span>}
            {!env.online && !log.loaded && <span className="offline"> · machine offline</span>}
            {env.online && conn && !conn.online && !logError && (
              <span className="offline"> · live updates reconnecting…</span>
            )}
          </span>
        </div>
        {chip(status)}
        {/* Git gets its own button with the count of changed files: it is
            the thing most often checked. The other opens agents and repeats. */}
        {git.status?.repo && !session.brain && (
          <button className="iconbtn thread-details-launch" aria-label={changed > 0 ? `Git: ${changed} changed files` : 'Git'} title="Git graph and changes"
            onClick={() => setDetails('changes')}><Icon name="git" size={17} />{changed > 0 && <b className="cbadge">{changed > 99 ? '99+' : changed}</b>}</button>
        )}
        <button className="iconbtn thread-details-launch" aria-label="Agents" title="Agents and scheduled tasks"
          onClick={() => setDetails('agents')}><Icon name="subagents" size={17} />{team.length > 0 && <b className="cbadge quiet">{team.length}</b>}</button>
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
        <button className="iconbtn" title="more" aria-label="more" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}><Icon name="more" size={18} /></button>
        {/* Only what the buttons beside it do not already reach. */}
        {menu === 'more' && (
          <div className="menu" onClick={() => setMenu(null)}>
            <button onClick={() => { setMenu(null); setAsk('rename'); }}>Rename thread</button>
            {!session.brain && onSendTask && !session.external && (
              <button disabled={!env.online} onClick={onSendTask}>Send to another machine</button>
            )}
            {!session.brain && <button onClick={() => { setMenu(null); void saveAsDefaults(); }}>Use these settings for new chats</button>}
            <button aria-pressed={!!session.notifyDone} onClick={toggleNotify}>
              {session.notifyDone ? 'Turn completion alerts off' : 'Turn completion alerts on'}
            </button>
            {parentThread && onOpenSession && <button onClick={openParent}>Open parent thread</button>}
            <button onClick={archive}>{session.archived ? 'Unarchive thread' : 'Archive thread'}</button>
            <button className="destructive" onClick={kill}>{session.nativeCodex ? 'Remove from Helm' : 'Delete thread'}</button>
          </div>
        )}
      </div>

      <TaskReturn client={client} envId={env.id} transfer={session.taskTransfer}
        original={session.parent} onOpenSession={onOpenMachineSession} />
      <ExternalSessionNotice session={session}
        onTakeOver={(cancel) => client.rpc(env.id, 'session.takeover', { id: session.id, cancel }, 20_000)} />
      <Transcript
        turns={transcriptTurns} status={status} loaded={log.loaded}
        pending={log.pending} onReviewRequest={reviewRequest}
        earlier={earlier} loadingEarlier={loadingEarlier} onEarlier={loadEarlier}
        onResend={resend} onWithdraw={withdraw}
        onBranch={session.engine === 'claude' && onOpenSession ? setBranching : undefined}
        empty={session.alive === false ? 'This conversation resumes with your next message.' : undefined}
      />

      <Composer
        onTranscribe={onTranscribe}
        draft={draft} setDraft={setDraft} onSend={send} onStop={stop} working={working}
        engine={engine} keys={false} waiting={!!pending} danger={mode?.danger}
        foot={controls.chips} statusLine={account || limits.length > 0 ? <LimitsLine windows={limits} account={account} /> : undefined} canAttach={canAttach} preparing={preparingImages > 0 || loadingImages || savingImages || sendingImages}
        onAttach={onAttach} attachments={attachments} onRemoveAttachment={(i) => setAttachments(a => a.filter((_, j) => j !== i))}
        onAttachUnsupported={() => setError(`${engine} cannot be sent images in this session.`)}
        commands={commands}
        referenceOptions={referenceOptions} references={references}
        onReference={(id) => { const item = referenceOptions.find((option) => option.id === id); if (item) setReferences((current) => [...current, item].slice(0, 3)); }}
        onRemoveReference={(id) => setReferences((current) => current.filter((item) => item.id !== id))}
        queued={queuedTurns.map((turn) => ({
          turn, text: splitNote(turn.text).text ?? turn.text,
          attachments: turn.attachments?.length ?? 0, delivered: turn.delivered,
        }))}
        onWithdrawQueued={withdraw}
        onEditQueued={setEditingQueue}
        onRemoveQueued={(turn) => void queueAction(turn, 'session.dequeue')}
        onMoveQueued={moveQueued}
        onSendQueued={(turn) => void queueAction(turn, 'session.send-now')}
        steers={session.engine === 'codex' || session.engine === 'claude'}
        queueBusy={queueBusy}
        history={log.turns.map((turn) => splitNote(turn.text).text ?? '').filter(Boolean)}
      >
        {/* Above the input, not under it: below the composer it landed in
            the home-bar zone and pushed the input up. A tap dismisses it. */}
        {(error || (!log.loaded && logError)) && <div className="error floating" role="alert" onClick={() => setError('')}>{error || logError}</div>}
        {notice && !error && <div className="notice floating" role="status" onClick={() => setNotice('')}><Icon name="check" size={14} />{notice}</div>}
        {controls.sheet}
        {session.recovery && !working && !pending && (
          <RecoveryCard key={session.recovery.at} recovery={session.recovery} busy={busy} offline={!env.online} onRetry={retry} />
        )}
        {childrenWaiting.length > 0 && <div className="child-requests" role="group" aria-label="Subagents waiting for you">
          {childrenWaiting.map(({ session: child }) => <button key={child.id} disabled={!onOpenSession} onClick={() => onOpenSession?.(child)}>
            <Icon name="subagents" size={15} /><span><b>{child.title}</b><small>{child.ask?.kind === 'question' ? 'Answer question' : 'Review request'}{child.ask?.text ? ` · ${child.ask.text}` : ''}</small></span><Icon name="forward" size={14} />
          </button>)}
        </div>}
        {pending && <div ref={permissionBox}><PermissionSheet key={pending.requestId} permission={pending} onAnswer={answer} busy={busy} /></div>}
        {log.pending.length > 1 && <div className="child-requests" role="group" aria-label="Other requests waiting for you">
          {log.pending.filter(request => request.requestId !== pending?.requestId).map(request => <button key={request.requestId} onClick={() => reviewRequest(request.requestId)}>
            <Icon name="forward" size={14} /><span>{request.title}</span>
          </button>)}
        </div>}
      </Composer>

      {details && <ThreadDetails client={client} env={env} session={session} tab={details} onTab={setDetails} git={git.status} reloadGit={git.reload} onClose={() => setDetails(null)}
        onOpen={onOpenSession ? (item) => { setDetails(null); onOpenSession(item); } : undefined} />}
      {editingQueue && <QueueEdit turn={editingQueue} busy={!!queueBusy} onCancel={() => setEditingQueue(null)} onSave={async (text, attachments) => {
        if (await queueAction(editingQueue, 'session.queue-edit', { text, attachments })) setEditingQueue(null);
      }} />}

      {branching && (
        <Confirm
          title="Branch from here?"
          body="A new thread that starts as this conversation was before that message, so you can ask it differently. This one stays as it is, and so do your files - the branch sees them as they are now."
          confirmLabel="Branch" busy={busy}
          onCancel={() => setBranching(null)}
          onConfirm={async () => {
            const turn = branching;
            setBranching(null);
            await call(async () => {
              const r = await client.rpc<{ session: Session }>(env.id, 'session.fork', { id: session.id, turnId: turn.id }, 70_000);
              onOpenSession?.(r.session);
            });
          }}
        />
      )}

      {ask === 'kill' && (
        <Confirm
          title={session.nativeCodex ? `Remove "${session.title}" from Helm?` : `Delete "${session.title}"?`}
          body={session.nativeCodex ? 'The conversation remains in Codex and its terminal keeps running.' : 'The agent is closed and this conversation is removed from helm.'}
          confirmLabel={session.nativeCodex ? 'Remove' : 'Delete'} danger busy={busy}
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
