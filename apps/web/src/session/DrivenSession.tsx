import { useDismiss } from '../useDismiss';
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { Client, type Environment, type Session, type ModelList, type NativeAgent } from '../client';
import { useNow, waitingSince } from '../useNow';
import { Composer } from './Composer';
import { prepareAttachment } from './image';
import { EngineMark } from '../EngineMark';
import { PermissionSheet, type QuestionHandle } from './PermissionSheet';
import { TodoStrip, stripTodos } from './Todos';
import { RecoveryCard } from './RecoveryCard';
import { Controls, trayPrefs, type Kind } from './Controls';
import { Transcript, splitNote, isCompaction } from './Transcript';
import { useGitStatus } from './Changes';
import { changesOf } from './stepWords';
import { expandPastes } from './pasteStore';
import { Confirm, TextPrompt, Sheet } from '../Modal';
import { loadDraft, saveDraft } from '../draftStore';
import { loadedChat, startedEmpty } from '../startingChats';
import { useDraftImages } from './useDraftImages';
import { recacheCost, recacheWarning } from '@helm/usage/recache';
import type { Transcribe } from './voice';
import { messageDelivery } from '@helm/protocol/message-delivery';
import { newMessageId, retryableDelivery } from '@helm/protocol/reliable-input';
import { money, busyStatus } from '../format';
import { loadModels, saveModels } from '../modelCache';
import { followModelRefresh } from '../modelRefresh';
import { useSessionLog } from './useSessionLog';
import type { Decision, Item, Turn } from './types';
import { useThreadTeam } from './TeamSummary';
import { ThreadDetails, type DetailsTab } from './ThreadDetails';
import { ExternalSessionNotice } from './ExternalSessionNotice';
import { QueueEdit } from './QueueEdit';
import { BackIcon, Icon } from '../Icon';
import { Route } from '../Route';
import { EmptyChat, useDockLift } from './EmptyChat';
import { CloneCard } from './CloneCard';
import { TaskReturn } from './TaskReturn';
import { LimitsLine } from './LimitsLine';
import { ContextLimit } from './ContextLimit';
import { useAccountLimits } from './useAccountLimits';
import { useChatKeys } from './chatKeys';
import { BrowserDock, useBrowserDock } from './BrowserDock';
import { addSample, streamedChars, tokensPerSecond, type Sample } from './tokenRate';

const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', opencode2: 'OpenCode 2', devin: 'Devin',
  grok: 'Grok', cursor: 'Cursor', pi: 'Pi', omp: 'OMP',
  agy: 'Antigravity CLI', antigravity: 'Antigravity', gemini: 'Gemini', kimi: 'Kimi', muse: 'Muse',
};

type Attachment = { name: string; mime: string; data: string; url: string };
/** Words whose send failed after the composer had moved on, kept until sent or dismissed. */
type FailedSend = { id: string; messageId: string; body: string; references: string[]; error: string; retrying?: boolean };
const rejectedDelivery = (error: { code?: string }) => !!error.code && !retryableDelivery(error);

/**
 * A headless agent session: the transcript built from helm's own events,
 * the prompt sheet when the agent is waiting, and the model and permission
 * mode changeable from the header while it runs.
 */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** The folder of the newest file a chat changed, by its full path. */
function lastEditedDir(turns: Turn[]): string {
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const items = turns[t].items;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      // Only edit steps are read: a command's input is never parsed here.
      if (item.kind !== 'edit' && !(item.kind === 'tool' && EDIT_TOOLS.has(item.name ?? ''))) continue;
      const path = changesOf(item).map((change) => change.path).reverse().find((p) => p?.startsWith('/'));
      if (path) return path.slice(0, path.lastIndexOf('/')) || '/';
    }
  }
  return '';
}

export function DrivenSession({ client, env, machines, session, conn, onBack, onClosed, onArchived, onSession, onTranscribe, onSettings, onOpenSession, onSendTask, onSendFolder, onOpenMachineSession, onOpenNative, reviewChildren }: {
  client: Client; env: Environment; session: Session;
  /** Every machine, for settings that belong to the account and so apply on all of them. */
  machines?: Environment[];
  /** A new attention-card visit opens the child task details, even in the current chat. */
  reviewChildren?: number;
  /** The socket's own health, so a dropped connection shows where it matters. */
  conn?: { online: boolean; reachable: boolean };
  onBack: () => void; onClosed: () => void; onArchived: () => void; onSession: (s: Session) => void;
  /** Absent when no machine in the network holds a Groq key. */
  onTranscribe?: Transcribe;
  /** Only on the brain: the way to what it is made of. */
  onSettings?: () => void;
  /** Open a branch, subagent, or its parent conversation. */
  onOpenSession?: (s: Session) => void;
  /** Open one of Claude Code's own subagents as a read-only chat. */
  onOpenNative?: (agent: NativeAgent) => void;
  onSendTask?: () => void;
  onSendFolder?: () => void;
  onOpenMachineSession?: (machineId: string, session: Session) => void;
}) {
  const { log, error: logError, syncing, earlier, loadingEarlier, loadEarlier, refresh } = useSessionLog(client, env.id, session.id);
  // Just up from its placeholder with nothing said: it is empty for certain,
  // so the empty page it already showed stays put while the history loads.
  const [cameUpEmpty] = useState(() => startedEmpty(session.id));
  useEffect(() => { if (log.loaded) loadedChat(session.id); }, [log.loaded, session.id]);
  const loaded = log.loaded || cameUpEmpty;
  const readVisual = useCallback((ref: string) => client.rpc<{ html: string }>(env.id, 'session.visual', { id: session.id, ref }, 60_000), [client, env.id, session.id]);
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
  /** The first words are on their way: the greeting steps aside before the agent echoes them. */
  const [sentFirst, setSentFirst] = useState(false);
  const [menu, setMenu] = useState<null | 'more'>(null);
  const [details, setDetails] = useState<DetailsTab | null>(reviewChildren ? 'agents' : null);
  const browser = useBrowserDock(client, env, session);
  useEffect(() => { if (reviewChildren) setDetails('agents'); }, [reviewChildren]);
  const [reviewNative, setReviewNative] = useState(false);
  const [focusItem, setFocusItem] = useState<{ id: string; visit: number }>();
  const [editingQueue, setEditingQueue] = useState<Turn | null>(null);
  const [references, setReferencesRaw] = useState<{ id: string; title: string }[]>([]);
  const setReferences = useCallback((next: SetStateAction<{ id: string; title: string }[]>) => {
    editRevision.current += 1;
    setReferencesRaw(next);
  }, []);
  const [referenceOptions, setReferenceOptions] = useState<{ id: string; title: string }[]>([]);
  const [failedSends, setFailedSends] = useState<FailedSend[]>([]);
  const failedSendSeq = useRef(0);
  const retryingSends = useRef(new Set<string>());
  const retryDeliveryIds = useRef(new Map<string, string>());
  const team = useThreadTeam(client, env.id, session.id);
  // The CLI's own subagents have no Helm session, so they ride on this one.
  const agentCount = team.length + (session.nativeCards?.length ?? 0);
  // A spawn step in the chat opens the helper it started, by the tool call
  // that started it or, for Codex, the thread the step names.
  const nativeCards = session.nativeCards;
  const openAgent = useCallback((item: Item) => {
    const card = onOpenNative && nativeCards?.find((agent) => agent.toolUseId === item.id || (!!item.agent?.id && agent.id === item.agent.id));
    return card ? () => onOpenNative!(card) : null;
  }, [nativeCards, onOpenNative]);
  useEffect(() => {
    let stale = false;
    client.rpc<{ sessions: Session[] }>(env.id, 'session.list', {}).then((result) => {
      if (!stale) setReferenceOptions((result.sessions ?? []).filter((item) => item.id !== session.id && !!item.driver && !item.archived).map(({ id, title }) => ({ id, title })));
    }).catch(() => {});
    return () => { stale = true; };
  }, [client, env.id, session.id]);
  /** The message a branch was asked for from, while the confirmation is up. */
  const [rewinding, setRewinding] = useState<{ turn: Turn; allowed: boolean; restore: boolean; reason?: string } | null>(null);
  const [branching, setBranching] = useState<Turn | null>(null);
  useDismiss(menu !== null, useCallback(() => setMenu(null), []));
  const [options, setOptions] = useState<ModelList | null>(null);
  const [commands, setCommands] = useState<{ name: string; description?: string; source?: string }[]>([]);
  const engine = ENGINE_LABEL[session.engine] ?? session.engine;
  const status = log.loaded ? log.status : session.status;
  // Starting is work in progress too: Stop is the useful button, and a
  // stale problem card from the last run is not.
  const childrenWorking = !!session.team?.working || team.some(({ session: child }) => ['working', 'starting'].includes(child.delegation?.status ?? child.status));
  // A repo still coming down is not the agent at work: nothing to stop
  // yet, and the chat reads as a new one you can already write in.
  const preparing = !!session.clone && session.clone.state !== 'done';
  const cloning = session.clone?.state === 'cloning';
  const working = (busyStatus(status) && !preparing) || childrenWorking;
  const [reviewingRequest, setReviewingRequest] = useState(() => session.ask?.requestId ?? '');
  useEffect(() => { setReviewingRequest(session.ask?.requestId ?? ''); }, [session.id]);
  const pending = log.pending.find(request => request.requestId === reviewingRequest) ?? log.pending[0];
  const permissionBox = useRef<HTMLDivElement>(null);
  // A question in the composer takes its free-text answer from the box you type in.
  const questionHandle = useRef<QuestionHandle | null>(null);
  const holdQuestion = useCallback((handle: QuestionHandle | null) => { questionHandle.current = handle; }, []);
  const reviewRequest = useCallback((requestId: string) => setReviewingRequest(requestId), []);
  useEffect(() => {
    if (!reviewingRequest || pending?.requestId !== reviewingRequest) return;
    permissionBox.current?.scrollIntoView({ block: 'nearest' });
    permissionBox.current?.querySelector<HTMLElement>('button:not(:disabled), input, textarea')?.focus({ preventScroll: true });
  }, [reviewingRequest, pending?.requestId]);
  const childrenWaiting = team.filter(({ session: child }) => (child.delegation?.status ?? child.status) === 'blocked' || !!child.pending);
  useEffect(() => {
    if (!reviewNative) return;
    if (logError) { setError(logError); setReviewNative(false); return; }
    if (!log.loaded) return;
    const request = log.pending.find(request => request.parentId);
    const item = [...log.turns.flatMap(turn => turn.items)].reverse().find(item =>
      request ? item.id === request.parentId
        : ['failed', 'error'].includes(item.agent?.status ?? '') || item.kind === 'subagent' && item.status === 'error');
    if (item) {
      setFocusItem({ id: item.id, visit: reviewChildren ?? 0 });
      if (request) reviewRequest(request.requestId);
      setReviewNative(false);
    } else if (earlier && !loadingEarlier) void loadEarlier();
    else if (!earlier && !loadingEarlier) {
      setError('The child task details are no longer available in this conversation.');
      setReviewNative(false);
    }
  }, [reviewNative, log, logError, earlier, loadingEarlier, loadEarlier, reviewChildren, reviewRequest]);
  // Queued messages are the daemon's outbox rendered in the composer, not
  // transcript turns: they only become a bubble once the agent echoes them.
  const queueOrder = new Map((session.queueOrder ?? []).map((id, index) => [id, index]));
  const queuedTurns = log.turns.filter((turn) => turn.queued && !turn.done).sort((left, right) => (queueOrder.get(left.id) ?? Infinity) - (queueOrder.get(right.id) ?? Infinity));
  const transcriptTurns = log.turns.filter((turn) => !turn.queued);

  // The catalogue this device last heard, then the machine's answer behind it.
  // Without the first half the model chip reads "default" and the picker is
  // empty until a CLI has been spawned and a round trip has come back.
  useEffect(() => { setOptions(null); }, [client, env.id, session.profileId, session.id]);
  useEffect(() => {
    let stale = false;
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
   * Picked, pasted or dropped files: images compressed in the browser,
   * anything else sent as it is, to be saved where the agent can read it.
   *
   * Every failure says so; all chosen files are prepared.
   */
  const onAttach = async (files: FileList | File[]) => {
    if (loadingImages || savingImages || sendingImages) return [];
    const chosen = Array.from(files);
    if (!chosen.length) return [];
    const failures: string[] = [];
    const next: typeof attachments = [];
    setPreparingImages((count) => count + 1);
    setError('');
    try {
      for (const f of chosen) {
        try {
          next.push(await prepareAttachment(f));
        } catch (e: any) {
          failures.push(`${f.name}: ${e?.message || 'it could not be read'}`);
        }
      }
      if (next.length) await setAttachments((current) => [...current, ...next]);
      if (failures.length) setError(`Not added — ${failures.join('; ')}`);
      return next;
    } finally {
      setPreparingImages((count) => Math.max(0, count - 1));
    }
  };
  const sendText = async (body: string, atts: Attachment[], sentReferences = references) => {
    const fingerprint = JSON.stringify([env.id, session.id, body, atts.map(a => [a.name, a.mime, a.data]), sentReferences.map(item => item.id)]);
    const messageId = retryDeliveryIds.current.get(fingerprint) ?? newMessageId();
    setSentFirst(true);
    setReferences([]);
    if (!atts.length) setDraft('');
    if (atts.length) setSendingImages(true);
    const clearedAt = editRevision.current;
    try {
      await client.input(env.id, { id: session.id, data: body, references: sentReferences.map((item) => item.id), attachments: atts.map(a => ({ filename: a.name, mime: a.mime, data: a.data })) }, 120_000, messageId);
      retryDeliveryIds.current.delete(fingerprint);
      if (atts.length) {
        if (editRevision.current === clearedAt) setDraft('');
        await setAttachments(current => current.filter(image => !atts.includes(image)));
      }
    }
    catch (e: any) {
      // An explicit rejection can start a new attempt on the owner's next
      // send. An unknown result must retain its original identity.
      const retryId = rejectedDelivery(e) ? newMessageId() : messageId;
      retryDeliveryIds.current.set(fingerprint, retryId);
      setError(e.message);
      setSentFirst(false);
      // Only restore the failed send if the composer is still exactly in the
      // state produced by clearing it. A newer draft or attachment edit -
      // including one from another pending send - belongs to the owner and
      // must not be overwritten by a late RPC failure.
      if (editRevision.current === clearedAt) {
        setDraft(body);
        setReferences(sentReferences);
      } else if (!atts.length) {
        // The owner has typed since: keep the words on a card of their own
        // rather than lose them. A slow failure may still have arrived.
        failedSendSeq.current += 1;
        const failed = { id: `failed-${failedSendSeq.current}`, messageId: retryId, body, references: sentReferences.map((item) => item.id), error: e.message };
        setFailedSends((current) => [...current, failed]);
      }
    } finally { if (atts.length) setSendingImages(false); }
  };
  /** Sends exactly what failed - never whatever is in the composer now. */
  const retryFailedSend = async (failed: FailedSend) => {
    if (retryingSends.current.has(failed.id)) return;
    retryingSends.current.add(failed.id);
    setFailedSends((current) => current.map((item) => item.id === failed.id ? { ...item, retrying: true } : item));
    try {
      await client.input(env.id, { id: session.id, data: failed.body, references: failed.references }, 120_000, failed.messageId);
      for (const [fingerprint, messageId] of retryDeliveryIds.current) {
        if (messageId === failed.messageId) retryDeliveryIds.current.delete(fingerprint);
      }
      setFailedSends((current) => current.filter((item) => item.id !== failed.id));
    } catch (e: any) {
      const messageId = rejectedDelivery(e) ? newMessageId() : failed.messageId;
      for (const [fingerprint, previous] of retryDeliveryIds.current) {
        if (previous === failed.messageId) retryDeliveryIds.current.set(fingerprint, messageId);
      }
      setFailedSends((current) => current.map((item) => item.id === failed.id ? { ...item, messageId, error: e.message, retrying: false } : item));
    } finally { retryingSends.current.delete(failed.id); }
  };
  const send = async () => {
    const body = expandPastes(draft.trim());
    if (preparingImages || loadingImages || savingImages || sendingImages) return;
    if (!body && !attachments.length) return;
    // Typing while a question is open answers it; the words are not a new message.
    if (pending?.kind === 'question' && body && !attachments.length && questionHandle.current) {
      if (questionHandle.current.submit(body) === 'sent') setDraft('');
      return;
    }
    // `/model` on its own means "let me choose", in every CLI: Helm's own
    // picker, not a line of usage text from the CLI.
    if (/^\/model$/i.test(body) && !attachments.length && controls.show('model')) {
      setDraft('');
      return;
    }
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
    // Send now may first have to wait for the CLI to stop its reply.
    try { await client.rpc(env.id, method, { id: session.id, turnId: turn.id, ...params }, method === 'session.send-now' ? 70_000 : undefined); return true; }
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
   * A model switch always breaks the provider's prompt cache: caches belong
   * to one model. Whether it is worth a question is Claude's to say where it
   * can: a running Claude prices the switch in its PreModelSwitch hook (is
   * the cache still warm, what writing it again costs), so the daemon asks
   * it first and comes back with `ask` only when it is warm and big. Helm's
   * own estimate below is only for chats no CLI speaks for - Codex, the ACP
   * agents, an older Claude, or a Claude whose process is not running.
   * A thinking-level change only asks when the CLI says it rewrites the
   * cache (`effortKeepsCache === false`); Helm does not guess for a CLI that
   * says nothing. The estimated size is the one the CLI reports now, so a
   * compacted chat is not priced at its old size. Below the threshold in
   * `recache.ts` none of this is worth a dialog.
   */
  const [ask, setAsk] = useState<null | 'kill' | 'rename' | { kind: Kind; value: string; warn: string }>(null);
  const [savingSetting, setSavingSetting] = useState<{ kind: Kind; value: string; preview: boolean } | null>(null);
  const settingInFlight = useRef(false);
  const change = async (kind: Kind, value: string, extra: Record<string, unknown> = {}) => {
    if (settingInFlight.current) return;
    settingInFlight.current = true;
    // Keep the choice local until acknowledged; other devices and the
    // permission policy still see the machine's accepted settings.
    setSavingSetting({ kind, value, preview: !extra.ask && (kind === 'model' || kind === 'effort' || kind === 'speed') });
    let noSignal = false;
    try {
      await call(async () => {
        const r: any = await client.rpc(env.id, RPC[kind], { id: session.id, [kind]: value, ...extra });
        if (r?.ask) { setAsk({ kind, value, warn: recacheWarning('model', r.ask, true) }); return; }
        if (r?.noSignal && kind === 'model') { noSignal = true; return; }
        if (r?.session) onSession(r.session);
      });
    } finally {
      settingInFlight.current = false;
      setSavingSetting(null);
    }
    if (noSignal) estimate('model', value);
  };
  const estimate = (kind: 'model' | 'effort', value: string) => {
    const size = session.context ? (session.context.compacted ? 0 : session.context.used) : undefined;
    const cost = recacheCost(log.turns, modelNow, session.engine, undefined, size);
    if (cost) setAsk({ kind, value, warn: recacheWarning(kind, cost) });
    else void change(kind, value, kind === 'model' ? { pick: true } : {});
  };
  const pick = (kind: Kind, value: string) => {
    if (kind === 'model' && session.modelSwitchSignal) { void change(kind, value, { pick: true, ask: true }); return; }
    if (kind === 'model' || (kind === 'effort' && session.effortKeepsCache === false)) { estimate(kind, value); return; }
    void change(kind, value);
  };
  const confirmPick = () => {
    if (typeof ask === 'object' && ask) {
      const { kind, value } = ask;
      setAsk(null);
      void change(kind, value, kind === 'model' ? { pick: true } : {});
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

  // Double-clicking the title in the header renames it in place; the menu's
  // "Rename thread" is the same thing for touch and keyboard.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const finishRename = (save: boolean) => {
    if (!renaming) return;
    setRenaming(false);
    const next = nameDraft.trim();
    if (save && next) void rename(next);
  };
  const folder = !session.brain && !session.quick && session.cwd ? session.cwd.replace(/\/+$/, '').split('/').pop() || '~' : '';

  // "Ping me when it finishes": one ring, once, the next time the thread
  // settles. New sessions start enabled; the owner can silence this thread.
  const toggleNotify = () => call(async () => {
    const r: any = await client.rpc(env.id, 'session.notify', { id: session.id, on: !session.notifyDone });
    onSession(r.session);
  });

  const all = options?.modes ?? [];
  const mode = all.find((m) => m.id === session.mode);

  // shift+tab, the way Claude Code does it at the keyboard. Every mode the
  // agent offers is on the ring, bypass included: the owner asked for it,
  // and the composer turns red the moment it lands there.
  const cycle = useCallback(() => {
    const ring = all;
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
  const taskList = stripTodos(transcriptTurns);
  const since = working && openTurn ? openTurn.at : session.updatedAt;
  const age = since ? waitingSince(since, now) : '';
  const rate = useTokenRate(openTurn, status === 'working');
  // The machine says so for every CLI; an older machine only has the item.
  const liveCompaction = working ? [...transcriptTurns].reverse().flatMap((turn) => turn.items)
    .find((item) => isCompaction(item) && item.status === 'streaming') : undefined;
  const compacting = working && (session.compacting || liveCompaction?.startedAt || !!liveCompaction);
  const chip = (s: string) => {
    const ago = age && age !== 'just now' ? ` ${age}` : '';
    return s === 'blocked' ? <span className="chip blocked"><i />waiting{ago}</span>
      : s === 'starting' ? <span className="chip working"><i />starting</span>
      : s === 'working' && compacting ? <span className="chip working"><i />compacting</span>
      : s === 'working' ? <span className="chip working"><i />working{ago}{rate ? ` · ${rate} tok/s` : ''}</span>
      // Its own turn is over, but child tasks are not: the sidebar calls
      // this working, so the open chat must not look finished.
      : childrenWorking ? <span className="chip working" title="Child tasks are still working"><i />working</span>
      : s === 'unknown' ? <span className="chip exited" title="The machine could not tell whether this agent is working">status unavailable</span>
      : null;
  };

  const prefs = trayPrefs({ client, env: env.id, engine: session.engine, profileId: session.profileId, options, setOptions, setError });
  const controls = Controls({ options,
    session: savingSetting?.preview ? { ...session, [savingSetting.kind]: savingSetting.value } : session,
    pending: savingSetting?.kind, busy, onPick: pick, ...prefs });
  // Pressed again over its own panel, the agents key closes it; over the
  // Git tab it switches to agents.
  useChatKeys({
    effort: () => controls.step('effort'),
    model: () => controls.step('model'),
    agents: () => setDetails((open) => open === 'agents' ? null : 'agents'),
  });
  const limits = useAccountLimits(client, env.id, session.engine, session.brain ? null : session.profileId, log.limits);
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
        keepApproved: true,
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
  // which is when something has usually just changed. A quick chat has no
  // folder of its own to ask about.
  const gitKey = working ? 'working' : `rest:${session.updatedAt ?? 0}`;
  const ownGit = useGitStatus(client, env, session.quick ? '' : session.cwd, gitKey);
  // A chat started in a folder that is not a Git project (a config folder, a
  // quick chat) often edits one somewhere else. That project is its Git.
  // The log is updated in place, so this is a walk back from the newest step
  // on each render, stopping at the first edit.
  const editedDir = lastEditedDir(log.turns);
  const otherGit = useGitStatus(client, env, ownGit.status?.repo ? '' : editedDir, gitKey);
  const git = !ownGit.status?.repo && otherGit.status?.repo ? otherGit : ownGit;
  // Empty when there is nowhere to read Git: a quick chat that has not edited anything.
  const gitCwd = git === otherGit ? otherGit.status?.root ?? editedDir : session.quick ? editedDir : session.cwd;
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

  // Nothing said yet: the composer sits mid-page under a greeting.
  const firstMessage = loaded && !logError && transcriptTurns.length === 0 && queuedTurns.length === 0
    && !sentFirst && !working && !pending && !session.external && (session.alive !== false || preparing) && failedSends.length === 0 && !session.recovery;
  const dockAnchor = useDockLift(firstMessage);

  return (
    <>
      <div className="bar session-bar">
        <button className="iconbtn back" aria-label={parentThread && onOpenSession ? 'Back to parent thread' : 'Back'}
          onClick={parentThread && onOpenSession ? openParent : onBack}><BackIcon /></button>
        <div className="titles">
          <div className="crumb">
            <EngineMark engine={session.engine} />
            {folder && <>
              <span className="crumb-folder" title={session.cwd}>{folder}</span>
              <span className="crumb-sep" aria-hidden="true">/</span>
            </>}
            {renaming ? (
              <input
                className="crumb-edit" aria-label="Thread name" value={nameDraft} maxLength={200}
                autoFocus onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => finishRename(true)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
                  else if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
                }}
              />
            ) : (
              <h1 className="crumb-title" title={session.title}
                onDoubleClick={() => { setNameDraft(session.title); setRenaming(true); }}>{session.title}</h1>
            )}
            <button className="crumb-more" aria-label="Thread options" title="Thread options" aria-haspopup="menu" aria-expanded={menu === 'more'}
              onClick={() => setMenu(menu === 'more' ? null : 'more')}><Icon name="down" size={14} /></button>
          </div>
          <span className="sub">
            <Route machine={env.name} quick={session.quick} />
            {session.nativeCodex && <span> · Live CLI</span>}
            {[session.brain ? engine : '', money(session.costUsd)].filter(Boolean).map((part) => (
              <span key={part}><span className="sep"> · </span>{part}</span>
            ))}
            {/* On a phone the folder leaves the title line to the title. */}
            {folder && <span className="sub-folder" title={session.cwd}><span className="sep"> · </span>{folder}</span>}
            {log.loaded && (logError || (!env.online && syncing))
              ? <span className="offline" role="status"> · Saved chat · reconnecting…</span>
              : syncing && !(cameUpEmpty && !log.loaded) && <span role="status"> · Syncing chat…</span>}
            {!env.online && !log.loaded && <span className="offline"> · machine offline</span>}
            {env.online && conn && !conn.online && !logError && (
              <span className="offline"> · live updates reconnecting…</span>
            )}
          </span>
        </div>
        {cloning ? <span className="chip working" role="status"><i />cloning {session.clone!.percent}%</span> : chip(status)}
        {/* Git gets its own button with the count of changed files: it is
            the thing most often checked. The other opens agents and repeats.
            It is always there, Git project or not: hiding it when a folder was
            not one made it vanish more than once. The sheet says why instead. */}
        {!session.brain && (
          <button className="iconbtn thread-details-launch" aria-label={changed > 0 ? `Git: ${changed} changed files` : 'Git'} title="Git graph and changes"
            onClick={() => setDetails('changes')}><Icon name="git" size={17} />{changed > 0 && <b className="cbadge">{changed > 99 ? '99+' : changed}</b>}</button>
        )}
        <button className="iconbtn thread-details-launch" aria-label="Agents" title="Agents"
          onClick={() => setDetails('agents')}><Icon name="subagents" size={17} />{agentCount > 0 && <b className="cbadge quiet">{agentCount}</b>}</button>
        <button className="iconbtn browser-launch" title="Browser (Ctrl/⌘ Shift B)" aria-label={browser.dot ? 'Browser: the agent opened a tab' : 'Browser'} aria-pressed={browser.open} onClick={browser.toggle}><Icon name="web" size={17} />{browser.dot && <b className="browser-new" aria-hidden="true" />}</button>
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
            {onSendFolder && <button disabled={!env.online} onClick={onSendFolder}>Send folder</button>}
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
      <span ref={dockAnchor} hidden />
      {firstMessage && <EmptyChat cwd={session.cwd} quick={session.quick} brain={session.brain} machine={env.name} agent={engine} model={options?.labels?.[modelNow] ?? modelNow} still={cameUpEmpty} />}
      <Transcript
        turns={transcriptTurns} status={status} loaded={log.loaded}
        readVisual={readVisual} openAgent={openAgent}
        pending={log.pending} onReviewRequest={reviewRequest} focusItem={focusItem}
        earlier={earlier} loadingEarlier={loadingEarlier} onEarlier={loadEarlier}
        onResend={resend} onWithdraw={withdraw}
        onRewind={session.rewindSupported && !working && !busy && !pending && !queuedTurns.length ? (turn) => {
          void call(async () => {
            const check = await client.rpc<{ restoreFiles: boolean; reason?: string }>(env.id, 'session.rewind-check', { id: session.id, turnId: turn.id });
            setRewinding({ turn, allowed: check.restoreFiles, restore: false, reason: check.reason });
          });
        } : undefined}
        onBranch={session.engine === 'claude' && onOpenSession ? setBranching : undefined}
        empty={preparing ? '' : session.alive === false ? 'This conversation resumes with your next message.' : sentFirst ? 'Waiting for the agent…' : undefined}
      />

      {failedSends.map((failed) => <div key={failed.id} className="thread-recovery failed-send" role="status"><div>
        <strong>Send not confirmed</strong>
        <p className="failed-send-text">{failed.body}</p>
        <p>{failed.error} — check the conversation before retrying</p>
      </div>
        <span className="failed-send-actions">
          <button disabled={failed.retrying} onClick={() => void retryFailedSend(failed)}>{failed.retrying ? 'Sending…' : 'Retry send'}</button>
          <button disabled={failed.retrying} onClick={() => setFailedSends((current) => current.filter((item) => item.id !== failed.id))}>Dismiss</button>
        </span>
      </div>)}
      <Composer
        onTranscribe={onTranscribe}
        draft={draft} setDraft={setDraft} onSend={send} onStop={stop} working={working}
        engine={engine} keys={false} waiting={!!pending} ask={pending ? (pending.kind === 'question' ? 'question' : 'approval') : undefined}
        shoulder={taskList && <TodoStrip todos={taskList} />}
        banner={pending && <div ref={permissionBox} className="ask-box"><PermissionSheet key={pending.requestId} variant="banner" permission={pending} onAnswer={answer} busy={busy} onHandle={holdQuestion} /></div>}
        danger={mode?.danger} compacting={compacting || undefined}
        foot={controls.chips} statusLine={account || limits.length > 0 || session.context ? <LimitsLine windows={limits} account={account} context={session.context && <ContextLimit client={client} env={env} machines={machines} session={session} />} /> : undefined} canAttach={canAttach} preparing={preparingImages > 0 || loadingImages || savingImages || sendingImages}
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
        onSendQueued={preparing ? undefined : (turn) => void queueAction(turn, 'session.send-now')}
        pendingLabel={preparing ? 'Once the repo is in' : messageDelivery(session.engine).pending}
        queueBusy={queueBusy}
        history={log.turns.map((turn) => splitNote(turn.text).text ?? '').filter(Boolean)}
      >
        {/* Above the input, not under it: below the composer it landed in
            the home-bar zone and pushed the input up. A tap dismisses it. */}
        {(error || (!log.loaded && logError)) && <div className="error floating" role="alert" onClick={() => setError('')}>{error || logError}</div>}
        {notice && !error && <div className="notice floating" role="status" onClick={() => setNotice('')}><Icon name="check" size={14} />{notice}</div>}
        {controls.sheet}
        {session.clone && session.clone.state !== 'done' && (
          <CloneCard clone={session.clone} agent={engine} waiting={queuedTurns.length} busy={busy} offline={!env.online}
            onRetry={() => void call(() => client.rpc(env.id, 'session.cloneRetry', { id: session.id }, 60_000))} />
        )}
        {/* A reply you stopped already says so in the chat ("You stopped
            after…"); a card asking to continue it was one more thing to dismiss. */}
        {session.recovery && session.recovery.kind !== 'interrupted' && !working && !pending && (
          <RecoveryCard key={session.recovery.at} recovery={session.recovery} busy={busy} offline={!env.online} onRetry={retry} autoResume={session.autoResumeLimited}
            onAutoResume={on => { void client.rpc(env.id, 'session.auto-resume', { id: session.id, on }).catch((e: any) => setError(e.message)); }} />
        )}
        {childrenWaiting.length > 0 && <div className="child-requests" role="group" aria-label="Subagents waiting for you">
          {childrenWaiting.map(({ session: child }) => <button key={child.id} disabled={!onOpenSession} onClick={() => onOpenSession?.(child)}>
            <Icon name="subagents" size={15} /><span><b>{child.title}</b><small>{child.ask?.kind === 'question' ? 'Answer question' : 'Review request'}{child.ask?.text ? ` · ${child.ask.text}` : ''}</small></span><Icon name="forward" size={14} />
          </button>)}
        </div>}
        {log.pending.length > 1 && <div className="child-requests" role="group" aria-label="Other requests waiting for you">
          {log.pending.filter(request => request.requestId !== pending?.requestId).map(request => <button key={request.requestId} onClick={() => reviewRequest(request.requestId)}>
            <Icon name="forward" size={14} /><span>{request.title}</span>
          </button>)}
        </div>}
      </Composer>

      {browser.open && <BrowserDock client={client} env={env} session={session} onClose={() => browser.setOpen(false)} />}
      {details && <ThreadDetails onNativeAttention={() => { setDetails(null); setReviewNative(true); }} reviewAttention={!!reviewChildren} key={reviewChildren} client={client} env={env} session={session} tab={details} git={git.status} gitCwd={gitCwd} reloadGit={git.reload} onClose={() => setDetails(null)}
        onOpen={onOpenSession ? (item) => { setDetails(null); onOpenSession(item); } : undefined}
        onOpenNative={onOpenNative ? (agent) => { setDetails(null); onOpenNative(agent); } : undefined} />}
      {editingQueue && <QueueEdit turn={editingQueue} busy={!!queueBusy} onCancel={() => setEditingQueue(null)} onSave={async (text, attachments) => {
        if (await queueAction(editingQueue, 'session.queue-edit', { text, attachments })) setEditingQueue(null);
      }} />}

      {rewinding && <Sheet label="Edit from here" onClose={() => { if (!busy) setRewinding(null); }}>
        <div className="modal-title">Edit from here?</div>
        <div className="modal-body">
          <p>This message and the replies after it will be removed. The message returns to your draft. The old history stays saved on the machine.</p>
          {(draft.trim() || attachments.length > 0) && <p>Your current draft will be replaced.</p>}
          <label className="rewind-files"><input type="checkbox" checked={rewinding.restore} disabled={!rewinding.allowed || busy} onChange={event => setRewinding({ ...rewinding, restore: event.target.checked })} />Put files back as they were before this message</label>
          <p>{rewinding.allowed ? 'This includes staged and new files. Ignored files stay.' : rewinding.reason}</p>
          {error && <p role="alert" className="error">{error}</p>}
        </div>
        <div className="modal-actions">
          <button className="ghost" disabled={busy} onClick={() => setRewinding(null)}>Cancel</button>
          <button className="primary" disabled={busy || working || !!pending || !!queuedTurns.length} onClick={() => {
            const choice = rewinding;
            void call(async () => {
              const result = await client.rpc<{ session: Session; draft: { text: string; attachments: { filename: string; mime: string; data: string }[]; references: string[] } }>(env.id, 'session.rewind', { id: session.id, turnId: choice.turn.id, restoreFiles: choice.restore }, 120_000);
              setDraft(splitNote(result.draft.text).text ?? result.draft.text);
              await setAttachments(result.draft.attachments.map(image => ({ name: image.filename || 'image', mime: image.mime, data: image.data, url: `data:${image.mime};base64,${image.data}` })));
              setReferences(result.draft.references.map(id => ({ id, title: referenceOptions.find(option => option.id === id)?.title ?? 'Thread' })));
              onSession(result.session);
              setRewinding(null);
              await refresh();
              setNotice('Conversation rewound. Edit your draft and send when ready.');
            });
          }}>{busy ? 'Rewinding…' : 'Edit from here'}</button>
        </div>
      </Sheet>}

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
          body={session.nativeCodex ? 'It stays in Codex and its terminal keeps running.' : 'The agent stops and this chat leaves Helm.'}
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

/**
 * The live tok/s for the turn being written, read once a second so the
 * figure holds still long enough to read. Null when nothing is streaming.
 */
function useTokenRate(turn: Turn | undefined, working: boolean): number | null {
  const samples = useRef<Sample[]>([]);
  const watching = useRef('');
  const chars = streamedChars(turn);
  useEffect(() => {
    const id = working ? turn?.id ?? '' : '';
    if (id !== watching.current) { watching.current = id; samples.current = []; }
    if (id) samples.current = addSample(samples.current, Date.now(), chars);
  }, [turn?.id, working, chars]);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!working) { setRate(null); return; }
    const timer = setInterval(() => setRate(tokensPerSecond(samples.current, Date.now())), 1000);
    return () => clearInterval(timer);
  }, [working]);
  return rate;
}
