import { useEffect, useState } from 'react';
import type { Client, Environment, Session } from './client';
import { BackIcon } from './Icon';
import { Sheet, Confirm, TextPrompt } from './Modal';

type Connector = { name: string; scope: string; cwd?: string; transport: string; target: string; status: string };
type Skill = { name: string; description: string; path: string; folder: string; shared: boolean };
type Plugin = { name: string; scope: string; version?: string; enabled?: boolean; cwd?: string };
type Account = { profileId: string; label: string; engine: string; error?: string; mcp?: Connector[]; skills?: Skill[]; plugins?: Plugin[]; support?: { mcp: boolean; skills: boolean; plugins: boolean; auth: string } };
type Catalog = { name: string; title: string; description: string; transport: string; url?: string; command?: string; args?: string[]; needsSignIn: boolean; setup?: string; source: string };
type Reply = { accounts: Account[]; catalog: Catalog[] };
type Add = 'connector' | 'skill' | 'plugin' | 'account' | 'project' | null;

export function IntegrationsView({ client, env, onBack, onOpenSession }: {
  client: Client; env: Environment; onBack: () => void; onOpenSession: (session: Session) => void;
}) {
  const [reply, setReply] = useState<Reply>();
  const [profileId, setProfileId] = useState('');
  const [cwd, setCwd] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<Add>(null);
  const [choice, setChoice] = useState<Catalog | 'custom' | null>(null);
  const [remove, setRemove] = useState<{ method: string; params: object; title: string; body?: string }>();
  const account = reply?.accounts.find((a) => a.profileId === profileId);
  // An unmounted screen must not apply a reply for the previous machine or folder.
  useEffect(() => {
    let live = true; setLoading(true); setError(''); setReply(undefined);
    client.rpc<Reply>(env.id, 'integrations.list', { cwd: cwd || undefined }).then((r) => {
      if (!live) return;
      setReply(r); setProfileId((id) => r.accounts.some((a) => a.profileId === id) ? id : r.accounts.find((a) => a.support?.mcp)?.profileId ?? r.accounts[0]?.profileId ?? '');
    }).catch((e) => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [client, env.id, cwd]);
  const refresh = async () => setReply(await client.rpc<Reply>(env.id, 'integrations.list', { cwd: cwd || undefined }));
  const change = async (method: string, params: object) => {
    setBusy(true); setError('');
    try { await client.rpc(env.id, method, params, 90_000); await refresh(); setSheet(null); setRemove(undefined); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const connect = async (c: Connector) => {
    setBusy(true); setError('');
    try {
      const result = await client.rpc<{ session: Session }>(env.id, 'integrations.mcp.connect', { profileId, name: c.name, scope: c.scope, cwd: c.cwd }, 90_000);
      onOpenSession(result.session);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const addRow = (label: string, value: Add) => <button className="row" disabled={busy} onClick={() => { setError(''); setChoice(null); setSheet(value); }}><span className="grow"><span className="rt">{label}</span></span></button>;
  const close = () => { if (!busy) { setSheet(null); setError(''); } };
  return <>
    <div className="bar"><button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button><b>Connectors &amp; skills</b><span className="spacer" /><button className="linkish" disabled={busy || loading} onClick={() => { setError(''); void refresh().catch((e) => setError(e.message)); }}>Refresh</button></div>
    <div className="scroll"><div className="pad column">
      <p className="note">{env.name} · Changes apply to new agent sessions.</p>
      <button className="row" disabled={loading || busy || !reply?.accounts.length} onClick={() => setSheet('account')} aria-label="Choose account"><span className="grow"><span className="rt">{account?.label ?? (loading ? 'Loading accounts…' : 'No accounts found')}</span><span className="rm">{account?.engine} · Choose account</span></span></button>
      {error && !sheet && !remove && <p className="note" role="alert">{error}</p>}
      {account?.error && <p className="note" role="alert">{account.error}</p>}
      {account && !account.error && <>
        <div className="section">Connectors</div>
        {!account.support?.mcp ? <p className="note">Connector management is not supported for this CLI yet.</p> : <>
          {account.mcp?.map((c) => <div className="row" key={`${c.scope}:${c.cwd}:${c.name}`}><span className="grow"><span className="rt">{c.name}</span><span className="rm">{c.target}</span><span className="rm">{c.scope} · {c.transport === 'stdio' ? 'command' : c.transport.toUpperCase()} · {c.status}{c.cwd ? ` · ${c.cwd}` : ''}</span></span>
            {c.transport !== 'stdio' && <button className="linkish" disabled={busy || c.status === 'disabled'} onClick={() => void connect(c)}>Connect</button>}
            <button className="linkish" disabled={busy} aria-label={`Remove connector ${c.name}`} onClick={() => setRemove({ method: 'integrations.mcp.remove', params: { profileId, name: c.name, scope: c.scope, cwd: c.cwd }, title: `Remove ${c.name}?` })}>Remove</button></div>)}
          {!account.mcp?.length && <p className="note">No connectors configured.</p>}
          <p className="note">Connect opens a terminal. Follow the link, then paste the callback when prompted. On older Claude versions, use /mcp in that terminal. Sign-in status is shown by the CLI.</p>
          {addRow('Add connector…', 'connector')}
          {account.engine === 'claude' && addRow(cwd ? `Project: ${cwd}` : 'Show project connectors…', 'project')}
        </>}
        <div className="section">Skills</div>
        {!account.support?.skills ? <p className="note">Skills are not supported for this CLI yet.</p> : <>
          {account.skills?.map((s) => <div className="row" key={s.path}><span className="grow"><span className="rt">{s.name}{s.shared && <span className="chip">shared</span>}</span><span className="rm">{s.description || s.path}</span></span><button className="linkish" disabled={busy} aria-label={`Remove skill ${s.name}`} onClick={() => setRemove({ method: 'integrations.skills.remove', params: { profileId, name: s.name, folder: s.folder }, title: `Remove ${s.name}?`, body: s.shared ? 'This shared skill will be removed for every account on this machine.' : 'This removes the skill from this account on this machine.' })}>Remove</button></div>)}
          {!account.skills?.length && <p className="note">No skills installed.</p>}
          {addRow('Add skill…', 'skill')}
        </>}
        <div className="section">Plugins</div>
        {!account.support?.plugins ? <p className="note">Plugin management is not supported for this CLI yet.</p> : <>
          {account.plugins?.map((p) => <div className="row" key={`${p.name}:${p.scope}:${p.cwd}`}><span className="grow"><span className="rt">{p.name}</span><span className="rm">{p.scope}{p.version ? ` · ${p.version}` : ''}{p.enabled === false ? ' · disabled' : ''}{p.cwd ? ` · ${p.cwd}` : ''}</span></span><button className="linkish" disabled={busy} aria-label={`Remove plugin ${p.name}`} onClick={() => setRemove({ method: 'integrations.plugins.remove', params: { profileId, name: p.name, scope: p.scope, cwd: p.cwd }, title: `Remove ${p.name}?` })}>Remove</button></div>)}
          {!account.plugins?.length && <p className="note">No plugins installed.</p>}
          {addRow('Add plugin…', 'plugin')}
        </>}
      </>}
    </div></div>
    {sheet === 'account' && <Sheet label="Choose account" onClose={close}><div className="modal-title">Choose account</div>{reply?.accounts.map((a) => <button className="row" key={a.profileId} aria-pressed={a.profileId === profileId} onClick={() => { setProfileId(a.profileId); setError(''); setSheet(null); }}><span className="grow"><span className="rt">{a.label}</span><span className="rm">{a.engine} · {a.profileId}</span></span>{a.profileId === profileId && <span className="chip">selected</span>}</button>)}</Sheet>}
    {sheet === 'connector' && !choice && <Sheet label="Add connector" onClose={close}><div className="modal-title">Add connector</div>{reply?.catalog.map((c) => <button className="row" key={c.name} onClick={() => setChoice(c)}><span className="grow"><span className="rt">{c.title}</span><span className="rm">{c.description}</span>{c.needsSignIn && <span className="rm">Needs sign-in</span>}</span></button>)}<button className="row" onClick={() => setChoice('custom')}><span className="rt">Custom…</span></button></Sheet>}
    {sheet === 'connector' && choice && account && <ConnectorForm key={typeof choice === 'string' ? choice : choice.name} choice={choice} account={account} cwd={cwd} busy={busy} error={error} onClose={close} onSubmit={(fields) => void change('integrations.mcp.add', { ...fields, profileId })} />}
    {sheet === 'skill' && <Sheet label="Add skill" onClose={close}><SimpleForm title="Add skill" label="Git URL or absolute folder" hint="Installs every named SKILL.md in the folder or repository into shared skills on this machine, and links it to all existing Claude accounts." busy={busy} error={error} onClose={close} onSubmit={(source) => void change('integrations.skills.add', { source })} /></Sheet>}
    {sheet === 'plugin' && <Sheet label="Add plugin" onClose={close}><SimpleForm title="Add plugin" label="Plugin name" placeholder="name@marketplace" hint="Use a marketplace already configured in this CLI. Installations that require an interactive command approval must be completed in the CLI." busy={busy} error={error} onClose={close} onSubmit={(name) => void change('integrations.plugins.add', { profileId, name, scope: 'user' })} /></Sheet>}
    {sheet === 'project' && <TextPrompt title="Project folder on this machine" value={cwd} placeholder="/absolute/project/folder" submitLabel="Show" busy={false} onCancel={close} onSubmit={(path) => { setCwd(path); setSheet(null); }} />}
    {remove && <Confirm title={remove.title} body={<>{remove.body}{error && <p role="alert">{error}</p>}</>} confirmLabel="Remove" busy={busy} onCancel={() => { if (!busy) { setRemove(undefined); setError(''); } }} onConfirm={() => void change(remove.method, remove.params)} />}
  </>;
}
function SimpleForm({ title, label, placeholder, hint, busy, error, onClose, onSubmit }: { title: string; label: string; placeholder?: string; hint: string; busy: boolean; error: string; onClose: () => void; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return <form onSubmit={(e) => { e.preventDefault(); onSubmit(value.trim()); }}><div className="modal-title">{title}</div><p className="note">{hint}</p><label>{label}<input className="modal-input" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} required /></label>{error && <p className="note" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !value.trim()}>{busy ? 'Adding…' : 'Add'}</button></div></form>;
}
function ConnectorForm({ choice, account, cwd, busy, error, onClose, onSubmit }: { choice: Catalog | 'custom'; account: Account; cwd: string; busy: boolean; error: string; onClose: () => void; onSubmit: (fields: object) => void }) {
  const c = choice === 'custom' ? null : choice;
  const [name, setName] = useState(c?.name ?? '');
  const [transport, setTransport] = useState(c?.transport ?? 'http');
  const [target, setTarget] = useState(c?.url ?? c?.command ?? '');
  const [args, setArgs] = useState(JSON.stringify(c?.args ?? []));
  const [scope, setScope] = useState('user');
  const [folder, setFolder] = useState(cwd);
  const [env, setEnv] = useState(''); const [headers, setHeaders] = useState('');
  const [clientId, setClientId] = useState(''); const [clientSecret, setClientSecret] = useState('');
  const [callbackPort, setCallbackPort] = useState('');
  const [localError, setLocalError] = useState('');
  const input = (label: string, value: string, set: (value: string) => void, type = 'text') => <label>{label}<input className="modal-input" type={type} autoComplete="off" value={value} onChange={(e) => set(e.target.value)} /></label>;
  return <Sheet label="Connector details" onClose={onClose}><form onSubmit={(e) => {
    e.preventDefault(); setLocalError('');
    try { onSubmit({ name: name.trim(), transport, scope, cwd: scope === 'user' ? undefined : folder.trim(), ...(transport === 'http' ? { url: target.trim(), headers: headers ? JSON.parse(headers) : undefined } : { command: target.trim(), args: JSON.parse(args), env: env ? JSON.parse(env) : undefined }), clientId: clientId || undefined, clientSecret: clientSecret || undefined, callbackPort: callbackPort ? Number(callbackPort) : undefined }); }
    catch { setLocalError('Enter arguments as a JSON list and environment or headers as a JSON object.'); }
  }}><div className="modal-title">{c?.title ?? 'Custom connector'}</div>
    {c?.setup && <p className="note">{c.setup} <a href={c.source} target="_blank" rel="noreferrer">Setup guide</a></p>}
    {input('Name', name, setName)}
    <label>Type<select className="modal-input" value={transport} onChange={(e) => setTransport(e.target.value)}><option value="http">HTTP</option><option value="stdio">Command</option></select></label>
    {input(transport === 'http' ? 'URL' : 'Command', target, setTarget)}
    <label>Scope<select className="modal-input" value={scope} onChange={(e) => setScope(e.target.value)}><option value="user">Account (all projects)</option>{account.engine === 'claude' && <><option value="local">Local (this project, private)</option><option value="project">Project (shared in .mcp.json)</option></>}</select></label>
    {scope !== 'user' && input('Absolute project folder', folder, setFolder)}
    {transport === 'stdio' && input('Arguments (JSON list)', args, setArgs)}
    <details><summary>More options</summary>{transport === 'stdio' ? input('Environment (JSON object)', env, setEnv, 'password') : <>
      {account.engine === 'claude' && input('Headers (JSON object)', headers, setHeaders, 'password')}
      {input('OAuth client ID', clientId, setClientId)}{input('OAuth client secret', clientSecret, setClientSecret, 'password')}
      {account.engine === 'claude' && input('Callback port (if registered)', callbackPort, setCallbackPort, 'number')}
    </>}</details>
    {(error || localError) && <p className="note" role="alert">{localError || error}</p>}
    <div className="modal-actions"><button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !name.trim() || !target.trim()}>{busy ? 'Adding…' : 'Add'}</button></div>
  </form></Sheet>;
}
