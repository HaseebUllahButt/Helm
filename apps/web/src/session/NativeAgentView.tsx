import { useEffect, useState } from 'react';
import type { Client, Environment, NativeAgent, NativeAgentDetail, Session } from '../client';
import { EngineMark } from '../EngineMark';
import { BackIcon } from '../Icon';
import { Composer } from './Composer';
import { Transcript } from './Transcript';
import { apply, emptyLog, type HelmEvent, type LogState } from './types';

const POLL_MS = 3000;
// After a message goes in, the parent passes it on and the helper wakes:
// keep looking that long even while its record still says finished.
const AFTER_SEND_MS = 90_000;

/**
 * One of the CLI's own subagents, opened like any chat: its whole
 * conversation, read from the record its CLI keeps. A message typed here
 * reaches the helper (Codex directly; the others through the chat that
 * started it, with their own tool for that), and it carries on with
 * everything it knew.
 */
export function NativeAgentView({ client, env, parent, agent, onBack }: {
  client: Client; env: Environment; parent: Session; agent: NativeAgent; onBack: () => void;
}) {
  const [log, setLog] = useState<LogState>(emptyLog);
  const [card, setCard] = useState<NativeAgent>(agent);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState(0);

  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, seen = '';
    const load = async () => {
      try {
        const r = await client.rpc<{ agent: NativeAgentDetail; events: HelmEvent[]; more?: boolean }>(
          env.id, 'session.native-agent', { id: parent.id, agentId: agent.id, full: true }, 30_000);
        if (stopped) return;
        setError('');
        setCard(r.agent);
        // Redrawn whole each time it moves: the record is the only one.
        const stamp = `${r.agent.status}:${r.agent.updatedAt}:${r.events.length}`;
        if (stamp !== seen) {
          seen = stamp;
          const next = emptyLog();
          for (const event of r.events) apply(next, event);
          next.loaded = true;
          setLog(next);
          setMore(!!r.more);
        }
        if (r.agent.status === 'working' || r.agent.status === 'blocked' || Date.now() - sentAt < AFTER_SEND_MS) timer = setTimeout(load, POLL_MS);
      } catch (failure) {
        if (stopped) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLog((current) => current.loaded ? current : { ...current, loaded: true });
        timer = setTimeout(load, POLL_MS * 3);
      }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [client, env.id, parent.id, agent.id, sentAt]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true); setError('');
    try {
      await client.rpc(env.id, 'session.native-message', { id: parent.id, agentId: agent.id, data: text }, 70_000);
      setDraft('');
      setSentAt(Date.now());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSending(false); }
  };

  const engine = card.engine ?? agent.engine ?? parent.engine;
  const working = card.status === 'working' || card.status === 'blocked';
  const state = { working: 'Working', blocked: 'Waiting for approval', done: 'Finished', error: 'Failed', interrupted: 'Stopped' }[card.status] ?? card.status;
  const canMessage = card.canMessage ?? agent.canMessage;

  return (
    <>
      <div className="bar session-bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <div className="crumb">
            <EngineMark engine={engine} />
            <h1 className="crumb-title" title={card.title}>{card.title}</h1>
          </div>
          <span className="sub">{[state, card.agentType || 'helper', card.model || 'Agent default'].join(' · ')}</span>
        </div>
      </div>
      {error && <p className="error native-error" role="alert">{error}</p>}
      <Transcript
        turns={log.turns} status={working ? 'working' : 'idle'} loaded={log.loaded}
        empty={working ? 'Waiting for the helper…' : 'This helper left no messages.'}
      />
      {more && <p className="native-foot" role="note">Showing the latest part.</p>}
      {canMessage ? (
        <Composer
          draft={draft} setDraft={setDraft} engine={engine} keys={false} canAttach={false} preparing={sending}
          onSend={() => void send()}
          statusLine={<span className="native-foot-line">{engine === 'codex'
            ? 'Send directly to this helper'
            : <>Sent through <b>{parent.title || 'the main chat'}</b></>}</span>}
        />
      ) : (
        <p className="native-foot" role="note">
          {card.fromLog || !parent.driver && !parent.nativeChat
            ? <>Started inside <b>{parent.title || 'its chat'}</b>. Message it from that chat.</>
            : <>This agent program cannot send messages to its helpers.</>}
        </p>
      )}
    </>
  );
}
