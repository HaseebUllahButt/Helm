/**
 * Where a screen is: `machine › folder`, the path you took to get here, in
 * the same place under every title that belongs to one - a session, a new
 * session, Git. It names true locations only, so it is structure rather than
 * decoration, and it is the one line that says which machine a thread is on
 * when two machines hold folders with the same name.
 */
const folderName = (p = '') => p.replace(/\/+$/, '').split('/').pop() || '~';
const homePath = (p = '') => p.replace(/^\/(home|Users)\/[^/]+/, '~') || '/';

export function Route({ machine, folder, full = false }: {
  machine: string; folder?: string;
  /** The whole path rather than its last part - where the path is the point, as when browsing. */
  full?: boolean;
}) {
  return (
    <span className="route" title={folder ? `${machine} · ${folder}` : machine}>
      <span className="route-machine">{machine}</span>
      {folder && (
        <>
          <svg className="route-sep" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
          <span className="vh"> / </span>
          <span className="route-folder">{full ? homePath(folder) : folderName(folder)}</span>
        </>
      )}
    </span>
  );
}
