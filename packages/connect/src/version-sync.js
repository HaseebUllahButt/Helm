import { M } from '@helm/protocol';

/** Automatic updates come from the owner's machines; GitHub needs a request. */
export async function synchronizeVersion({ running, currentVersion, rebuildIfCommitted,
  rebuildStaleApp, syncFromBundle, net, id, rpc }) {
  const mine = await currentVersion();
  if (!mine) return { note: { reason: 'Cannot determine the installed Helm version.' } };
  if (mine.dirty) return { note: { reason: 'Local changes are blocking automatic updates. Save and publish them to update every machine.' } };
  if (running && mine.full !== running) {
    const result = await rebuildIfCommitted(running);
    if (result.updated || result.reason === 'an update is already running') return { ...result, note: null };
  }
  // The checkout can move during an update's build or restart; the app then
  // lags the code it runs, and nothing else would rebuild it.
  if (running && mine.full === running) await rebuildStaleApp?.(running).catch(() => {});
  const peers = await Promise.all(Object.keys(net.machines ?? {}).filter((peer) => peer !== id).map((peer) =>
    rpc(net, peer, M.ENV_INFO, {}, { timeout: 8000, budget: 8000 })
      .then((info) => ({ id: peer, name: info.name, v: info.version }), () => null)));
  const newer = peers.filter((p) => p?.v?.full && p.v.full !== mine.full && p.v.time > mine.time)
    .sort((a, b) => b.v.time - a.v.time);
  let divergence = null, fetchError = null;
  for (const peer of newer) {
    let bundle;
    try { ({ bundle } = await rpc(net, peer.id, M.ENV_BUNDLE, { have: [mine.full] }, { timeout: 120_000, budget: 120_000 })); }
    catch (error) { fetchError = error; continue; }
    if (!bundle) continue;
    const result = await syncFromBundle(bundle);
    if (result.diverged) {
      divergence ??= { ...result, note: { diverged: true, with: peer.name ?? peer.id } };
      continue;
    }
    // An update may have started or changed the checkout. Never try another
    // bundle after any result other than a proven divergence.
    return { ...result, note: result.updated || result.reason === 'an update is already running' ? null : { reason: result.reason } };
  }
  if (divergence) return divergence;
  if (fetchError) throw fetchError;
  return { note: null };
}
