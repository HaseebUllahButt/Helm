import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../errors';
import { BackIcon } from '../Icon';
import type { Client, Environment } from '../client';

interface Tool { name: string; argv: string[]; description?: string; cwd?: string }
interface Listed { tools: Tool[]; seen?: Record<string, { tools: Tool[]; at: number }>; at?: number }
type Row = { state: 'loading' } | { state: 'ready'; tools: Tool[] } | { state: 'older' } | { state: 'error'; message: string };

const commandText = (argv: string[]) => argv.map((w) => /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`).join(' ');

/**
 * The tool registry (`helm tools`): named commands on each machine that
 * every agent can find and run. Agents add them through the command; here
 * the owner sees them all and removes the ones they no longer want. An
 * offline machine shows what another machine last heard from it.
 */
export function ToolsView({ client, envs, onBack }: { client: Client; envs: Environment[]; onBack: () => void }) {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [seen, setSeen] = useState<Record<string, { tools: Tool[]; at: number }>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback((env: Environment) => {
    client.rpc<Listed>(env.id, 'tool.list', { seen: true })
      .then((r) => {
        setRows((all) => ({ ...all, [env.id]: { state: 'ready', tools: r.tools ?? [] } }));
        setSeen((all) => {
          const next = { ...all };
          for (const [id, entry] of Object.entries(r.seen ?? {})) if ((next[id]?.at ?? 0) < entry.at) next[id] = entry;
          return next;
        });
      })
      .catch((e) => setRows((all) => ({ ...all, [env.id]: /unknown method/i.test(e?.message ?? '')
        ? { state: 'older' } : { state: 'error', message: errorMessage(e, { machine: env.name }) } })));
  }, [client]);

  const key = envs.map((e) => `${e.id}:${e.online}`).join(',');
  useEffect(() => {
    for (const env of envs.filter((e) => e.online)) load(env);
  }, [key, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (env: Environment, tool: Tool) => {
    setBusy(`${env.id}/${tool.name}`); setError(''); setNotice('');
    try {
      await client.rpc(env.id, 'tool.remove', { name: tool.name });
      const describe = tool.description ? ` --description ${commandText([tool.description])}` : '';
      setNotice(`Removed ${tool.name} from ${env.name}. To add it again, run this on ${env.name}: helm tools add ${tool.name}${describe} -- ${commandText(tool.argv)}`);
      load(env);
    }
    catch (e) { setError(errorMessage(e, { machine: env.name })); }
    finally { setBusy(''); }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Tools</h1><span className="sub">all machines</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <p className="note">
          Tools are commands you save by name. Every agent can find them with helm tools list and run them with helm tools run.
          To add one, run helm tools add &lt;name&gt; -- &lt;command&gt; on the machine that has the command.
        </p>
        {envs.map((env) => {
          const row = rows[env.id];
          const cached = !env.online ? seen[env.id] : undefined;
          const tools = env.online ? (row?.state === 'ready' ? row.tools : []) : cached?.tools ?? [];
          return (
            <div key={env.id}>
              <div className="section">{env.name}{!env.online && ' · offline'}</div>
              <div className="rows tools-list">
                {!env.online && !cached ? (
                  <div className="empty quiet">{env.name} is offline. Helm does not know its tools.</div>
                ) : env.online && (!row || row.state === 'loading') ? (
                  <div className="empty quiet">Helm is loading the tools.</div>
                ) : row?.state === 'older' && env.online ? (
                  <div className="empty quiet">{env.name} runs an older Helm with no tools. Update Helm there.</div>
                ) : row?.state === 'error' && env.online ? (
                  <div className="empty quiet">{row.message}</div>
                ) : tools.length === 0 ? (
                  <div className="empty quiet">{env.name} has no tools.</div>
                ) : tools.map((t) => (
                  <div key={t.name} className="row tall tool-row">
                    <span className="grow">
                      <span className="rt tool-name">{t.name}</span>
                      {t.description && <span className="rm tool-description">{t.description}</span>}
                      <span className="rm tool-command">{commandText(t.argv)}</span>
                    </span>
                    {env.online && (
                      <button className="ghost danger-text" disabled={!!busy} aria-label={`Remove ${t.name} from ${env.name}`}
                        onClick={() => void remove(env, t)}>
                        {busy === `${env.id}/${t.name}` ? 'Removing' : 'Remove'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!env.online && cached && <p className="note">Last seen {new Date(cached.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Remove works when {env.name} is online.</p>}
            </div>
          );
        })}
        {notice && <p className="note tool-notice">{notice}</p>}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}
