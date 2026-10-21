import { M } from '@helm/protocol';

/** Automatic updates come from the owner's machines; GitHub needs a request. */
export async function synchronizeVersion({ running, currentVersion, rebuildIfCommitted,
  syncFromBundle, net, id, rpc }) {
  const mine = await currentVersion();
  if (!mine) return { note: { reason: 'Cannot determine the installed Helm version.' } };
  if (mine.dirty) return { note: { reason: 'Local changes are blocking automatic updates. Save and publish them to update every machine.' } };
  if (running && mine.full !== running) {
    const result = await rebuildIfCommitted(running);
    if (result.updated || result.reason === 'an update is already running') return { ...result, note: null };
  }
  const peers = await Promise.all(Object.keys(net.machines ?? {}).filter((peer) => peer !== id).map((peer) =>
    rpc(net, peer, M.ENV_INFO, {}, { timeout: 8000, budget: 8000 })
      .then((info) => ({ id: peer, name: info.name, v: info.version }), () => null)));
  const newer = peers.filter((p) => p?.v?.full && p.v.full !== mine.full && p.v.time > mine.time)
    .sort((a, b) => b.v.time - a.v.time)[0];
  if (!newer) return { note: null };
  const { bundle } = await rpc(net, newer.id, M.ENV_BUNDLE, { have: [mine.full] }, { timeout: 120_000, budget: 120_000 });
  if (!bundle) return { note: null };
  const result = await syncFromBundle(bundle);
  return { ...result, note: result.diverged ? { diverged: true, with: newer.name ?? newer.id }
    : result.updated || result.reason === 'an update is already running' ? null : { reason: result.reason } };
}
