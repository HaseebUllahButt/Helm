import { useState, type ReactNode } from 'react';
import type { Client, Environment } from './client';
import { errorMessage } from './errors';

export function MachineWakeRow({ client, env, machines, children }: {
  client: Client;
  env: Environment;
  machines: Environment[];
  children: ReactNode;
}) {
  const sender = env.online ? undefined : env.wakeVia?.map(id => machines.find(machine => machine.id === id))
    .find(machine => machine?.online && machine.info.wakeSender);
  if (!sender) return children;
  return <WakeAction client={client} env={env} sender={sender}>{children}</WakeAction>;
}

function WakeAction({ client, env, sender, children }: {
  client: Client;
  env: Environment;
  sender: Environment;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed?: boolean }>();
  async function wake() {
    setBusy(true);
    setMessage(undefined);
    try {
      await client.rpc(sender.id, 'machine.wake', { target: env.id });
      setMessage({ text: 'Wake signal sent.' });
    } catch (error) {
      setMessage({ text: errorMessage(error, { machine: sender.name, fallback: 'Helm could not send the wake signal.' }), failed: true });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="machine-wake-row">
      {children}
      <button type="button" className="linkish machine-wake-button" aria-label={`Wake ${env.name}`} disabled={busy} onClick={wake}>
        {busy ? 'Sending…' : 'Wake'}
      </button>
      {message && <small className="machine-wake-message" role={message.failed ? 'alert' : 'status'}>{message.text}</small>}
    </div>
  );
}
