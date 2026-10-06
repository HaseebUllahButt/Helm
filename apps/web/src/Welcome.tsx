import { useEffect, useState } from 'react';
import type { Client, Environment, Profile } from './client';
import { Icon } from './Icon';

const DONE_KEY = 'helm.welcome.done';

type Check = { ok: boolean | null; title: string; detail: string; action?: { label: string; run: () => void } };

/**
 * What a new owner needs to know on day one, in one place: is this computer
 * in, which AI tools Helm found, whether the normal terminal commands show up
 * here, and whether a phone is paired. It goes away once everything is ticked,
 * or when closed.
 */
export function Welcome({ client, envs, engineLabel, onPair }: {
  client: Client; envs: Environment[]; engineLabel: (id: string) => string; onPair: () => void;
}) {
  const [closed, setClosed] = useState(() => localStorage.getItem(DONE_KEY) === '1');
  const [tools, setTools] = useState<string[] | null>(null);
  const [phones, setPhones] = useState<number | null>(null);
  const computer = envs.find((e) => e.online && e.kind !== 'vm' && e.kind !== 'nas') ?? envs.find((e) => e.online);

  useEffect(() => {
    if (closed || !computer) return;
    let stale = false;
    Promise.resolve().then(() => client.rpc<{ profiles: Profile[] }>(computer.id, 'profile.list'))
      .then((r) => { if (!stale) setTools([...new Set(r.profiles.map((p) => p.engine))]); })
      .catch(() => { if (!stale) setTools([]); });
    return () => { stale = true; };
  }, [client, computer?.id, closed]);

  useEffect(() => {
    if (closed) return;
    let stale = false;
    // Never allowed to take the page down: a hub that cannot list devices
    // just leaves this one line unticked.
    const load = () => Promise.resolve().then(() => client.devices())
      .then((r) => { if (!stale) setPhones(r.devices.filter((d) => !d.self).length); })
      .catch(() => {});
    void load();
    const timer = setInterval(load, 15_000);
    return () => { stale = true; clearInterval(timer); };
  }, [client, closed]);

  if (closed) return null;
  const link = computer?.info.cliLink;
  const checks: Check[] = [
    { ok: !!computer, title: 'This computer is connected', detail: computer ? computer.name : 'Waiting for a computer to come online' },
    { ok: tools === null ? null : tools.length > 0, title: 'AI tools found',
      detail: tools === null ? 'Looking…' : tools.length ? tools.map(engineLabel).join(', ') : 'Install Claude Code, Codex or another CLI and sign in' },
    { ok: link == null ? null : link.on, title: 'Terminal chats show up here',
      detail: link == null ? 'Checking…' : link.on ? `Your normal ${link.commands.slice(0, 3).join(', ')} commands work from here too` : 'Run helm integrate on this computer' },
    { ok: phones === null ? null : phones > 0, title: 'Phone connected',
      detail: phones ? 'You can carry on from your phone' : 'Scan a QR code with your phone to add it',
      action: phones ? undefined : { label: 'Show QR code', run: onPair } },
  ];
  const close = () => { localStorage.setItem(DONE_KEY, '1'); setClosed(true); };
  // Everything ticked: nothing left to say, so say nothing.
  if (checks.every((c) => c.ok)) return null;
  return (
    <section className="welcome" aria-label="Getting started">
      <div className="welcome-head">
        <b>Getting started</b>
        <button className="iconbtn" aria-label="Close getting started" title="Close" onClick={close}><Icon name="close" size={14} /></button>
      </div>
      {checks.map((c) => (
        <div key={c.title} className={`welcome-row${c.ok ? ' ok' : ''}`}>
          <span className="welcome-mark" aria-label={c.ok ? 'done' : c.ok === null ? 'checking' : 'to do'}>{c.ok ? '✓' : c.ok === null ? '…' : '○'}</span>
          <span className="grow"><span className="rt">{c.title}</span><span className="rm">{c.detail}</span></span>
          {c.action && <button className="welcome-go" onClick={c.action.run}>{c.action.label}</button>}
        </div>
      ))}
    </section>
  );
}
