import { errorMessage } from '../errors';
import { useEffect, useRef, useState } from 'react';
import { BackIcon, Icon } from '../Icon';
import { Client, type Environment, type MediaRoot, type MediaEntry } from '../client';
import { bytes } from '../format';
import { Play } from './icons';

/**
 * What a machine designated 'nas' shares: the folders it was given, browsed
 * and played where they lie.
 *
 * Listing is ordinary RPC - small JSON, made for this channel. Playback is
 * not: a media element speaks real HTTP and cannot set an Authorization
 * header, so the screen mints a short-lived ticket and hands the element a
 * URL to fetch itself. The URL prefers the machine's own hub - the direct
 * path on the same network - and retries through the hub this page is
 * attached to, which proxies the same stream when the direct one cannot be
 * reached. The bytes never touch the JSON socket either way.
 */
export function MediaView({ client, env, onBack }: {
  client: Client; env: Environment; onBack: () => void;
}) {
  const [roots, setRoots] = useState<MediaRoot[] | null>(null);
  const [root, setRoot] = useState<MediaRoot | null>(null);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<MediaEntry[] | null>(null);
  const [playing, setPlaying] = useState<{ entry: MediaEntry; url: string } | null>(null);
  const [error, setError] = useState('');
  // The minted credential, kept so the relayed retry can reuse it.
  const ticket = useRef<{ value: string; relayed: boolean } | null>(null);

  useEffect(() => {
    client.mediaRoots(env.id)
      .then((r) => setRoots(r.roots))
      .catch((e: any) => setError(errorMessage(e)));
  }, [client, env.id]);

  useEffect(() => {
    if (!root) return;
    setEntries(null);
    setError('');
    client.mediaList(env.id, root.id, path)
      .then((r) => setEntries(r.entries))
      .catch((e: any) => setError(errorMessage(e)));
  }, [client, env.id, root, path]);

  const play = async (entry: MediaEntry) => {
    if (!root) return;
    setError('');
    try {
      const t = await client.mediaTicket(env.id);
      ticket.current = { value: t.ticket, relayed: false };
      setPlaying({
        entry,
        url: client.mediaStreamUrl(env, { root: root.id, path: entry.path, ticket: t.ticket }),
      });
    } catch (e: any) { setError(errorMessage(e)); }
  };

  /**
   * A media error is ambiguous: the direct address may be unreachable from
   * here (different network), or the browser may simply not decode the file.
   * The first failure retries the same file through the attached hub - cheap
   * and usually the answer - and only the second says unplayable.
   */
  const unplayable = () => {
    const t = ticket.current;
    if (playing && root && t && !t.relayed) {
      t.relayed = true;
      setPlaying({
        entry: playing.entry,
        url: client.mediaStreamUrl(env,
          { root: root.id, path: playing.entry.path, ticket: t.value },
          { direct: false }),
      });
    } else {
      setError(`This browser cannot play ${playing?.entry.name ?? 'that file'}.`);
    }
  };

  const crumbs = [root?.name, ...(path ? path.split('/') : [])].filter(Boolean).join(' / ');
  const backTo = playing ? () => setPlaying(null)
    : root ? () => { setRoot(null); setPath(''); }
    : onBack;

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={backTo}><BackIcon /></button>
        <div className="titles">
          <h1>{playing ? playing.entry.name : env.name}</h1>
          <span className="sub">{playing ? 'playing' : crumbs || 'media'}</span>
        </div>
      </div>

      <div className="scroll"><div className="pad column">
        {playing ? (
          <>
            <div className="player">
              {playing.entry.mime?.startsWith('audio/') ? (
                <audio controls autoPlay src={playing.url} onError={unplayable} />
              ) : (
                <video controls autoPlay playsInline src={playing.url} onError={unplayable} />
              )}
            </div>
            <div className="quiet media-meta">
              {playing.entry.path}
              {playing.entry.size != null && ` · ${bytes(playing.entry.size)}`}
            </div>
          </>
        ) : !root ? (
          <div className="rows">
            {(roots ?? []).map((r) => (
              <button key={r.id} className="row" onClick={() => { setRoot(r); setPath(''); }}>
                <span className="glyph repo"><Icon name="folder" size={16} /></span>
                <span className="grow">
                  <span className="rt"><span className="rt-text">{r.name}</span></span>
                  <span className="rm">{r.path}</span>
                </span>
                <span className="chev"><Icon name="forward" size={15} /></span>
              </button>
            ))}
            {roots === null
              ? <div className="empty quiet">Loading folders from {env.name}…</div>
              : !roots.length && !error && (
                <div className="empty quiet">
                  No folders are shared. Run helm nas add ~/Movies on {env.name}.
                </div>
              )}
          </div>
        ) : (
          <div className="rows">
            {path && (
              <button className="row" onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>
                <span className="glyph"><Icon name="back" size={16} /></span>
                <span className="grow"><span className="rt">Open parent folder</span></span>
              </button>
            )}
            {(entries ?? []).map((e) => (
              <button
                key={e.path}
                className={`row${e.dir || e.media ? '' : ' quiet'}`}
                disabled={!e.dir && !e.media}
                onClick={() => (e.dir ? setPath(e.path) : play(e))}
              >
                <span className={`glyph${e.dir ? ' repo' : ''}`}>{e.dir ? <Icon name="folder" size={16} /> : e.media ? <Play /> : '·'}</span>
                <span className="grow">
                  <span className="rt"><span className="rt-text">{e.name}</span></span>
                  {!e.dir && e.size != null && <span className="rm">{bytes(e.size)}</span>}
                </span>
                {e.dir && <span className="chev"><Icon name="forward" size={15} /></span>}
              </button>
            ))}
            {entries === null && !error && <div className="empty quiet">Loading files…</div>}
            {entries?.length === 0 && <div className="empty quiet">This folder is empty.</div>}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}
