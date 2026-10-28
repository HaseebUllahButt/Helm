import { useEffect, useState } from 'react';
import type { Client } from '../client';

export function DeliveryStatus({ client, env, id }: { client: Client; env: string; id: string }) {
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const refresh = () => setChecking(client.pendingActions().some(item => item.env === env && item.params.id === id));
    refresh();
    const off = client.on((machine, kind) => { if (machine === env && kind === 'delivery') refresh(); });
    void client.resumeActions(env, id);
    return off;
  }, [client, env, id]);
  return checking ? <div className="thread-recovery" role="status">Checking delivery…</div> : null;
}
