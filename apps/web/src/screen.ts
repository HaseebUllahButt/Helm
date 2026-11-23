import type { Client } from './client';

/**
 * Remote screens (packages/connect/src/screen.js): this device asks the
 * machine to start its screen, then forwards it to `here`, the computer that
 * serves this window. Only the owner's device may do either: a machine, and so
 * an agent on it, can never open another machine's screen.
 */
export type ScreenOpen =
  | { url: string }
  | { needs: 'setup'; packages: string[]; canInstall: boolean; keys?: boolean }
  | { error: string };

/** The forward id; screen.js makes the same one to stop it. */
export async function screenForwardId(source: string, target: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`screen:${source}:${target}`)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const older = (err: any, name: string) =>
  /unknown method/.test(err?.message || '') ? `${name} runs an older Helm without screens. Update it first.` : null;

export async function openScreen(client: Client, { machine, name, here, hereName, withoutKeys = false }: { machine: string; name: string; here: string; hereName: string; withoutKeys?: boolean }): Promise<ScreenOpen> {
  let started: any;
  try { started = await client.rpc(machine, 'screen.start', withoutKeys ? { withoutKeys } : {}, 120_000); }
  catch (err: any) { return { error: older(err, name) ?? `${name} did not start its screen: ${err.message}` }; }
  if (started?.reason === 'no-desktop') return { error: `${name} has no desktop open, so there is no screen to show. Sign in to a desktop on ${name}, or open its terminal with Ctrl+Shift+T.` };
  if (started?.error) return { error: `${name}: ${started.error}` };
  if (started?.needs === 'setup') return { needs: 'setup', packages: started.packages ?? [], canInstall: !!started.canInstall, keys: !!started.keys };
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

/** What the screen menu says about one machine before you pick it. */
export type ScreenReady =
  | { state: 'checking' }
  | { state: 'ok'; setup?: boolean }
  | { state: 'off'; sub: string; note: string };

/**
 * Ask a machine whether its screen can open now. Quick: no package check.
 * An answer that does not come in time counts as "can open": the open
 * itself then says what is wrong.
 */
export async function screenReady(client: Client, { machine, name, online }: { machine: string; name: string; online: boolean }): Promise<ScreenReady> {
  if (!online) return { state: 'off', sub: 'offline', note: `${name} is offline. Turn it on, then try again.` };
  let r: any;
  try { r = await client.rpc(machine, 'screen.status', { quick: true }, 8_000); }
  catch (err: any) {
    if (/unknown method/.test(err?.message || '')) return { state: 'off', sub: 'older Helm · update it first', note: `${name} runs an older Helm without screens. Update it first.` };
    return { state: 'ok' };
  }
  if (r?.supported) return { state: 'ok', setup: !!r.needsSetup };
  if (r?.reason === 'no-desktop' || /signed in to a desktop|No desktop is open/.test(r?.error ?? '')) {
    return { state: 'off', sub: 'no desktop open · use its terminal', note: `${name} has no desktop open, so there is no screen to show. Sign in to a desktop on ${name}, or open its terminal with Ctrl+Shift+T.` };
  }
  if (r?.reason === 'platform') return { state: 'off', sub: 'not Linux · not supported yet', note: `${name}: ${r.error}` };
  if (r?.reason === 'desktop-kind') return { state: 'off', sub: 'this desktop is not supported', note: `${name}: ${r.error}` };
  return { state: 'off', sub: 'cannot show its screen', note: `${name}: ${r?.error ?? 'it cannot show its screen now.'}` };
}
