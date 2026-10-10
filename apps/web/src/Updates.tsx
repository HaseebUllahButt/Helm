import { useEffect, useState } from 'react';
import type { Client, Environment, Profile, Session } from './client';
import { BackIcon, Icon } from './Icon';
import { Confirm } from './Modal';

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

const AGENT_TASK = `Update this Helm install from GitHub while keeping every change made here.
Fetch origin main, then merge it into the current version (do not reset or discard anything).
Resolve any conflicts in favour of keeping the local customisations working, run the tests
(npm test), and commit the result. Do not push. When it is committed, Helm rebuilds itself and
the other machines pick the new version up on their own.`;

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
      setOut((o) => ({ ...o, [env.id]: { state: 'working', text: 'getting GitHub’s version…' } }));
      try {
        const r: any = await client.rpc(env.id, 'env.update', { replace: true }, 300_000);
        setOut((o) => ({ ...o, [env.id]: r.updated
          ? { state: 'done', text: `updated${r.backup ? ` - your changes are kept on ${r.backup}` : ''}` }
          : { state: r.reason?.startsWith('already') ? 'same' : 'refused', text: r.reason?.replace(/^already at .*/, 'already GitHub’s version') ?? 'not updated' } }));
      } catch (e: any) {
        setOut((o) => ({ ...o, [env.id]: { state: 'failed', text: e.message } }));
      }
    }
    setBusy(false);
  };

  const askAgent = async () => {
    setAsking(false);
    const env = newest;
    if (!env?.info.version?.dir) { setError('No machine said where its Helm is installed.'); return; }
    setBusy(true); setError('');
    try {
      const { profiles } = await client.rpc<{ profiles: Profile[] }>(env.id, 'profile.list');
      const profile = profiles.find((p) => p.engine === 'claude') ?? profiles.find((p) => p.engine === 'codex') ?? profiles.find((p) => p.engine !== 'shell');
      if (!profile) throw new Error(`No AI tool is set up on ${env.name}.`);
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start', { cwd: env.info.version.dir, profileId: profile.id }, 70_000);
      await client.rpc(env.id, 'session.input', { id: r.session.id, data: AGENT_TASK }, 70_000);
      onOpenSession?.(env.id, r.session);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <h1>Updates</h1>
          <span className="sub">{online.some((e) => e.info.version?.dirty || e.info.sync?.reason || e.info.sync?.diverged)
            ? 'updates need attention' : versions.size > 1 ? 'catching up'
              : sorted.some((e) => !e.online) ? 'offline machines catch up when they reconnect'
                : 'every machine on your newest version'}</span>
        </div>
      </div>
      <div className="scroll"><div className="pad column">
        <p className="note">
          Your machines check GitHub and each other for new versions automatically, including after
          restarting or reconnecting. Local edits are preserved and shown here when they block an update.
        </p>

        <div className="section">machines</div>
        <div className="rows plain">
          {sorted.map((env) => {
            const v = env.info.version;
            const o = out[env.id];
            const note = !env.online ? 'offline'
              : !v ? 'version unknown - an older Helm'
              : env.info.sync?.diverged ? `has its own changes, and so does ${env.info.sync.with} - ask your agent to combine them`
              : env.info.sync?.reason ? env.info.sync.reason
              : v.dirty ? 'unsaved changes here - shared once saved'
              : newest && v.commit !== newest.info.version?.commit ? `catching up with ${newest.name}`
              : null;
            return (
              <div key={env.id} className="row tall">
                <span className={`mdot ${env.online ? 'on' : 'off'}`} />
                <span className="grow">
                  <span className="rt"><span className="rt-text">{env.name}</span></span>
                  <span className="rm">{v ? <><code>{v.commit}</code> · {v.subject}</> : 'unknown version'}</span>
                  {(o?.text || note) && <span className={`rm wrap up-${o?.state ?? 'note'}`}>{o?.text ?? note}</span>}
                </span>
              </div>
            );
          })}
          {!sorted.length && <div className="empty quiet">No machines are paired yet</div>}
        </div>

        <div className="section">GitHub</div>
        <button className="action" disabled={busy || !newest} onClick={() => setAsking(true)}>
          <span className="plus"><Icon name="arrow-up" size={15} /></span>Let my agent update it
        </button>
        <p className="note">Your agent brings in GitHub’s new version and keeps your changes. Recommended.</p>
        <button className="row" disabled={busy || !online.length} onClick={() => setReplacing(true)}>
          <span className="grow"><span className="rt destructive">Replace with GitHub’s version</span>
            <span className="rm">Overrides your changes to Helm on every machine. A backup is kept.</span></span>
        </button>
        {error && <div className="error">{error}</div>}
      </div></div>
      {asking && (
        <Confirm title="Let your agent update Helm?" confirmLabel="Start"
          body={`An agent on ${newest?.name ?? 'your newest machine'} merges GitHub’s version into yours and saves it. Your other machines follow.`}
          onCancel={() => setAsking(false)} onConfirm={askAgent} />
      )}
      {replacing && (
        <Confirm title="Replace with GitHub’s version?" confirmLabel="Replace" danger
          body="This overrides every change made to Helm on your machines, including your agent's. They are kept on a backup branch and can be brought back. To keep them instead, let your agent update it."
          onCancel={() => setReplacing(false)} onConfirm={replaceAll} />
      )}
    </>
  );
}
