import { errorMessage } from './errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Environment } from './client';
import { EngineMark } from './EngineMark';
import { Icon } from './Icon';
import { waitingSince } from './useNow';

/**
 * The coding tools (Claude Code, Codex, ...) on one machine: which version
 * each has, whether it keeps itself current, and a button to update now.
 *
 * The machine does the work and decides what is safe to update. Tools that a
 * system package or another installer owns are only listed, with the reason.
 */

type Result = { at: number; ok: boolean; from?: string | null; to?: string | null; changed?: boolean; message?: string };
type Tool = {
  engine: string; label: string; version: string | null; latest?: string; outdated?: boolean;
  method: string; canUpdate: boolean; reason?: string; lastChecked: number; lastResult?: Result;
};
type Info = { auto: boolean; running: string[]; tools: Tool[] };

const ago = (ts: number, now: number) => {
  const w = waitingSince(ts, now);
  return w === 'just now' ? w : `${w} ago`;
};

/** One quiet line under the version: what happened last, or why nothing can. */
export function toolNote(t: Tool, running: boolean, auto: boolean, now: number): { text: string; tone: 'quiet' | 'done' | 'bad' } {
  if (running) return { text: 'Helm is updating this tool.', tone: 'quiet' };
  const r = t.lastResult;
  if (r && !r.ok) return { text: `The update failed ${ago(r.at, now)}.${r.message ? ` - ${errorMessage(r.message)}` : ''}`, tone: 'bad' };
  if (!t.canUpdate) return { text: `Helm cannot update this tool: ${t.reason ?? 'unknown installation method'}`, tone: 'quiet' };
  if (r?.changed) return { text: `Helm updated this tool ${ago(r.at, now)}.${r.from && r.to ? ` (${r.from} → ${r.to})` : ''}`, tone: 'done' };
  if (r) return { text: `The tool is up to date. Helm checked it ${ago(r.at, now)}.`, tone: 'quiet' };
  return { text: auto ? 'Helm will update this tool automatically.' : 'Helm has not updated this tool yet.', tone: 'quiet' };
}

export function CodingTools({ client, env }: { client: Client; env: Environment }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async (refresh: boolean) => {
    try {
      const r = await client.rpc<Info>(env.id, 'cli.versions', { refresh }, 60_000);
      if (!alive.current) return null;
      // Read every 3 seconds during an update: the same answer draws nothing.
      setInfo((was) => was && JSON.stringify(was) === JSON.stringify(r) ? was : r); setError(''); setNow(Date.now());
      return r;
    } catch (e: any) {
      if (alive.current) setError(/unknown method|not supported/i.test(e.message)
        ? `${env.name} runs an older Helm version. Its tools will appear after the update.` : errorMessage(e, { machine: env.name }));
      return null;
    }
  }, [client, env.id, env.name]);

  useEffect(() => { void load(true); }, [load]);

  // While an update runs on the machine, keep looking until it has finished.
  const running = !!info?.running.length;
  useEffect(() => {
    if (!running) return;
    let reading = false;
    const t = setInterval(() => {
      if (reading || document.hidden) return;
      reading = true;
      void load(false).finally(() => { reading = false; });
    }, 3_000);
    return () => clearInterval(t);
  }, [running, load]);

  const updateNow = async () => {
    setStarting(true); setError('');
    try {
      await client.rpc(env.id, 'cli.update', {}, 30_000);
      await load(false);
    } catch (e: any) { setError(errorMessage(e)); }
    finally { setStarting(false); }
  };

  const setAuto = async (on: boolean) => {
    setInfo((i) => (i ? { ...i, auto: on } : i));
    try { await client.rpc(env.id, 'cli.autoUpdate', { on }, 15_000); }
    catch (e: any) { setError(errorMessage(e)); setInfo((i) => (i ? { ...i, auto: !on } : i)); }
  };

  const canUpdate = !!info?.tools.some((t) => t.canUpdate);

  return (
    <>
      <div className="section">Coding tools<span className="quiet"> · {env.name}</span></div>
      <div className="rows plain">
        {info?.tools.map((t) => {
          const note = toolNote(t, info.running.includes(t.engine), info.auto, now);
          return (
            <div key={t.engine} className="row tall">
              <span className={`mark ${t.engine}`}><EngineMark engine={t.engine} /></span>
              <span className="grow">
                <span className="rt"><span className="rt-text">{t.label}</span></span>
                <span className="rm">{t.version ? <code>{t.version}</code> : 'Unknown version'}
                  {t.outdated && t.latest ? ` · ${t.latest} is available` : ''}</span>
                <span className={`rm wrap${note.tone === 'done' ? ' up-done' : note.tone === 'bad' ? ' up-failed' : ''}`}>{note.text}</span>
              </span>
            </div>
          );
        })}
        {info && !info.tools.length && <div className="empty quiet">Helm found no coding tools on {env.name}.</div>}
        {!info && !error && <div className="empty quiet">Helm is checking {env.name}.</div>}
        {info && (
          <div className="row toggle">
            <span className="grow">
              <span className="rt">Update automatically</span>
              <span className="rm wrap">Helm checks every few hours. Running chats continue.</span>
            </span>
            <button className={`switch${info.auto ? ' on' : ''}`} role="switch" aria-checked={info.auto}
              aria-label={`Update coding tools automatically on ${env.name}`} onClick={() => setAuto(!info.auto)}><i /></button>
          </div>
        )}
      </div>
      {info && (
        <button className="action coding-update" disabled={starting || running || !canUpdate} onClick={updateNow}>
          <span className="plus"><Icon name="refresh" size={15} /></span>
          {running ? `Helm is updating tools on ${env.name}.` : `Update coding tools on ${env.name}`}
        </button>
      )}
      {error && <div className="error">{error}</div>}
    </>
  );
}
