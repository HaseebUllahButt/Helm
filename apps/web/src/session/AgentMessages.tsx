import { useEffect, useState } from 'react';
import type { Client, Session } from '../client';
import { Markdown } from '../Markdown';

type Address = { env: string; id: string; title: string; engine: string; model: string | null };
type Message = { id: string; from: Address; to: Address; text: string; replyTo: string | null; asUser: boolean;
  at: number; status: string; error?: string };
type Listing = { messages: Message[]; next: string | null };

/** Read the exchanges without copying any agent's full conversation. */
export function AgentMessages({ client, envId, parent, children }: { client: Client; envId: string; parent: Session; children: Session[] }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing>({ messages: [], next: null });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => client.on((env, kind, payload: any) => {
    if (env === envId && (kind === 'connection' || kind === 'agent.message'
      && payload?.sessionIds?.some((id: string) => id === parent.id || children.some(c => c.id === id)))) setRevision(n => n + 1);
  }), [client, envId, parent.id, children]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    client.rpc<Listing>(envId, 'session.agent-messages', { id: parent.id })
      .then(result => { if (!stale) { setListing(now => ({ ...result, messages: [...new Map([...now.messages, ...result.messages].map(m => [m.id, m])).values()].sort((a,b) => b.at-a.at), next: now.messages.length > 30 ? now.next : result.next })); setError(''); } })
      .catch(e => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [client, envId, parent.id, open, revision]);
  const older = async () => {
    setLoading(true); setError('');
    try {
      const result = await client.rpc<Listing>(envId, 'session.agent-messages', { id: parent.id, before: listing.next });
      setListing(now => ({ ...result, messages: [...new Map([...now.messages, ...result.messages].map(m => [m.id, m])).values()].sort((a,b) => b.at-a.at) }));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };
  return <section className="agent-exchanges">
    <button className="delegation-new" aria-expanded={open} onClick={() => setOpen(!open)}>Messages between agents</button>
    {open && <div className="agent-exchanges-body">
      {error && <p className="error" role="alert">{error}</p>}
      {!listing.messages.length && !error && <p className="note">This chat has no messages.</p>}
      <ol className="agent-exchange-list">{listing.messages.map(message => <li key={message.id}>
        <b>{message.asUser ? 'You' : `${message.from.title} (${message.from.engine})`} → {message.to.title} ({message.to.engine})</b>
        <small>{new Date(message.at).toLocaleString()} · {message.status === 'delivered' ? 'Delivered' : message.status === 'sending' ? 'Sending' : 'Not confirmed'}{message.replyTo ? ' · Reply' : ''}</small>
        {message.replyTo && <details><summary>In reply to</summary><p>{listing.messages.find(m => m.id === message.replyTo)?.text ?? `Load earlier messages to see message ${message.replyTo}.`}</p></details>}
        <Markdown text={message.text} />
        {message.error && <p className="error">{message.error}</p>}
      </li>)}</ol>
      {listing.next && <button className="ghost" disabled={loading} onClick={() => void older()}>{loading ? 'Loading…' : 'Earlier messages'}</button>}
    </div>}
  </section>;
}
