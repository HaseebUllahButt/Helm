import { useEffect, useState } from 'react';
import type { Client, Environment } from './client';
import { BackIcon, Icon } from './Icon';

/**
 * Which helm each machine runs, and a way to bring them all to the newest.
 *
 * An update is a git reset and a restart on the machine itself, so this only
 * ever asks: the machine decides whether it may (a clean checkout on main),
 * and says why when it will not. The VM goes first - a machine that has been
 * upgraded refuses to link to a hub that has not, so the always-on hub has to
 * be the newest thing in the network before anything else moves.
 */

type Outcome = { state: 'working' | 'done' | 'same' | 'refused' | 'failed'; text: string };

const order = (a: Environment, b: Environment) =>
  Number(b.kind === 'vm') - Number(a.kind === 'vm') || a.name.localeCompare(b.name);

/** "already at 3871d20" and "checkout is on HEAD, not main" read fine as they are. */
const said = (reason?: string) => (reason ? reason.replace(/^already at .*/, 'already the newest') : 'not updated');

export function UpdatesView({ client, envs, onBack, onRefresh }: {
  client: Client; envs: Environment[]; onBack: () => void; onRefresh: () => void;
}) {
  const [out, setOut] = useState<Record<string, Outcome>>({});
  const [all, setAll] = useState(false);
  const sorted = [...envs].sort(order);
  const versions = new Set(sorted.filter((e) => e.online && e.info.version).map((e) => e.info.version!.commit));

  // A machine that was updated restarts and reconnects on its own; ask again
  // for what it now says it runs.
  useEffect(() => {
    if (!Object.values(out).some((o) => o.state === 'done')) return;
    const timers = [9_000, 20_000, 40_000].map((ms) => setTimeout(onRefresh, ms));
    return () => timers.forEach(clearTimeout);
  }, [out, onRefresh]);

  const one = async (env: Environment) => {
    setOut((o) => ({ ...o, [env.id]: { state: 'working', text: 'updating…' } }));
    try {
      const r = await client.updateEnv(env.id);
      setOut((o) => ({
        ...o,
        [env.id]: r.updated
          ? { state: 'done', text: 'updated - restarting safely' }
          : { state: r.reason?.startsWith('already') ? 'same' : 'refused', text: said(r.reason) },
      }));
    } catch (e: any) {
      setOut((o) => ({ ...o, [env.id]: { state: 'failed', text: e.message } }));
    }
  };

  const everything = async () => {
    setAll(true);
    for (const env of sorted) {
      if (env.online && env.info.version?.updatable) await one(env);
    }
    setAll(false);
  };

  const canAny = sorted.some((e) => e.online && e.info.version?.updatable);

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <h1>Updates</h1>
          <span className="sub">{versions.size > 1 ? `${versions.size} versions in use` : 'which helm each machine runs'}</span>
        </div>
      </div>
      <div className="scroll"><div className="pad column">
        <button className="action" disabled={!canAny || all} onClick={everything}>
          <span className="plus"><Icon name="arrow-up" size={15} /></span>{all ? 'updating…' : 'Update every machine'}
        </button>
        <p className="note">
          The VM goes first. A machine only updates if its helm is a clean checkout of main; one that is
          pinned to a release, or being developed on, says so and is left alone.
        </p>

        <div className="section">machines</div>
        <div className="rows plain">
          {sorted.map((env) => {
            const v = env.info.version;
            const o = out[env.id];
            const note = !env.online ? 'offline'
              : !v ? 'version unknown - an older helm, update it by hand once'
              : !v.updatable ? (v.branch === 'main' ? 'has local changes' : `pinned (${v.branch === 'HEAD' ? 'a release checkout' : v.branch})`)
              : null;
            return (
              <div key={env.id} className="row tall">
                <span className={`mdot ${env.online ? 'on' : 'off'}`} />
                <span className="grow">
                  <span className="rt"><span className="rt-text">{env.name}</span>{env.kind && <span className="tag">{env.kind}</span>}</span>
                  <span className="rm">{v ? <><code>{v.commit}</code> · {v.subject}</> : 'unknown version'}</span>
                  {(o?.text || note) && <span className={`rm wrap up-${o?.state ?? 'note'}`}>{o?.text ?? note}</span>}
                </span>
                {env.online && v?.updatable && (
                  <button
                    className="linkish" disabled={all || o?.state === 'working'}
                    onClick={() => one(env)}
                  >{o?.state === 'working' ? '…' : 'update'}</button>
                )}
              </div>
            );
          })}
          {!sorted.length && <div className="empty quiet">No machines are paired yet</div>}
        </div>
      </div></div>
    </>
  );
}
