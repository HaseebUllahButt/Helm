import { useEffect, useState } from 'react';
import type { Client, Environment, NativeAgent, NativeAgentDetail, Session } from '../client';
import { EngineMark } from '../EngineMark';
import { BackIcon } from '../Icon';
import { Transcript } from './Transcript';
import { apply, emptyLog, type HelmEvent, type LogState } from './types';

const POLL_MS = 3000;

/**
 * One of Claude Code's own subagents, opened like any chat: its whole
 * conversation, read from the file Claude writes. Helm cannot message or
 * stop it, so there is no composer - only a line saying where it runs.
 */
export function NativeAgentView({ client, env, parent, agent, onBack }: {
  client: Client; env: Environment; parent: Session; agent: NativeAgent; onBack: () => void;
}) {
  const [log, setLog] = useState<LogState>(emptyLog);
  const [card, setCard] = useState<NativeAgent>(agent);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, seen = '';
    const load = async () => {
      try {
        const r = await client.rpc<{ agent: NativeAgentDetail; events: HelmEvent[]; more?: boolean }>(
          env.id, 'session.native-agent', { id: parent.id, agentId: agent.id, full: true }, 30_000);
        if (stopped) return;
        setError('');
        setCard(r.agent);
        // Redrawn whole each time it moves: the file is the only record.
        const stamp = `${r.agent.status}:${r.agent.updatedAt}:${r.events.length}`;
        if (stamp !== seen) {
          seen = stamp;
          const next = emptyLog();
          for (const event of r.events) apply(next, event);
          next.loaded = true;
          setLog(next);
          setMore(!!r.more);
        }
        if (r.agent.status === 'working' || r.agent.status === 'blocked') timer = setTimeout(load, POLL_MS);
      } catch (failure) {
        if (stopped) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setLog((current) => current.loaded ? current : { ...current, loaded: true });
        timer = setTimeout(load, POLL_MS * 3);
      }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [client, env.id, parent.id, agent.id]);

  const working = card.status === 'working' || card.status === 'blocked';
  const state = { working: 'Working', blocked: 'Waiting for approval', done: 'Finished', error: 'Failed', interrupted: 'Stopped' }[card.status] ?? card.status;

  return (
    <>
      <div className="bar session-bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <div className="crumb">
            <EngineMark engine="claude" />
            <h1 className="crumb-title" title={card.title}>{card.title}</h1>
          </div>
          <span className="sub">{[state, card.agentType || 'subagent', card.model || 'Claude default'].join(' · ')}</span>
        </div>
      </div>
      {error && <p className="error native-error" role="alert">{error}</p>}
      <Transcript
        turns={log.turns} status={working ? 'working' : 'idle'} loaded={log.loaded}
        empty={working ? 'Waiting for the subagent…' : 'This subagent left no messages.'}
      />
      <p className="native-foot" role="note">
        {more && <>Showing the latest part. </>}
        Claude Code started this helper inside <b>{parent.title || 'its chat'}</b>. You can read it here; message or stop it from that chat.
      </p>
    </>
  );
}
