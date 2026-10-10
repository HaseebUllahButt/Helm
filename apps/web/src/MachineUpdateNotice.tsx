import type { Environment } from './client';

export function MachineUpdateNotice({ envs, onOpen }: { envs: Environment[]; onOpen: () => void }) {
  const blocked = envs.filter((e) => e.online && (e.info.version?.dirty || e.info.sync?.reason || e.info.sync?.diverged));
  if (!blocked.length) return null;
  return <div className="banner warn native-command" role="status">
    <span>Helm updates need attention on {blocked.map((e) => e.name).join(', ')}.
      {' '}{blocked[0].info.sync?.reason ?? (blocked[0].info.version?.dirty
        ? 'Local changes are blocking automatic updates.' : 'Versions have diverged; combine the local changes to continue updating.')}</span>
    <button className="ghost" onClick={onOpen}>Review updates</button>
  </div>;
}
