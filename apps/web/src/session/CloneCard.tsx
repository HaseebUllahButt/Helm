import { errorMessage } from '../errors';
import type { Session } from '../client';
import { Icon } from '../Icon';

/**
 * A chat started on a repo that is still coming down from GitHub: the bar,
 * and that what is written now waits for it. The chat is a normal one the
 * whole time - listed, and left and come back to - and its agent starts in
 * the folder the moment the repo is in. A failed clone says why, with a way
 * to try again; nothing written is lost.
 */
export function CloneCard({ clone, agent, waiting, busy, offline, onRetry }: {
  clone: NonNullable<Session['clone']>;
  agent: string;
  /** Messages written while it clones. */
  waiting: number;
  busy: boolean; offline: boolean;
  onRetry: () => void;
}) {
  const [owner, name] = clone.repo.split('/');
  const failed = clone.state === 'failed';
  return (
    <div className={`clone-card in-chat${failed ? ' failed' : ''}`} role="status">
      <span className="pglyph"><Icon name="github" size={18} /></span>
      <span className="grow">
        <span className="clone-title">
          {failed ? clone.cloned ? `${agent} did not start in` : 'Cannot copy project' : 'Copying project'} {name} <span className="dim">· {owner}</span>
        </span>
        {failed
          ? <span className="clone-error">{errorMessage(clone.error, { fallback: 'Helm did not copy the project. Try again.' })}</span>
          : <>
            <span className="clone-progress"><i style={{ width: `${Math.max(4, clone.percent)}%` }} /></span>
            <span className="clone-note">{waiting
              ? `${waiting === 1 ? 'Your message goes' : 'Your messages go'} to ${agent} when the project is ready.`
              : `Write a message now. ${agent} receives it when the project is ready.`}</span>
          </>}
      </span>
      {failed
        ? <button className="primary clone-retry" disabled={busy || offline} title={offline ? 'The machine is offline.' : undefined} onClick={onRetry}><Icon name="refresh" size={14} />Try again</button>
        : <span className="clone-percent">{clone.percent}%</span>}
    </div>
  );
}
