import { useEffect, useMemo, useState } from 'react';
import { useNow } from '../useNow';
import type { Client, Environment } from '../client';
import { EngineMark } from '../EngineMark';
import { BackIcon, Icon } from '../Icon';
import { Route } from '../Route';
import { draftChat, onStartingChat, retryChat, sendWhenReady, startingChat, unsendChat } from '../startingChats';
import { Composer } from './Composer';
import { EmptyChat, useDockLift } from './EmptyChat';
import { LimitsLine } from './LimitsLine';
import { Transcript } from './Transcript';
import { apply, emptyLog } from './types';
import { useAccountLimits } from './useAccountLimits';

/**
 * A new chat in the second or so before its agent is up: the chat itself,
 * saying so. You can write and send straight away - the message shows as
 * sent and goes in the moment the agent is ready. If it cannot start, the
 * reason shows here with a way to try again, and nothing typed is lost.
 */
export function StartingChatView({ client, env, startId, onBack }: {
  client: Client; env: Environment; startId: string; onBack: () => void;
}) {
  const [saveError, setSaveError] = useState('');
  const safely = (run: () => void) => { try { run(); setSaveError(''); } catch { setSaveError('Cannot save this chat. Keep your text and try again.'); } };
  const [, redraw] = useState(0);
  const chat = startingChat(startId);
  const [draft, setDraftRaw] = useState(() => chat?.draft ?? '');

  useEffect(() => onStartingChat((c) => { if (c.id === startId) { setDraftRaw(c.draft); redraw((n) => n + 1); } }), [startId]);
  // A second counter only once the wait is long enough to wonder about.
  const now = useNow(1000, chat?.state === 'starting');

  const message = chat?.message ?? '';
  const turns = useMemo(() => {
    if (!message) return [];
    const log = emptyLog();
    apply(log, { seq: 1, at: Date.now(), type: 'turn.start', turnId: 'local-starting', text: message });
    return log.turns;
  }, [message]);

  const dockAnchor = useDockLift(!!chat && !message);
  // The live chat's row under the composer, here already, so the box does not shift when it opens.
  const limits = useAccountLimits(client, env.id, chat?.engine ?? '', chat?.profileId);

  if (!chat) {
    return (
      <>
        <div className="bar session-bar">
          <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
          <div className="titles"><h1 className="crumb-title">New chat</h1></div>
        </div>
        <p className="starting-note">This chat is open. Find it in the list.</p>
      </>
    );
  }

  const failed = chat.state === 'failed';
  const waited = Math.floor((now - chat.since) / 1000);
  const setDraft = (text: string) => { setDraftRaw(text); safely(() => draftChat(startId, text)); };

  return (
    <>
      <div className="bar session-bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <div className="crumb">
            <EngineMark engine={chat.engine} />
            <h1 className="crumb-title" title={chat.folder ?? chat.title}>{chat.title}</h1>
          </div>
          <span className="sub">
            <Route machine={env.name} quick={!chat.folder} />
            <span><span className="sep"> · </span>{chat.account}</span>
          </span>
        </div>
        {failed
          ? <span className="chip exited">didn't start</span>
          : <span className="chip working" role="status"><i />starting{waited >= 3 ? ` · ${waited}s` : ''}</span>}
      </div>
      {failed && (
        <div className="starting-failed" role="alert">
          <p><b>The agent did not start.</b> {chat.error}</p>
          <div className="starting-actions">
            <button className="primary" onClick={() => retryChat(client, startId)}><Icon name="refresh" size={14} />Try again</button>
            <button className="ghost" onClick={onBack}>Close</button>
          </div>
        </div>
      )}
      <span ref={dockAnchor} hidden />
      {/* The same page an empty chat shows, so nothing moves once it is up. */}
      {!message && (
        <EmptyChat cwd={chat.folder ?? undefined} quick={!chat.folder} machine={env.name} agent={chat.agent}
          note={!failed && <span className="starting-line" role="status"> · <Icon name="think" size={12} />starting…</span>} />
      )}
      <Transcript turns={turns} status="idle" loaded empty="" onWithdraw={failed || !message || chat.session ? undefined : () => safely(() => unsendChat(startId))} />
      {message && !failed && <p className="starting-note" role="status"><Icon name="think" size={12} />Sends as soon as {chat.agent} is ready.</p>}
      {saveError && <p role="alert" className="error">{saveError}</p>}
      <Composer
        draft={draft} setDraft={setDraft} engine={chat.engine} keys={false}
        canAttach={false} statusLine={<LimitsLine windows={limits} account={chat.profileId} />}
        onSend={() => { if (draft.trim()) safely(() => sendWhenReady(startId, draft)); }}
      />
    </>
  );
}
