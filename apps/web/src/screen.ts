import type { Client } from './client';

/**
 * Remote screens (packages/connect/src/screen.js): this device asks the
 * machine to start its screen, then forwards it to `here`, the computer that
 * serves this window. Only the owner's device may do either: a machine, and so
 * an agent on it, can never open another machine's screen.
 */
export type ScreenOpen =
  | { url: string }
  | { needs: 'setup'; packages: string[]; canInstall: boolean }
  | { error: string };

/** The forward id; screen.js makes the same one to stop it. */
export async function screenForwardId(source: string, target: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`screen:${source}:${target}`)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const older = (err: any, name: string) =>
  /unknown method/.test(err?.message || '') ? `${name} runs an older Helm without screens. Update it first.` : null;

export async function openScreen(client: Client, { machine, name, here, hereName }: { machine: string; name: string; here: string; hereName: string }): Promise<ScreenOpen> {
  let started: any;
  try { started = await client.rpc(machine, 'screen.start', {}, 120_000); }
  catch (err: any) { return { error: older(err, name) ?? `${name} did not start its screen: ${err.message}` }; }
  if (started?.error) return { error: started.error };
  if (started?.needs === 'setup') return { needs: 'setup', packages: started.packages ?? [], canInstall: !!started.canInstall };
  let port = Number(started?.port);
  if (machine !== here) {
    const id = await screenForwardId(machine, here);
    try {
      await client.rpc(machine, 'forward.add', { id, side: 'out', peer: here, port }, 15_000);
      const { forwards } = await client.rpc<{ forwards: any[] }>(here, 'forward.list', {}, 10_000);
      const before = (forwards ?? []).some((f) => f.id === id && f.side === 'in');
      // A second open keeps the local port, so an open window comes back on it.
      const { forward } = await client.rpc<{ forward: { localPort: number } }>(here, 'forward.add',
        { id, side: 'in', peer: machine, port, ...(before ? {} : { localPort: 0 }) }, 15_000);
      port = forward.localPort;
    } catch (err: any) {
      return { error: older(err, hereName) ?? `Helm could not bring the screen of ${name} to ${hereName}: ${err.message}` };
    }
  }
  return { url: `http://127.0.0.1:${port}/?${new URLSearchParams({ name })}#token=${started.token}` };
}

/** Show the link in its own app window; else a plain popup. */
export async function showScreen(client: Client, here: string, url: string, machine: string): Promise<boolean> {
  try {
    const { opened } = await client.rpc<{ opened: boolean }>(here, 'screen.window', { url }, 10_000);
    if (opened) return true;
  } catch { /* an older Helm here: try a popup */ }
  return !!window.open(url, `helm-screen-${machine}`, 'popup,width=1280,height=800');
}
