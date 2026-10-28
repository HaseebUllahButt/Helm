import { useState } from 'react';
import { connectionChecks, connectionSupport, type ConnectionRoutes } from '@helm/protocol/connection-report';
import type { Client, Environment } from './client';

type Result = { name: string; routes?: ConnectionRoutes; failed?: boolean };

export function ConnectionCheck({ client, envs }: { client: Client; envs: Environment[] }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [saved, setSaved] = useState(false);
  const run = async () => {
    setBusy(true); setSaved(false); setResults(null);
    const next = await Promise.all(envs.map(async env => {
      try {
        const routes = await client.rpc(env.id, 'net.routes', {}, 8000) as ConnectionRoutes;
        if (!Array.isArray(routes?.machines)) throw new Error('No report');
        return { name: env.name, routes };
      } catch { return { name: env.name, failed: true }; }
    }));
    setResults(next); setBusy(false);
  };
  const download = () => {
    const report = { checkedAt: new Date().toISOString(), liveConnection: client.connected,
      machines: results?.map((r, i) => ({ machine: `Machine ${i + 1}`, ...(r.routes
        ? connectionSupport(r.routes) : { failed: true }) })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'helm-connection-report.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  };
  return <section className="column" aria-label="Check connection">
    <button className="row" onClick={run} disabled={busy}>{busy ? 'Checking connections…' : 'Check connection'}</button>
    {results && <div className="column" aria-live="polite">
      <p className="note">{client.connected ? 'This device has a live connection to a Helm home.'
        : 'This device has no live connection. Read requests may still work.'}</p>
      {results.length === 0 && <p className="note">No machines are available to check. Reconnect to a Helm home.</p>}
      {results.map((result, i) => <div key={i}>
        <div className="section">{result.name}</div>
        {result.failed ? <p className="note">This device cannot read this machine through a Helm home.
          Check that the machine is awake. Run helm doctor there.</p> : <>
          <p className="note">This machine answers through a Helm home.</p>
          {connectionChecks(result.routes!).map(c => <p className="note" key={c.id}>{c.message}{c.action && <> {c.action}</>}</p>)}
          {!!result.routes!.history?.length && <details className="note"><summary>Recent connection changes</summary>
            {result.routes!.history.slice(-10).reverse().map((event, n) => <p key={n}>
              {result.routes!.machines.find(m => m.env === event.env)?.name ?? 'Removed machine'}: {' '}
              {event.state === 'connected' ? 'connection found' : event.state === 'disconnected' ? 'connection lost' : 'connection path changed'}
              {' · '}{new Date(event.at).toLocaleString()}</p>)}
          </details>}
        </>}
      </div>)}
      <button className="row" onClick={download}>Save support report</button>
      <p className="note">The report removes machine names, addresses, passwords, pairing links, and chat content.</p>
      {saved && <p className="note">Support report saved.</p>}
    </div>}
  </section>;
}
