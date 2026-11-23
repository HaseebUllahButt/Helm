import { useState } from 'react';
import type { Session } from '../client';
import { Icon } from '../Icon';
import { shortPath } from '../screens/common';

/**
 * The chat's folder is missing and Helm could not find it. The chat still
 * works, in an empty folder; this says so above the message box and offers
 * the fix: a folder that looks like it, or the folder picker.
 */
export function FolderCard({ lost, busy, offline, onUse, onPick }: {
  lost: NonNullable<Session['folderLost']>;
  busy: boolean; offline: boolean;
  onUse: (path: string) => void;
  onPick?: () => void;
}) {
  const [hiddenAt, setHiddenAt] = useState(0);
  if (hiddenAt === lost.at) return null;
  const candidates = lost.candidates ?? [];
  const blocked = busy || offline;
  return (
    <div className="recovery warn folder-card" role="status">
      <div className="recovery-top">
        <span className="recovery-icon"><Icon name="folder" size={16} /></span>
        <div className="recovery-copy">
          <b>Folder missing</b>
          <p>The folder {lost.path} is missing. This chat works in an empty folder for now. Pick where the folder went.</p>
        </div>
        <button className="recovery-x" aria-label="Hide" onClick={() => setHiddenAt(lost.at)}><Icon name="close" size={14} /></button>
      </div>
      <div className="recovery-actions">
        {candidates.map((path) => (
          <button key={path} className="ghost" disabled={blocked} title={offline ? 'The machine is offline.' : path} onClick={() => onUse(path)}>Use {shortPath(path)}</button>
        ))}
        {onPick && <button className="primary" disabled={blocked} title={offline ? 'The machine is offline.' : undefined} onClick={onPick}>Pick folder</button>}
      </div>
    </div>
  );
}

/** A chat Helm runs in a folder of its own: not a sketch, the brain, or a terminal chat. */
export const canChangeFolder = (s: Session) => !!s.driver && !s.quick && !!s.cwd && !s.brain && !s.external
  && !s.nativeCli && !s.nativeChat && !s.movedAway && !/^(pane:|found:)/.test(s.id);
