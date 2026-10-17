import { useEffect, useState } from 'react';
import type { Client, Environment, Session } from './client';
import { BackIcon, Icon } from './Icon';
import { EngineMark } from './EngineMark';
import { ConnectorLogo, brandTitle } from './ConnectorLogo';
import { Sheet, Confirm, TextPrompt } from './Modal';

type Connector = { name: string; scope: string; cwd?: string; transport: string; target: string; status: string };
type Skill = { name: string; description: string; path: string; folder: string; shared: boolean; links?: string[] };
type Plugin = { name: string; scope: string; version?: string; enabled?: boolean; cwd?: string };
type Account = { profileId: string; label: string; engine: string; error?: string; mcp?: Connector[]; skills?: Skill[]; plugins?: Plugin[]; support?: { mcp: boolean; skills: boolean; plugins: boolean; auth: string } };
type Catalog = { name: string; title: string; description: string; transport: string; url?: string; command?: string; args?: string[]; needsSignIn: boolean; setup?: string; source: string };
type Reply = { accounts: Account[]; catalog: Catalog[] };
type Add = 'connector' | 'skill' | 'plugin' | 'account' | 'project' | null;
type Detail = { kind: 'connector'; item: Connector } | { kind: 'skill'; item: Skill } | { kind: 'plugin'; item: Plugin };
const FEW = 6;
// One short line a person can read; the full address or command is one tap away.
const connectorLine = (c: Connector) => [c.transport === 'stdio' ? 'Runs on this machine' : 'Online service', c.scope !== 'user' && 'One project', c.status === 'disabled' && 'Turned off'].filter(Boolean).join(' · ');
const pluginLine = (p: Plugin) => [p.name.includes('@') && `from ${p.name.split('@')[1]}`, /^v?\d[\w.-]{0,15}$/.test(p.version ?? '') && p.version, p.scope !== 'user' && 'One project', p.enabled === false && 'Turned off'].filter(Boolean).join(' · ');

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
  const [detail, setDetail] = useState<Detail>();
  const [allSkills, setAllSkills] = useState(false);
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
    try { await client.rpc(env.id, method, params, 90_000); await refresh(); setSheet(null); setRemove(undefined); setDetail(undefined); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const connect = async (c: Connector) => {
    setBusy(true); setError('');
    try {
      const result = await client.rpc<{ session: Session }>(env.id, 'integrations.mcp.connect', { profileId, name: c.name, scope: c.scope, cwd: c.cwd }, 90_000);
      setDetail(undefined); onOpenSession(result.session);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const addButton = (label: string, value: Add) => <button className="linkish" disabled={busy} aria-label={label} onClick={() => { setError(''); setChoice(null); setSheet(value); }}>+ Add</button>;
  const close = () => { if (!busy) { setSheet(null); setError(''); } };
  const askRemove = (r: typeof remove) => { setDetail(undefined); setError(''); setRemove(r); };
  // A long list of skills is mostly scrolling past ones nobody is looking for.
  const skills = account?.skills ?? [];
  const shownSkills = allSkills ? skills : skills.slice(0, FEW);
  return <>
    <div className="bar"><button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button><b>Connectors &amp; skills</b><span className="spacer" /><button className="linkish" disabled={busy || loading} onClick={() => { setError(''); void refresh().catch((e) => setError(e.message)); }}>Refresh</button></div>
    <div className="scroll"><div className="pad column integrations">
      <div className="rows"><button className="row" disabled={loading || busy || !reply?.accounts.length} onClick={() => setSheet('account')} aria-label="Choose account">
        {account && <EngineMark engine={account.engine} />}
        <span className="grow"><span className="rt">{account?.label ?? (loading ? 'Loading accounts…' : 'No accounts found')}</span><span className="rm">Changes apply to new chats</span></span>
        <span className="chev"><Icon name="forward" /></span></button></div>
      {error && !sheet && !remove && !detail && <p className="note" role="alert">{error}</p>}
      {account?.error && <p className="note" role="alert">{account.error}</p>}
      {account && !account.error && <>
        <div className="section">Connectors{!!account.mcp?.length && <span className="quiet">{account.mcp.length}</span>}<span className="spacer" />{account.support?.mcp && addButton('Add connector', 'connector')}</div>
        {!account.support?.mcp ? <p className="note">Connector management is not supported for this CLI yet.</p>
          : !account.mcp?.length ? <p className="note">No connectors configured.</p>
          : <div className="rows">{account.mcp.map((c) => <button className="row" key={`${c.scope}:${c.cwd}:${c.name}`} onClick={() => setDetail({ kind: 'connector', item: c })}>
              <ConnectorLogo name={c.name} target={c.target} /><span className="grow"><span className="rt"><span className="rt-text">{brandTitle(c.name, c.target)}</span></span><span className="rm">{connectorLine(c)}</span></span><span className="chev"><Icon name="forward" /></span></button>)}</div>}
        {account.support?.mcp && account.engine === 'claude' && <button className="linkish project-link" disabled={busy} onClick={() => setSheet('project')}>{cwd ? `Showing project ${cwd}` : 'Show a project’s connectors'}</button>}
        <div className="section">Skills{!!skills.length && <span className="quiet">{skills.length}</span>}<span className="spacer" />{account.support?.skills && addButton('Add skill', 'skill')}</div>
        {!account.support?.skills ? <p className="note">Skills are not supported for this CLI yet.</p>
          : !skills.length ? <p className="note">No skills installed.</p>
          : <div className="rows">{shownSkills.map((sk) => <button className="row" key={sk.path} onClick={() => setDetail({ kind: 'skill', item: sk })}>
              <ConnectorLogo name={sk.name} kind="skill" /><span className="grow"><span className="rt"><span className="rt-text">{sk.name}</span>{sk.shared && <span className="chip">shared</span>}</span>{sk.description && <span className="rm">{sk.description}</span>}</span><span className="chev"><Icon name="forward" /></span></button>)}
            {skills.length > FEW && <button className="row more-row" onClick={() => setAllSkills((v) => !v)}><span className="grow"><span className="rt">{allSkills ? 'Show fewer' : `Show all ${skills.length}`}</span></span></button>}</div>}
        <div className="section">Plugins{!!account.plugins?.length && <span className="quiet">{account.plugins.length}</span>}<span className="spacer" />{account.support?.plugins && addButton('Add plugin', 'plugin')}</div>
        {!account.support?.plugins ? <p className="note">Plugin management is not supported for this CLI yet.</p>
          : !account.plugins?.length ? <p className="note">No plugins installed.</p>
          : <div className="rows">{account.plugins.map((pl) => <button className="row" key={`${pl.name}:${pl.scope}:${pl.cwd}`} onClick={() => setDetail({ kind: 'plugin', item: pl })}>
              <ConnectorLogo name={pl.name} kind="plugin" /><span className="grow"><span className="rt"><span className="rt-text">{pl.name.split('@')[0]}</span></span><span className="rm">{pluginLine(pl)}</span></span><span className="chev"><Icon name="forward" /></span></button>)}</div>}
      </>}
    </div></div>
    {detail?.kind === 'connector' && (() => { const c = detail.item, title = brandTitle(c.name, c.target); return <Sheet label={title} onClose={() => setDetail(undefined)}>
      <div className="detail-head"><ConnectorLogo name={c.name} target={c.target} size={44} /><span className="grow"><span className="modal-title">{title}</span><span className="note">{connectorLine(c)}</span></span></div>
      <dl className="detail-list">{title !== c.name && <><dt>Name</dt><dd>{c.name}</dd></>}<dt>Applies to</dt><dd>{c.scope === 'user' ? 'Every project on this account' : c.cwd ?? 'One project'}</dd><dt>{c.transport === 'stdio' ? 'Command' : 'Address'}</dt><dd className="mono">{c.target}</dd></dl>
      {c.transport !== 'stdio' && <p className="note">Sign in opens a terminal. Follow the link there, then paste back the code it gives you. If the terminal shows a menu, pick this connector in it.</p>}
      {error && <p className="note" role="alert">{error}</p>}
      <div className="modal-actions"><button className="ghost danger-text" disabled={busy} aria-label={`Remove connector ${c.name}`} onClick={() => askRemove({ method: 'integrations.mcp.remove', params: { profileId, name: c.name, scope: c.scope, cwd: c.cwd }, title: `Remove ${title}?` })}>Remove</button>
        {c.transport !== 'stdio' ? <button className="primary" disabled={busy || c.status === 'disabled'} onClick={() => void connect(c)}>Sign in</button> : <button className="primary" onClick={() => setDetail(undefined)}>Done</button>}</div>
    </Sheet>; })()}
    {detail?.kind === 'skill' && (() => { const sk = detail.item; return <Sheet label={sk.name} onClose={() => setDetail(undefined)}>
      <div className="detail-head"><ConnectorLogo name={sk.name} kind="skill" size={44} /><span className="grow"><span className="modal-title">{sk.name}</span><span className="note">{sk.shared ? 'Shared by every account on this machine' : 'This account only'}</span></span></div>
      {sk.description && <p className="detail-text">{sk.description}</p>}
      <dl className="detail-list"><dt>Folder</dt><dd className="mono">{sk.path}</dd></dl>
      <div className="modal-actions"><button className="ghost danger-text" disabled={busy} aria-label={`Remove skill ${sk.name}`} onClick={() => askRemove({ method: 'integrations.skills.remove', params: { profileId, name: sk.name, folder: sk.folder }, title: `Remove ${sk.name}?`, body: sk.shared ? 'This shared skill will be removed for every account on this machine.' : 'This removes the skill from this account on this machine.' })}>Remove</button><button className="primary" onClick={() => setDetail(undefined)}>Done</button></div>
    </Sheet>; })()}
    {detail?.kind === 'plugin' && (() => { const pl = detail.item; return <Sheet label={pl.name} onClose={() => setDetail(undefined)}>
      <div className="detail-head"><ConnectorLogo name={pl.name} kind="plugin" size={44} /><span className="grow"><span className="modal-title">{pl.name.split('@')[0]}</span><span className="note">{pluginLine(pl)}</span></span></div>
      <dl className="detail-list"><dt>Full name</dt><dd className="mono">{pl.name}</dd>{pl.cwd && <><dt>Project</dt><dd className="mono">{pl.cwd}</dd></>}</dl>
      <div className="modal-actions"><button className="ghost danger-text" disabled={busy} aria-label={`Remove plugin ${pl.name}`} onClick={() => askRemove({ method: 'integrations.plugins.remove', params: { profileId, name: pl.name, scope: pl.scope, cwd: pl.cwd }, title: `Remove ${pl.name}?` })}>Remove</button><button className="primary" onClick={() => setDetail(undefined)}>Done</button></div>
    </Sheet>; })()}
    {sheet === 'account' && <Sheet label="Choose account" onClose={close}><div className="modal-title">Choose account</div>{reply?.accounts.map((a) => <button className="row" key={a.profileId} aria-pressed={a.profileId === profileId} onClick={() => { setProfileId(a.profileId); setAllSkills(false); setError(''); setSheet(null); }}><EngineMark engine={a.engine} /><span className="grow"><span className="rt">{a.label}</span><span className="rm">{a.engine} · {a.profileId}</span></span>{a.profileId === profileId && <span className="chip">selected</span>}</button>)}</Sheet>}
    {sheet === 'connector' && !choice && <Sheet label="Add connector" onClose={close}><div className="modal-title">Add connector</div>{reply?.catalog.map((c) => <button className="row" key={c.name} onClick={() => setChoice(c)}><ConnectorLogo name={c.name} target={c.url} /><span className="grow"><span className="rt">{c.title}</span><span className="rm">{c.description}</span>{c.needsSignIn && <span className="rm">Needs sign-in</span>}</span></button>)}<button className="row" onClick={() => setChoice('custom')}><span className="clogo" style={{ width: 32, height: 32 }} aria-hidden="true"><Icon name="plus" /></span><span className="rt">Custom…</span></button></Sheet>}
    {sheet === 'connector' && choice && account && <ConnectorForm key={typeof choice === 'string' ? choice : choice.name} choice={choice} account={account} cwd={cwd} busy={busy} error={error} onClose={close} onSubmit={(fields) => void change('integrations.mcp.add', { ...fields, profileId })} />}
    {sheet === 'skill' && <Sheet label="Add skill" onClose={close}><SimpleForm title="Add skill" label="Git URL or absolute folder" hint="Installs every named SKILL.md in the folder or repository into shared skills on this machine, and links it to all existing Claude accounts." busy={busy} error={error} onClose={close} onSubmit={(source) => void change('integrations.skills.add', { source })} /></Sheet>}
    {sheet === 'plugin' && <Sheet label="Add plugin" onClose={close}><SimpleForm title="Add plugin" label="Plugin name" placeholder="name@marketplace" hint="Use a marketplace already configured in this CLI. Installations that require an interactive command approval must be completed in the CLI." busy={busy} error={error} onClose={close} onSubmit={(name) => void change('integrations.plugins.add', { profileId, name, scope: 'user' })} /></Sheet>}
    {sheet === 'project' && <TextPrompt title="Project folder on this machine" value={cwd} placeholder="/absolute/project/folder" submitLabel="Show" busy={false} onCancel={close} onSubmit={(path) => { setCwd(path); setSheet(null); }} />}
    {remove && <Confirm title={remove.title} body={<>{remove.body}{error && <p role="alert">{error}</p>}</>} confirmLabel="Remove" danger busy={busy} onCancel={() => { if (!busy) { setRemove(undefined); setError(''); } }} onConfirm={() => void change(remove.method, remove.params)} />}
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
