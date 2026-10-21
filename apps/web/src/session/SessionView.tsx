import { useCopySelection } from '../useCopySelection';
import type { Transcribe } from './voice';
import { useDismiss } from '../useDismiss';
import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react';
import { Confirm, TextPrompt } from '../Modal';
import { recacheWarning, type Recache } from '@helm/usage/recache';
import { Markdown } from '../Markdown';
import { Composer } from './Composer';
import { Controls, trayPrefs, type Kind } from './Controls';
import { LimitsLine } from './LimitsLine';
import { ContextLimit } from './ContextLimit';
import { useAccountLimits } from './useAccountLimits';
import { nativeConversation } from './nativeView';
import { CompactionLine } from './Transcript';
import { VisualReply, Visuals, type VisualReader } from './VisualReply';
import { useChatKeys } from './chatKeys';
import { BrowserDock, useBrowserDock } from './BrowserDock';
import { Canvas, useCanvas } from './Canvas';
import { useExclusiveDocks } from './SideDock';
import { prepareAttachment } from './image';
import { useDraftImages } from './useDraftImages';
import { loadDraft, saveDraft } from '../draftStore';
import { userMessage } from './userMessage';
import { useGitStatus } from './gitStatus';
import { ThreadDetails, type DetailsTab } from './ThreadDetails';
import { useThreadTeam } from './TeamSummary';
import { ExternalSessionNotice } from './ExternalSessionNotice';
import { useSessionLog } from './useSessionLog';
import { PermissionSheet, type QuestionHandle } from './PermissionSheet';
import type { Decision } from './types';
import { EngineMark } from '../EngineMark';
import { BackIcon, Icon, toolKind } from '../Icon';
import { Route } from '../Route';
import { Client, chatFolder, type Environment, type Session, type Message, type ModelList, type NativeControl, type NativeAgent } from '../client';
import { followModelRefresh } from '../modelRefresh';
import { loadMessages, saveMessages } from './logCache';
import { engineOf } from '../engines';
import { useLiveInterval } from '../useLiveInterval';
import { StatusChip } from '../screens/ThreadRows';

/**
 * xterm is a third of this app's JavaScript and matters only once a terminal
 * is open, so it is fetched then rather than on every cold start. The wait is
 * hidden behind the round trip that opens the pty anyway.
 */
const Terminal = lazy(() => import('../Terminal').then((m) => ({ default: m.Terminal })));

export function SessionView({ client, env, machines, session, terminals = [], onSwitch, onNewTerminal, onBack, onClosed, onArchived, onSession, onTranscribe, onSendTask, onSendFolder, onOpenNative }: {
  client: Client; env: Environment; session: Session;
  /** Every machine, for settings that belong to the account. */
  machines?: Environment[];
  onSendTask?: () => void; onSendFolder?: () => void;
  onOpenNative?: (agent: NativeAgent) => void;
  /** This machine's open terminals, for the tabs above one. */
  terminals?: Session[];
  onSwitch?: (s: Session) => void;
  onNewTerminal?: () => Promise<void>;
  onBack: () => void; onClosed: () => void; onArchived: () => void; onSession: (s: Session) => void;
  /** Absent when no machine in the network holds a Groq key. */
  onTranscribe?: Transcribe;
}) {
  const isShell = session.engine === 'shell';
  const isExternal = !!session.external;
  const readVisual = useCallback((ref: string) => client.rpc<{ html: string }>(env.id, 'session.visual', { id: session.id, ref }, 60_000), [client, env.id, session.id]);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [readError, setReadError] = useState('');
  const reading = useRef(false), readAgain = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [raw, setRaw] = useState(isShell || !!session.nativeCli && !session.nativeChat && !nativeConversation(session.engine));
  // Git and Agents open the same panels a Helm chat has.
  const [details, setDetails] = useState<DetailsTab | null>(null);
  const team = useThreadTeam(client, env.id, session.id);
  const agentCount = team.length + (session.nativeCards?.length ?? 0);
  const browser = useBrowserDock(client, env, session, !isShell);
  // The canvas and the browser panel share the column beside the chat: one at a time.
  const canvas = useCanvas(env, session, !isShell);
  useExclusiveDocks(canvas, browser);
  const [status, setStatus] = useState(session.status);
  const [compacting, setCompacting] = useState(session.compacting || false);
  // When it entered the status it is in, for "working 14m" beside the word.
  const [statusAt, setStatusAt] = useState(session.updatedAt);
  const [draft, setDraft] = useState(() => loadDraft(env.id, session.id));
  useEffect(() => saveDraft(env.id, session.id, draft), [env.id, session.id, draft]);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  useDismiss(menu, useCallback(() => setMenu(false), []));
  const eng = engineOf(session.engine);
  // Git is read again whenever the chat starts or stops working, which is
  // when something has usually just changed. A quick chat has no folder.
  const git = useGitStatus(client, env, session.quick ? '' : session.cwd, status === 'working' ? 'working' : `rest:${statusAt ?? 0}`);
  const changed = git.status?.repo ? (git.status.files?.length ?? 0) + (git.status.more ?? 0) : 0;
  const changedPaths = useMemo(() => git.status?.files?.map((f) => f.path) ?? [], [git.status]);

  const [nativeOptions, setNativeOptions] = useState<ModelList | null>(null);
  const [nativeCommands, setNativeCommands] = useState<{ name: string; description?: string; source?: string }[]>([]);
  const [settingBusy, setSettingBusy] = useState(false);
  const [nativeNotice, setNativeNotice] = useState('');
  useEffect(() => {
    setNativeOptions(null); setNativeCommands([]);
    if (!session.nativeCli) return;
    let stale = false;
    const catalog = followModelRefresh(
      () => client.rpc<ModelList>(env.id, 'model.list', { id: session.id, profileId: session.profileId }, 30_000),
      (options) => {
        // The same tray a Helm chat has. `default` and `effort` stay empty:
        // the chips show what Claude itself reports, never an account guess.
        if (!stale && Array.isArray(options.models)) setNativeOptions({ ...options, default: null, effort: null, speeds: [], speedByModel: {} });
      },
      () => {},
    );
    const loadCommands = () => client.rpc<{ commands: typeof nativeCommands }>(env.id, 'session.commands', { id: session.id }, 20_000)
      .then((result) => { if (!stale) setNativeCommands(result.commands ?? []); }).catch(() => {});
    void loadCommands();
    const off = client.on((machine, kind, payload) => {
      if ((kind === 'connection' && payload?.online) || (machine === env.id && kind === 'presence' && payload?.online)) {
        void catalog.refresh(); void loadCommands();
      }
    });
    return () => { stale = true; catalog.stop(); off(); };
  }, [client, env.id, session.id, session.profileId, session.nativeCli, session.engineModel, session.permissionControl]);

  const nativeCommand = async (command: string) => {
    if (settingBusy || sending) return;
    setSettingBusy(true); setError('');
    try {
      await client.input(env.id, { id: session.id, data: command });
      setNativeNotice(command);
    } catch (e: any) { setError(e.message); }
    finally { setSettingBusy(false); }
  };
  // A model picked here is checked with Claude first: its PreModelSwitch
  // hook says whether the switch rewrites a warm cache, and only then does
  // Helm ask, with Claude's figures. Helm makes no estimate of its own here.
  const [switchAsk, setSwitchAsk] = useState<{ value: string; warn: string } | null>(null);
  const pickNative = async (kind: Kind, value: string, confirmed = false) => {
    if (settingBusy || sending || kind === 'speed' || status === 'blocked' || !env.online) return;
    setSettingBusy(true); setError('');
    try {
      const check = kind === 'model' && session.nativeChat && session.engine === 'claude' ? { pick: true, ...(confirmed ? {} : { ask: true }) } : {};
      const r = await client.rpc<{ session?: Session; ask?: Recache }>(env.id, `session.${kind}`, { id: session.id, [kind]: value, ...check }, 70_000);
      if (r?.ask) { setSwitchAsk({ value, warn: recacheWarning('model', r.ask, true) }); return; }
      // The machine reads Claude's footer after each shift+tab, so a mode
      // that comes back is one Claude is showing.
      if (kind === 'mode') { if (r?.session) onSession(r.session); }
      // Writing a command is not confirmation that Claude applied it.
      // Keep the reported setting and let the user inspect native output.
      else {
        setNativeNotice(`/${kind} ${value}`);
        if (!session.nativeChat) setRaw(true);
      }
    } catch (e: any) { setError(e.message); }
    finally { setSettingBusy(false); }
  };

  // Read back from the CLI's own transcript, so this chat costs a round trip
  // to say anything at all. Paint the copy on the device first: what you read
  // last time is a better opening than a blank screen, and the refresh behind
  // it is usually a second or two.
  const refresh = useCallback(async (): Promise<void> => {
    if (isShell || !mounted.current) return;
    if (reading.current) { readAgain.current = true; return; }
    reading.current = true;
    let success = false;
    try {
      const r = await client.rpc<{ messages: Message[]; status?: Session['status'] }>(env.id, 'session.messages', { id: session.id }, 15_000);
      if (!mounted.current) return;
      setMessages(r.messages);
      if (r.status) setStatus(r.status);
      setReadError(''); success = true;
      saveMessages(env.id, session.id, r.messages);
    } catch (e: any) { if (mounted.current) setReadError(e.message); }
    finally {
      reading.current = false;
      const again = readAgain.current; readAgain.current = false;
      if (success && again && mounted.current) void refresh();
    }
  }, [client, env.id, session.id, isShell]);

  useEffect(() => {
    if (isShell) return;
    let stale = false;
    loadMessages<Message>(env.id, session.id).then((cached) => {
      if (!stale && cached?.length) setMessages((now) => now ?? cached);
    });
    return () => { stale = true; };
  }, [env.id, session.id, isShell]);

  useEffect(() => {
    refresh();
    const off = client.on((e, kind, payload) => {
      if (kind === 'connection' && payload?.online) void refresh();
      if (e !== env.id) return;
      if (kind === 'transport' || (kind === 'presence' && payload?.online)) void refresh();
      if (kind === 'session.transcript' && payload?.id === session.id) refresh();
      if (kind === 'session.update' && payload.session?.id === session.id) {
        setStatus(payload.session.status);
        setCompacting(payload.session.compacting || false);
        setStatusAt(payload.session.updatedAt ?? Date.now());
        refresh();
      }
    });
    const catchUp = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', catchUp);
    window.addEventListener('online', catchUp);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      off(); window.removeEventListener('focus', catchUp); window.removeEventListener('online', catchUp);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, [client, env.id, session.id, refresh]);

  // The transcript events above are the live stream; the poll is only the
  // reconciliation for a frame that got lost, so it can be slow - and a
  // transcript whose process is gone cannot change at all.
  useLiveInterval(status === 'exited' ? null : 15_000, refresh, [status, refresh]);

  const [sending, setSending] = useState(false);
  const { images, setImages, loading: loadingImages, saving: savingImages } = useDraftImages<{ name: string; mime: string; data: string; url: string }>(env.id, session.id, setError);
  const [preparingImages, setPreparingImages] = useState(false);
  const imageBusy = useRef(false);
  const attachImages = async (files: FileList | File[]) => {
    if (imageBusy.current || sending || loadingImages || savingImages) return [];
    const picked = Array.from(files);
    if (!picked.length) return [];
    imageBusy.current = true; setPreparingImages(true); setError('');
    const ready: { name: string; mime: string; data: string; url: string }[] = [];
    const failures: string[] = [];
    try {
      for (const file of picked) {
        try { ready.push(await prepareAttachment(file)); }
        catch (e: any) { failures.push(`${file.name}: ${e.message}`); }
      }
      await setImages(current => [...current, ...ready]);
      if (failures.length) setError(`Not added — ${failures.join('; ')}`);
      return ready;
    } finally { imageBusy.current = false; setPreparingImages(false); }
  };
  const questionHandle = useRef<QuestionHandle | null>(null);
  const send = async () => {
    const body = draft;
    const attachments = images;
    if ((!body.trim() && !attachments.length) || sending || settingBusy || imageBusy.current || loadingImages || savingImages) return;
    // While Claude's question is on screen, typing is the answer to it.
    if (questionHandle.current && body.trim() && !attachments.length) {
      if (questionHandle.current.submit(body.trim()) === 'sent') setDraft('');
      return;
    }
    // `/model` on its own opens the model picker, as it does in a Helm chat.
    if (session.nativeCli && /^\/model$/i.test(body.trim()) && !attachments.length && nativeControls.show('model')) {
      setDraft('');
      return;
    }
    setSending(true); setError('');
    try {
      const result = await client.input(env.id, { id: session.id, data: body + '\n',
        ...(attachments.length ? { attachments: attachments.map(image => ({ filename: image.name, mime: image.mime, data: image.data })) } : {}) });
      setDraft(current => current === body ? '' : current);
      await setImages(current => current.filter(image => !attachments.includes(image)));
      if (session.nativeChat && (result?.terminal || body.trimStart().startsWith('/'))) setNativeNotice(body.trim());
      else setMessages((m) => m ? [...m, { role: 'user', text: body, tools: [], at: Date.now(),
        attachments: attachments.map(image => ({ filename: image.name, mime: image.mime, data: image.data })) }] : m);
      setTimeout(refresh, 600);
    } catch (e: any) { setError(e.message); }
    finally { setSending(false); }
  };

  const key = async (k: string) => {
    try { await client.rpc(env.id, 'session.keys', { id: session.id, keys: [k] }); }
    catch (e: any) { setError(e.message); }
  };

  const [killing, setKilling] = useState(false);
  const [naming, setNaming] = useState(false);
  const [opening, setOpening] = useState(false);
  const newTerminal = async () => {
    if (!onNewTerminal) return;
    setOpening(true);
    try { await onNewTerminal(); } catch (e: any) { setError(e.message); } finally { setOpening(false); }
  };

  const stopNative = async () => {
    try { await client.rpc(env.id, 'session.interrupt', { id: session.id }); }
    catch (e: any) { setError(e.message); }
  };

  const kill = async () => {
    try { await client.rpc(env.id, 'session.kill', { id: session.id }); onClosed(); }
    catch (e: any) { setError(e.message); }
  };

  // A terminal's own tab keys, the way a terminal app has them: Ctrl/Cmd+T a
  // new one, Ctrl/Cmd+W closes this one, Ctrl(+Shift)+Tab walks them. Taken
  // before xterm sees them, so the shell's Ctrl+W (delete a word) and Ctrl+T
  // give way here. Only the Helm app window gets these keys; an ordinary
  // browser tab keeps them for itself.
  const terminalKeys = useRef({ newTerminal, kill, terminals, session, onSwitch, opening });
  terminalKeys.current = { newTerminal, kill, terminals, session, onSwitch, opening };
  useEffect(() => {
    if (!isShell) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.isComposing || document.querySelector('[aria-modal="true"]')) return;
      const { newTerminal, kill, terminals, session, onSwitch, opening } = terminalKeys.current;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (event.key === 'Tab' && event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        const at = terminals.findIndex((t) => t.id === session.id);
        if (terminals.length < 2 || at < 0) return;
        const next = terminals[(at + (event.shiftKey ? -1 : 1) + terminals.length) % terminals.length];
        onSwitch?.(next);
      } else if (mod && !event.shiftKey && key === 't') {
        event.preventDefault(); event.stopPropagation();
        if (!opening) void newTerminal();
      } else if (mod && !event.shiftKey && key === 'w') {
        event.preventDefault(); event.stopPropagation();
        void kill();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isShell]);

  const archive = async () => {
    setMenu(false);
    try { await client.rpc(env.id, 'session.archive', { id: session.id, archived: !session.archived }); onArchived(); }
    catch (e: any) { setError(e.message); }
  };

  // Terminals are named by the machine ("Terminal 3") and agents by their
  // first prompts; both are guesses worth correcting.
  const renameThread = async (next: string) => {
    if (next === session.title) return;
    try {
      const r: any = await client.rpc(env.id, 'session.title', { id: session.id, title: next });
      onSession(r.session);
    } catch (e: any) { setError(e.message); }
  };

  const nativeProfile = nativeOptions?.profileId ?? session.profileId;
  const limits = useAccountLimits(client, env.id, session.engine, nativeProfile);

  const nativePrefs = trayPrefs({ client, env: env.id, engine: session.engine, profileId: nativeOptions?.profileId,
    options: nativeOptions, setOptions: setNativeOptions, setError });
  const openNativeControl = async (kind: NativeControl) => {
    if (settingBusy || sending || status === 'blocked' || status === 'working' || !env.online) return;
    setSettingBusy(true); setError('');
    try {
      await client.rpc(env.id, 'session.control', { id: session.id, kind }, 70_000);
      setRaw(true);
    } catch (e: any) { setError(e.message); }
    finally { setSettingBusy(false); }
  };
  const nativeControls = Controls({ options: nativeOptions, session,
    busy: settingBusy || sending || status === 'blocked' || (!session.nativeChat && status === 'working') || !env.online,
    onPick: pickNative, onNativeControl: openNativeControl, ...nativePrefs });
  // The same keys as a Helm chat, wherever this tray is shown.
  useChatKeys(session.nativeCli ? {
    effort: () => nativeControls.step('effort'),
    model: () => nativeControls.step('model'),
    ...(session.nativeChat ? { agents: () => setDetails((open) => open === 'agents' ? null : 'agents') } : {}),
  } : {});

  useEffect(() => {
    if (!session.nativeChat || raw) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
        || settingBusy || sending || status === 'blocked' || !env.online
        || document.querySelector('[aria-modal="true"]')) return;
      const ring = (nativeOptions?.modes ?? []).filter(mode => mode.id !== 'plan');
      if (ring.length < 2) return;
      event.preventDefault();
      const at = ring.findIndex(mode => mode.id === session.mode);
      void pickNative('mode', ring[(at + 1) % ring.length].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session.nativeChat, session.mode, raw, nativeOptions, settingBusy, sending, status, env.online]);


  const composer = (ask: { banner?: ReactNode; ask?: 'question' | 'approval' } = {}) => (
    <Composer
      {...ask}
      onTranscribe={onTranscribe}
      draft={draft} setDraft={setDraft} onSend={send} onKey={key}
      // The phone key row is for typing into a plain terminal; an agent chat
      // has its own controls. A terminal Pi stops on Esc (sessions.interrupt).
      keys={isShell} preparing={sending || preparingImages || loadingImages || savingImages}
      commands={session.nativeCli ? nativeCommands : undefined}
      foot={session.nativeCli ? nativeControls.chips : undefined}
      statusLine={nativeProfile || limits.length || session.context ? <LimitsLine windows={limits} account={nativeProfile || undefined} context={session.context && <ContextLimit client={client} env={env} machines={machines} session={session} />} /> : undefined}
      compacting={compacting || undefined}
      onAttach={session.nativeChat ? attachImages : undefined} attachments={images}
      onRemoveAttachment={index => setImages(current => current.filter((_, i) => i !== index))}
      canAttach={!!session.nativeChat}
      onAttachUnsupported={() => setError('This terminal cannot receive images through chat. Open a Claude or Codex chat to attach images.')}
      waiting={status === 'blocked'} engine={eng.label}
      working={status === 'working' || status === 'blocked'}
      onStop={session.nativeCli && session.engine === 'pi' ? stopNative : undefined}
      history={(messages ?? []).filter((message) => message.role === 'user').map((message) => message.text)}
    >
      {nativeControls.sheet}
      {switchAsk && (
        <Confirm
          title="Change it anyway?"
          body={switchAsk.warn}
          confirmLabel="Change" busy={settingBusy}
          onCancel={() => setSwitchAsk(null)}
          onConfirm={() => { const { value } = switchAsk; setSwitchAsk(null); void pickNative('model', value, true); }}
        />
      )}
      {(error || (!messages && readError)) && <div className="error floating" role="alert" onClick={() => setError('')}>{error || readError}</div>}
    </Composer>
  );

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub">
            <EngineMark engine={eng.cls} />
            <Route machine={env.name} folder={chatFolder(session)} quick={session.quick} />
            <span className="sep"> · </span>{eng.label}{(session as any).model ? ` · ${(session as any).model}` : ''}
            {!isShell && messages && (readError || !env.online) && <span className="offline" role="status"> · Saved chat · reconnecting…</span>}
          </span>
        </div>
        <StatusChip status={compacting && status === 'working' ? 'compacting' : status} at={statusAt} />
        {/* Git is in every chat's header, as in a Helm chat, terminal or not.
            Hiding it here made it look gone. The sheet says when there is no Git. */}
        <button className="iconbtn thread-details-launch" aria-label={changed > 0 ? `Git: ${changed} changed files` : 'Git'} title="Git graph and changes"
          onClick={() => setDetails('changes')}><Icon name="git" size={17} />{changed > 0 && <b className="cbadge">{changed > 99 ? '99+' : changed}</b>}</button>
        {!isShell && <button className="iconbtn" title="Canvas: notes and docs (Ctrl/⌘ Shift D)" aria-label="Canvas" aria-pressed={canvas.open}
          onClick={() => { if (!canvas.open) browser.setOpen(false); canvas.toggle(); }}><Icon name="canvas" size={17} /></button>}
        {!isShell && <button className="iconbtn browser-launch" title="Browser (Ctrl/⌘ Shift B)" aria-label={browser.dot ? 'Browser: the agent opened a tab' : 'Browser'} aria-pressed={browser.open} onClick={() => { if (!browser.open) canvas.setOpen(false); browser.toggle(); }}><Icon name="web" size={17} />{browser.dot && <b className="browser-new" aria-hidden="true" />}</button>}
        {!isShell && !isExternal && (
          <button className="iconbtn" title={raw ? 'conversation' : 'terminal'} aria-label={raw ? 'show the conversation' : 'show the terminal'} onClick={() => setRaw((v) => !v)}>
            <Icon name={raw ? 'raw' : 'terminal'} size={18} />
          </button>
        )}
        {/* A Claude terminal chat starts Helm helpers like any chat. Another
            CLI's terminal only lists the helpers that CLI ran itself. */}
        {!isShell && (session.nativeChat || !!session.nativeCards?.length) && (
          <button className="iconbtn thread-details-launch" aria-label="Agents" title="Agents" onClick={() => setDetails('agents')}>
            <Icon name="subagents" size={17} />{agentCount > 0 && <b className="cbadge quiet">{agentCount}</b>}
          </button>
        )}
        {isShell && onNewTerminal && (
          <button className="iconbtn" title="New terminal" aria-label="New terminal" disabled={opening} onClick={() => void newTerminal()}>
            <Icon name="plus" size={18} />
          </button>
        )}
        <button className="iconbtn" title="more" aria-label="more" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><Icon name="more" size={18} /></button>
        {menu && (isShell ? (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={() => setNaming(true)}>Rename terminal</button>
            {onSendFolder && <button disabled={!env.online} onClick={onSendFolder}>Send folder</button>}
            <button className="destructive" onClick={() => setKilling(true)}>Close terminal</button>
          </div>
        ) : (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={() => setNaming(true)}>Rename thread</button>
            {session.nativeChat && <>
              <button disabled={settingBusy || sending || status === 'blocked' || !env.online} onClick={() => void nativeCommand('/permissions')}>Claude permissions</button>
              <button disabled={settingBusy || sending || status === 'blocked' || !env.online} onClick={() => void nativeCommand('/config')}>Claude settings</button>
            </>}
            {onSendFolder && <button disabled={!env.online} onClick={onSendFolder}>Send folder</button>}
            {!isExternal && onSendTask && <button disabled={!env.online} onClick={onSendTask}>Send task to another machine</button>}
            <button onClick={archive}>{session.archived ? 'Unarchive thread' : 'Archive thread'}</button>
            <button className="destructive" onClick={() => setKilling(true)}>{session.nativeCli ? 'End session' : 'Delete thread'}</button>
          </div>
        ))}
      </div>

      {details && <ThreadDetails client={client} env={env} session={session} tab={details} nativeOnly={!session.nativeChat}
        git={git.status} gitCwd={session.quick ? '' : session.cwd} reloadGit={git.reload} onClose={() => setDetails(null)}
        onOpenNative={onOpenNative ? (agent) => { setDetails(null); onOpenNative(agent); } : undefined} />}
      {!isShell && (canvas.open
        ? <Canvas client={client} env={env} cwd={session.quick ? '' : session.cwd} changed={changedPaths} path={canvas.path} onPath={canvas.setPath} onClose={() => canvas.setOpen(false)} />
        : browser.open && <BrowserDock client={client} env={env} session={session} onClose={() => browser.setOpen(false)} />)}

      {/* Every open terminal on this machine, one tap apart. */}
      {isShell && terminals.length > 1 && (
        <div className="termtabs" role="tablist" aria-label="Open terminals">
          {terminals.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === session.id}
              className={t.id === session.id ? 'on' : undefined}
              onClick={() => { if (t.id !== session.id) onSwitch?.(t); }}>
              <Icon name="terminal" size={13} />{t.title}
            </button>
          ))}
        </div>
      )}

      {naming && (
        <TextPrompt
          title={isShell ? 'Name this terminal' : 'Name this thread'} value={session.title}
          onCancel={() => setNaming(false)} onSubmit={renameThread}
        />
      )}
      {killing && (
        <Confirm
          title={isShell ? `Close "${session.title}"?` : session.nativeCli ? `End "${session.title}"?` : `Delete "${session.title}"?`}
          body={isShell
            ? 'Anything still running in it stops.'
            : session.nativeCli ? 'This stops the same CLI running on your laptop. Closing this view leaves it running.' : 'The agent stops and this chat leaves Helm.'}
          confirmLabel={isShell ? 'Close' : session.nativeCli ? 'End session' : 'Delete'} danger
          onCancel={() => setKilling(false)}
          onConfirm={() => { setKilling(false); kill(); }}
        />
      )}

      <ExternalSessionNotice session={session}
        onTakeOver={(cancel) => client.rpc(env.id, 'session.takeover', { id: session.id, cancel }, 20_000)} />
      {raw
        ? <Suspense fallback={<div className="xterm-host" />}>
            <Terminal client={client} env={env.id} sessionId={session.id} />
          </Suspense>
        : <Chat messages={messages} status={status} compacting={compacting} readVisual={readVisual} />}

      {session.nativeChat && raw && !session.nativeCli && <NativeClaudeApprovals client={client} env={env.id} sessionId={session.id} />}
      {session.nativeChat && !raw && nativeNotice && (
        <div className="composer-wrap"><div className="composer-col">
          <div className="banner native-command" role="status">
            <span>Sent <code>{nativeNotice}</code> to {eng.label}.</span>
            <button className="ghost" onClick={() => setRaw(true)}>View in terminal</button>
            <button className="iconbtn" aria-label="Dismiss command notice" onClick={() => setNativeNotice('')}><Icon name="close" size={14} /></button>
          </div>
        </div></div>
      )}
      {(!raw || session.nativeCli) && (session.nativeChat
        ? <NativeClaudeApprovals client={client} env={env.id} sessionId={session.id} handle={questionHandle}>{composer}</NativeClaudeApprovals>
        : composer())}
      {raw && !session.nativeCli && error && <div className="error floating" role="alert" onClick={() => setError('')}>{error}</div>}
    </>
  );
}

function NativeClaudeApprovals({ client, env, sessionId, handle, children }: {
  client: Client; env: string; sessionId: string;
  /** Where a question banner leaves the way to answer it with what is typed in the composer. */
  handle?: React.MutableRefObject<QuestionHandle | null>;
  /** With a render function the request becomes the top of that composer; without, it stands alone. */
  children?: (ask: { banner?: ReactNode; ask?: 'question' | 'approval' }) => ReactNode;
}) {
  const { log, refresh } = useSessionLog(client, env, sessionId);
  const pending = log.pending[0];
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const answer = async (decision: Decision) => {
    if (!pending) return;
    setBusy(true); setError('');
    try { await client.rpc(env, 'session.answer', { id: sessionId, requestId: pending.requestId, decision }); await refresh(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const hold = useCallback((h: QuestionHandle | null) => { if (handle) handle.current = h; }, [handle]);
  if (children) {
    return <>{children({
      ask: pending ? (pending.kind === 'question' ? 'question' : 'approval') : undefined,
      banner: pending ? <div className="ask-box">
        <PermissionSheet key={pending.requestId} variant="banner" permission={pending} busy={busy} onAnswer={d => void answer(d)} onHandle={hold} />
        {error && <div className="error" role="alert">{error}</div>}
      </div> : undefined,
    })}</>;
  }
  if (!pending && !error) return null;
  return <div className="composer-wrap"><div className="composer-col">
    {pending && <PermissionSheet key={pending.requestId} permission={pending} busy={busy} onAnswer={d => void answer(d)} />}
    {error && <div className="error" role="alert">{error}</div>}
  </div></div>;
}

function Chat({ messages, status, compacting = false, readVisual }: { messages: Message[] | null; status: string; compacting?: number | boolean; readVisual?: VisualReader }) {
  const box = useRef<HTMLDivElement>(null);
  useCopySelection(box);
  const stuck = useRef(true);
  const [unread, setUnread] = useState(false);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stuck.current) setUnread(false);
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    else setUnread(true);
  }, [messages, status]);

  const jump = () => {
    const el = box.current;
    if (el) { el.scrollTop = el.scrollHeight; stuck.current = true; setUnread(false); }
  };

  return (
    <div className="chat-wrap">
      <div className="chat" ref={box} onScroll={onScroll}>
        <div className="timeline">
          {messages === null && <p className="placeholder">Loading the conversation…</p>}
          {messages?.length === 0 && (
            <p className="placeholder">
              {status === 'blocked' || status === 'working'
                ? 'No messages yet. The terminal view shows what it is doing.'
                : 'Send a message to start the conversation.'}
            </p>
          )}
          <Visuals.Provider value={readVisual}>{messages?.map((m, i) => <Turn key={m.sourceId ?? i} m={m} />)}</Visuals.Provider>
          {compacting ? <CompactionLine live />
            : status === 'working' && <div className="working"><span className="shine">Working…</span></div>}
        </div>
      </div>
      {unread && <button className="jump" onClick={jump}><Icon name="arrow-down" size={14} />new</button>}
    </div>
  );
}

function Turn({ m }: { m: Message }) {
  if (m.visual) return <div className="turn assistant"><VisualReply visual={m.visual} /></div>;
  if (m.role === 'user') {
    const display = userMessage(m.text, m.attachments);
    return (
      <div className="turn user">
        <div className="bubble">{!!display.attachments?.length && <div className="turn-images">{display.attachments.map((a, i) => a.data
          ? <img key={i} className="turn-image" src={`data:${a.mime};base64,${a.data}`} alt={a.filename} title={`Image #${i + 1}${a.filename ? ` · ${a.filename}` : ''}`} loading="lazy" decoding="async" />
          : <span key={i} className="turn-image-gone"><Icon name="image" size={14} /> {a.filename} — no longer stored</span>
        )}</div>}{display.text}</div>
      </div>
    );
  }
  // Every step folds into one line you can open, whatever the count.
  const kinds = new Map<string, number>();
  for (const t of m.tools) { const k = toolKind(t.name); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  const word = (k: string, n: number) => k === 'read' ? (n === 1 ? 'Read 1 file' : `Read ${n} files`)
    : k === 'edit' ? (n === 1 ? 'Edited 1 file' : `Edited ${n} files`)
    : k === 'run' ? (n === 1 ? 'Ran 1 command' : `Ran ${n} commands`)
    : k === 'search' ? (n === 1 ? 'Searched' : `Searched ${n} times`)
    : (n === 1 ? 'Used 1 tool' : `Used ${n} tools`);
  const summary = [...kinds].map(([k, n]) => word(k, n)).join(' · ');
  const many = m.tools.length > 1;
  const rows = m.tools.map((t, j) => (
    <div key={j} className="act">
      <span className="aicon"><Icon name={toolKind(t.name)} size={15} /></span>
      <span className="alabel"><b>{t.name}</b>{t.input && <> {t.input}</>}</span>
    </div>
  ));
  return (
    <div className="turn assistant">
      {m.tools.length > 0 && (many
        ? <details className="actgroup"><summary><span className="aicon"><Icon name="tool" size={15} /></span><span className="alabel">{summary}</span><span className="achev"><Icon name="forward" size={13} /></span></summary>{rows}</details>
        : rows)}
      {m.text && <Markdown text={m.text} className="prose" />}
      {!m.text && !m.tools.length && m.thinking && <div className="act"><span className="aicon"><Icon name="think" size={15} /></span><span className="alabel">Thinking</span></div>}
    </div>
  );
}
