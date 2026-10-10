import { Client, type Environment, type Session } from '../client';
import { useDialog } from '../useDialog';
import { Icon } from '../Icon';
import { Subagents } from './Subagents';
import { ChangesPanel, type GitStatus } from './Changes';
import { Schedules } from './Schedules';

export type DetailsTab = 'agents' | 'changes' | 'schedules';

export function ThreadDetails({ client, env, session, tab, onTab, git, reloadGit, onClose, onOpen, reviewAttention = false, onNativeAttention }: {
  client: Client; env: Environment; session: Session; tab: DetailsTab; onTab: (tab: DetailsTab) => void;
  git: GitStatus | null; reloadGit: () => void; onClose: () => void;
  onOpen?: (session: Session) => void; reviewAttention?: boolean; onNativeAttention?: () => void;
}) {
  const ref = useDialog(onClose);
  const tabs: { id: DetailsTab; label: string }[] = [{ id: 'changes', label: 'Git' }, { id: 'agents', label: 'Agents' }, { id: 'schedules', label: 'Schedules' }];
  if (tab === 'changes' && git?.repo) return <div className="thread-details-back" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="thread-details git-details" ref={ref} role="dialog" aria-modal="true" aria-label="Git" tabIndex={-1}>
      <ChangesPanel client={client} env={env} cwd={session.cwd} sessionId={session.id} status={git} reload={reloadGit} onClose={onClose} onOpen={onOpen} />
    </div>
  </div>;
  return <div className="thread-details-back" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="thread-details" ref={ref} role="dialog" aria-modal="true" aria-label="Thread details" tabIndex={-1}>
      <div className="details-heading"><div><h2>Thread details</h2><p>{session.title}</p></div><button className="iconbtn" aria-label="Close thread details" onClick={onClose}><Icon name="close" size={18} /></button></div>
      <div className="details-tabs" role="tablist" aria-label="Thread details sections">
        {tabs.map((item, index) => <button key={item.id} id={`details-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls="details-content" tabIndex={tab === item.id ? 0 : -1}
          onClick={() => onTab(item.id)} onKeyDown={(event) => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault(); onTab(tabs[next].id); document.getElementById(`details-${tabs[next].id}`)?.focus();
          }}>{item.label}</button>)}
      </div>
      <div className="details-content" role="tabpanel" id="details-content" aria-labelledby={`details-${tab}`}>
        {tab === 'agents' && <Subagents embedded onNativeAttention={onNativeAttention} reviewAttention={reviewAttention} client={client} env={env} parent={session} onClose={onClose} onOpen={onOpen} />}
        {tab === 'changes' && <p className="note">No Git repository available for this thread.</p>}
        {tab === 'schedules' && <Schedules client={client} env={env} session={session} />}
      </div>
    </div>
  </div>;
}
