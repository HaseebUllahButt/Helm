import { errorMessage } from './errors';
import { useEffect, useState } from 'react';
import type { Client, Environment, Profile, Session } from './client';
import { BackIcon, Icon } from './Icon';
import { Confirm } from './Modal';
import { CodingTools } from './CodingTools';

/**
 * Which Helm each machine runs, and the two ways to bring in GitHub's.
 *
 * Nothing here is needed day to day: machines keep each other on the newest
 * version the owner saved, by themselves, over their own network. GitHub is
 * only ever asked for - either by an agent that brings it in and keeps the
 * owner's changes, or by replacing those changes (kept on a backup branch).
 */

type Outcome = { state: 'working' | 'done' | 'same' | 'refused' | 'failed'; text: string };

const order = (a: Environment, b: Environment) =>
  Number(b.kind === 'vm') - Number(a.kind === 'vm') || a.name.localeCompare(b.name);

const AGENT_TASK = `Update this Helm installation from GitHub.
Keep every change made here.
Fetch origin main.
Merge it into the current version.
Do not reset or discard anything.
Resolve conflicts so the local changes still work.
Run the tests (npm test).
Commit the result.
Do not push.
Helm rebuilds after the commit.
The other machines then get the new version automatically.`;

export function UpdatesView({ client, envs, onBack, onRefresh, onOpenSession }: {
  client: Client; envs: Environment[]; onBack: () => void; onRefresh: () => void;
  onOpenSession?: (envId: string, session: Session) => void;
}) {
  const [out, setOut] = useState<Record<string, Outcome>>({});
  const [replacing, setReplacing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sorted = [...envs].sort(order);
  const online = sorted.filter((e) => e.online && e.info.version);
  const newest = [...online].sort((a, b) => (b.info.version?.time ?? 0) - (a.info.version?.time ?? 0))[0];
  const versions = new Set(online.map((e) => e.info.version!.commit));

  // A machine that was updated restarts and reconnects on its own; ask again
  // for what it now says it runs.
  useEffect(() => {
    if (!Object.values(out).some((o) => o.state === 'done')) return;
    const timers = [9_000, 20_000, 40_000].map((ms) => setTimeout(onRefresh, ms));
    return () => timers.forEach(clearTimeout);
  }, [out, onRefresh]);

  const replaceAll = async () => {
    setReplacing(false); setBusy(true);
    for (const env of online) {
      setOut((o) => ({ ...o, [env.id]: { state: 'working', text: 'Helm is getting the GitHub version.' } }));
      try {
        const r: any = await client.rpc(env.id, 'env.update', { replace: true }, 300_000);
        setOut((o) => ({ ...o, [env.id]: r.updated
          ? { state: 'done', text: `Helm updated.${r.backup ? ` Your changes remain on ${r.backup}.` : ''}` }
          : { state: r.reason?.startsWith('already') ? 'same' : 'refused', text: r.reason?.startsWith('already') ? 'Helm already matches the GitHub version.' : errorMessage(r.reason, { machine: env.name, fallback: 'Helm did not update. Try again.' }) } }));
      } catch (e: any) {
        setOut((o) => ({ ...o, [env.id]: { state: 'failed', text: errorMessage(e, { machine: env.name }) } }));
      }
    }
    setBusy(false);
  };

  const askAgent = async () => {
    setAsking(false);
    const env = newest;
    if (!env?.info.version?.dir) { setError('No machine reported its Helm installation folder.'); return; }
    setBusy(true); setError('');
    try {
      const { profiles } = await client.rpc<{ profiles: Profile[] }>(env.id, 'profile.list');
      const profile = profiles.find((p) => p.engine === 'claude') ?? profiles.find((p) => p.engine === 'codex') ?? profiles.find((p) => p.engine !== 'shell');
      if (!profile) throw new Error(`No agent is set up on ${env.name}.`);
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start', { cwd: env.info.version.dir, profileId: profile.id }, 70_000);
      await client.rpc(env.id, 'session.input', { id: r.session.id, data: AGENT_TASK }, 70_000);
      onOpenSession?.(env.id, r.session);
    } catch (e: any) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <h1>Updates</h1>
          <span className="sub">{online.some((e) => e.info.version?.dirty || e.info.sync?.reason || e.info.sync?.diverged)
            ? 'Review the updates.' : versions.size > 1 ? 'Machines are updating.'
              : sorted.some((e) => !e.online) ? 'Offline machines will update later.'
                : 'All machines are up to date.'}</span>
        </div>
      </div>
      <div className="scroll"><div className="pad column">
        <div className="section">machines</div>
        <div className="rows plain">
          {sorted.map((env) => {
            const v = env.info.version;
            const o = out[env.id];
            const note = !env.online ? 'Offline'
              : !v ? 'This Helm version does not report its version.'
              : env.info.sync?.diverged ? `This machine and ${env.info.sync.with} have different changes. Ask your agent to combine them.`
              : env.info.sync?.reason ? errorMessage(env.info.sync.reason, { machine: env.name })
              : v.dirty ? 'This machine has unsaved changes. Helm will share them after you save them.'
              : newest && v.commit !== newest.info.version?.commit ? `This machine is updating from ${newest.name}.`
              : null;
            return (
              <div key={env.id} className="row tall">
                <span className={`mdot ${env.online ? 'on' : 'off'}`} />
                <span className="grow">
                  <span className="rt"><span className="rt-text">{env.name}</span></span>
                  <span className="rm">{v ? <><code>{v.commit}</code> · {v.subject}</> : 'Unknown version'}</span>
                  {(o?.text || note) && <span className={`rm wrap up-${o?.state ?? 'note'}`}>{o?.text ?? note}</span>}
                </span>
              </div>
            );
          })}
          {!sorted.length && <div className="empty quiet">No machines are paired.</div>}
        </div>

        {online.map((env) => <CodingTools key={env.id} client={client} env={env} />)}

        <div className="section">GitHub</div>
        <button className="action" disabled={busy || !newest} onClick={() => setAsking(true)}>
          <span className="plus"><Icon name="arrow-up" size={15} /></span>Ask my agent to update Helm
        </button>
        <p className="note">Your agent keeps your changes.</p>
        <button className="row" disabled={busy || !online.length} onClick={() => setReplacing(true)}>
          <span className="grow"><span className="rt destructive">Replace with GitHub’s version</span>
            <span className="rm">This replaces your changes on every machine. Helm saves a backup.</span></span>
        </button>
        {error && <div className="error">{error}</div>}
      </div></div>
      {asking && (
        <Confirm title="Ask your agent to update Helm?" confirmLabel="Start"
          body={`An agent on ${newest?.name ?? 'your newest machine'} combines the GitHub version with your changes. The agent saves the result. Your other machines then update.`}
          onCancel={() => setAsking(false)} onConfirm={askAgent} />
      )}
      {replacing && (
        <Confirm title="Replace with GitHub’s version?" confirmLabel="Replace" danger
          body="This replaces all your Helm changes. Helm saves a backup. Ask your agent to update Helm to keep your changes in use."
          onCancel={() => setReplacing(false)} onConfirm={replaceAll} />
      )}
    </>
  );
}
