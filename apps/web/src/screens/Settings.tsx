import { errorMessage } from '../errors';
import { useEffect, useState, lazy, Suspense } from 'react';
import { accountsFrom, type Account } from '../accounts';
import { EngineMark } from '../EngineMark';
import { PublicLinks } from '../PublicLinks';
import { DictationKey } from '../DictationKey';
import { BackIcon, Icon } from '../Icon';
import { Client, type Environment } from '../client';
import { engineOf } from '../engines';
import { startSummary } from './common';
import { Notifications, InstallPwa } from './Notifications';
import type { MainView } from '../App';
import { ConnectionCheck } from '../ConnectionCheck';

const AppearanceSettings = lazy(() => import('../AppearanceSettings').then((m) => ({ default: m.AppearanceSettings })));

/**
 * The settings page: everything that used to fill the bottom of the home
 * screen.
 *
 * None of it is the day's work - what the machines cost, what this device
 * can do, a join code for a new computer - so it lives one tap away under
 * the gear instead of under the machine list, where it outweighed the
 * machines themselves.
 */
export function SettingsView({ client, envs, onBack, onVoice, onOpen, onUnpair }: {
  client: Client; envs: Environment[]; onBack: () => void; onVoice: (envIds: string[]) => void;
  onOpen: (v: MainView) => void; onUnpair: () => void;
}) {
  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Settings</h1></div>
      </div>
      <div className="scroll"><div className="pad column">
        <ConnectionCheck client={client} envs={envs} />
        <div className="rows">
          <button className="row" onClick={() => onOpen({ kind: 'owner' })}>
            <span className="grow"><span className="rt">Your preferences</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'devices' })}>
            <span className="grow"><span className="rt">Devices</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'network-settings' })}>
            <span className="grow"><span className="rt">Agent defaults</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'links' })}>
            <span className="grow"><span className="rt">Spins</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'usage' })}>
            <span className="grow"><span className="rt">Usage & cost</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'updates' })}>
            <span className="grow"><span className="rt">Updates</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
        </div>

        <div className="section">Speech input</div>
        <DictationKey client={client} envs={envs} onSaved={onVoice} />

        <div className="section">appearance</div>
        <div className="rows">
          <Suspense fallback={<div className="row appearance"><span className="grow"><span className="rt">Appearance</span></span></div>}>
            <AppearanceSettings />
          </Suspense>
          <Notifications client={client} />
          <InstallPwa />
        </div>

        <details className="note">
          <summary>Connection details</summary>
          <p>App address: {location.origin}</p>
          <p>App version: {document.querySelector<HTMLScriptElement>('script[type="module"]')?.src.split('/').at(-1) ?? 'development'}</p>
          <p>Helm home: {client.relay}</p>
          <p>Connection: {client.connected ? 'connected' : 'reconnecting'}</p>
          {client.lastError && <p>{errorMessage(client.lastError)}</p>}
          {envs.map(env => {
            const direct = client.directStatus(env.id);
            return direct.state === 'not requested' ? null : <p key={env.id}>
              {env.name}: direct link {direct.state}.{direct.reason ? ` ${direct.reason}` : ''}
            </p>;
          })}
        </details>
        <div className="rows">
          <button className="row destructive" onClick={onUnpair}>
            <span className="grow"><span className="rt">Sign out this device</span></span>
          </button>
        </div>
      </div></div>
    </>
  );
}

/**
 * Every machine's links in one place. They live on the machine that serves
 * them, so this is each machine's own list, one after another - the same
 * list its own settings show.
 */
export function LinksView({ client, envs, onBack }: { client: Client; envs: Environment[]; onBack: () => void }) {
  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Spins</h1><span className="sub">all machines</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <p className="note">
          Spins are public links. They expire after 3 hours unless you keep them. Private links open only on your devices.
        </p>
        {envs.map((env) => (
          <div key={env.id}>
            <div className="section">{env.name}</div>
            <PublicLinks client={client} env={env} />
          </div>
        ))}
      </div></div>
    </>
  );
}

/** One place to inspect every machine's account defaults. */
export function NetworkSettings({ client, envs, onBack, onOpen }: {
  client: Client; envs: Environment[]; onBack: () => void; onOpen: (envId: string, account: Account) => void;
}) {
  const [accounts, setAccounts] = useState<Record<string, Account[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let stale = false;
    for (const env of envs.filter((e) => e.online)) {
      client.rpc(env.id, 'profile.list')
        .then((r: any) => { if (!stale) setAccounts((all) => ({ ...all, [env.id]: accountsFrom(r.profiles) })); })
        .catch((e) => { if (!stale) setErrors((all) => ({ ...all, [env.id]: errorMessage(e, { machine: env.name }) })); });
    }
    return () => { stale = true; };
  }, [client, envs.map((e) => `${e.id}:${e.online}`).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Agent defaults</h1><span className="sub">all machines</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        {envs.map((env) => {
          const list = accounts[env.id];
          return (
            <div key={env.id}>
              <div className="section">{env.name}</div>
              <div className="rows">
                {!env.online ? (
                  <div className="empty quiet">offline</div>
                ) : errors[env.id] ? (
                  <div className="empty quiet">{errors[env.id]}</div>
                ) : !list ? (
                  <div className="empty quiet">Finding agents…</div>
                ) : list.length === 0 ? (
                  <div className="empty quiet">Helm found no supported agent programs.</div>
                ) : list.map((a) => (
                  <button key={a.key} className="row tall" onClick={() => onOpen(env.id, a)}>
                    <EngineMark engine={engineOf(a.engine).cls} />
                    <span className="grow">
                      <span className="rt">{engineOf(a.engine).label} <span className="dim">· {a.account}</span></span>
                      <span className="rm">{startSummary(a)}</span>
                    </span>
                    <span className="chev"><Icon name="forward" size={15} /></span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div></div>
    </>
  );
}
