import { Client, type Environment, type Session, type NativeAgent } from '../client';
import { useDialog } from '../useDialog';
import { Icon } from '../Icon';
import { Subagents } from './Subagents';
import { ChangesPanel, type GitStatus } from './Changes';

/** Git and the browser have their own buttons in the chat header; this panel is the agents. */
export type DetailsTab = 'agents' | 'changes';

export function ThreadDetails({ client, env, session, tab, git, reloadGit, onClose, onOpen, onOpenNative, reviewAttention = false, onNativeAttention }: {
  client: Client; env: Environment; session: Session; tab: DetailsTab;
  git: GitStatus | null; reloadGit: () => void; onClose: () => void;
  onOpen?: (session: Session) => void; onOpenNative?: (agent: NativeAgent) => void; reviewAttention?: boolean; onNativeAttention?: () => void;
}) {
  const ref = useDialog(onClose);
  if (tab === 'changes' && git?.repo) return <div className="thread-details-back" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="thread-details git-details" ref={ref} role="dialog" aria-modal="true" aria-label="Git" tabIndex={-1}>
      <ChangesPanel client={client} env={env} cwd={session.cwd} sessionId={session.id} status={git} reload={reloadGit} onClose={onClose} onOpen={onOpen} />
    </div>
  </div>;
  return <div className="thread-details-back" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="thread-details" ref={ref} role="dialog" aria-modal="true" aria-label="Agents" tabIndex={-1}
      onKeyDown={(event) => {
        // Up and Down walk the agents from anywhere in the panel, Enter opens
        // the one in focus. Text fields and lists keep their own arrows.
        if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || (event.target as HTMLElement).closest('input, textarea, select')) return;
        const tasks = [...event.currentTarget.querySelectorAll<HTMLElement>('button.delegation-task')];
        if (!tasks.length) return;
        event.preventDefault();
        const at = tasks.indexOf(document.activeElement as HTMLElement);
        const down = event.key === 'ArrowDown';
        tasks[at < 0 ? (down ? 0 : tasks.length - 1) : (at + (down ? 1 : tasks.length - 1)) % tasks.length].focus();
      }}>
      <div className="details-heading"><div><h2>Agents</h2><p>{env.name} · {session.title}</p></div><button className="iconbtn" aria-label="Close agents" onClick={onClose}><Icon name="close" size={18} /></button></div>
      <div className="details-content">
        {tab === 'changes'
          ? <p className="note">No Git repository available for this thread.</p>
          : <Subagents embedded onNativeAttention={onNativeAttention} reviewAttention={reviewAttention} client={client} env={env} parent={session} onClose={onClose} onOpen={onOpen} onOpenNative={onOpenNative} />}
      </div>
    </div>
  </div>;
}
