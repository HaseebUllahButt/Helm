import { Client, type Environment, type Session } from '../client';
import { useDialog } from '../useDialog';
import { Icon } from '../Icon';
import { Subagents } from './Subagents';
import { ChangesPanel, type GitStatus } from './Changes';
import { Schedules } from './Schedules';

export type DetailsTab = 'changes' | 'commits' | 'agents' | 'schedules';

/**
 * Everything around a thread that is not the conversation: what it changed,
 * the commits, the helpers it started, and messages it sends itself on a
 * timer. One row of tabs and nothing else on top - the thread's own name and
 * settings are already on the screen behind it.
 */
export function ThreadDetails({ client, env, session, tab, onTab, git, reloadGit, agents = 0, onClose, onOpen }: {
  client: Client; env: Environment; session: Session; tab: DetailsTab; onTab: (tab: DetailsTab) => void;
  git: GitStatus | null; reloadGit: () => void; agents?: number; onClose: () => void;
  onOpen?: (session: Session) => void;
}) {
  const ref = useDialog(onClose);
  const changed = git?.repo ? (git.files?.length ?? 0) + (git.more ?? 0) : 0;
  const tabs: { id: DetailsTab; label: string; count?: number }[] = [
    ...(git?.repo ? [{ id: 'changes' as const, label: 'Changes', count: changed }, { id: 'commits' as const, label: 'Commits' }] : []),
    { id: 'agents', label: 'Agents', count: agents },
    { id: 'schedules', label: 'Repeat' },
  ];
  // A folder that stopped being a repository while the sheet was closed
  // leaves nothing at "changes"; land on the first tab there is.
  const shown = tabs.some((item) => item.id === tab) ? tab : tabs[0].id;
  return <div className="thread-details-back" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="thread-details" ref={ref} role="dialog" aria-modal="true" aria-label="Thread details" tabIndex={-1}>
      <span className="sheet-grip" aria-hidden="true" />
      <div className="details-heading">
        <div className="details-tabs" role="tablist" aria-label="Thread details sections">
          {tabs.map((item, index) => <button key={item.id} id={`details-${item.id}`} role="tab" aria-selected={shown === item.id} aria-controls="details-content" tabIndex={shown === item.id ? 0 : -1}
            onClick={() => onTab(item.id)} onKeyDown={(event) => {
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault(); onTab(tabs[next].id); document.getElementById(`details-${tabs[next].id}`)?.focus();
            }}>{item.label}{!!item.count && <span className="tab-count">{item.count > 99 ? '99+' : item.count}</span>}</button>)}
        </div>
        <button className="iconbtn details-close" aria-label="Close thread details" onClick={onClose}><Icon name="close" size={17} /></button>
      </div>
      <div className="details-content" role="tabpanel" id="details-content" aria-labelledby={`details-${shown}`}>
        {(shown === 'changes' || shown === 'commits') && git?.repo && <ChangesPanel embedded view={shown === 'commits' ? 'graph' : 'changes'}
          client={client} env={env} cwd={session.cwd} status={git} reload={reloadGit} onClose={onClose} onOpen={onOpen} />}
        {shown === 'agents' && <Subagents embedded client={client} env={env} parent={session} onClose={onClose} onOpen={onOpen} />}
        {shown === 'schedules' && <Schedules client={client} env={env} session={session} />}
      </div>
    </div>
  </div>;
}
