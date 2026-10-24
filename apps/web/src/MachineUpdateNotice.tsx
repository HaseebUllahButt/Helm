import { errorMessage } from './errors';
import type { Environment } from './client';

export function MachineUpdateNotice({ envs, onOpen }: { envs: Environment[]; onOpen: () => void }) {
  const blocked = envs.filter((e) => e.online && (e.info.version?.dirty || e.info.sync?.reason || e.info.sync?.diverged));
  if (!blocked.length) return null;
  return <div className="banner warn native-command" role="status">
    <span>Helm cannot update on {blocked.map((e) => e.name).join(', ')}.
      {' '}{blocked[0].info.sync?.reason ? errorMessage(blocked[0].info.sync.reason, { machine: blocked[0].name }) : (blocked[0].info.version?.dirty
        ? 'This machine has unsaved changes.' : 'Combine its changes before the update.')}</span>
    <button className="ghost" onClick={onOpen}>Review updates</button>
  </div>;
}
