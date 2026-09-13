import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Client } from './client';

/**
 * A real terminal in the browser.
 *
 * The runtime hands us rendered screens rather than a byte stream, so instead
 * of replaying a stream we poll and write whatever is new. Appending the delta
 * rather than repainting a fixed-size screen means xterm can wrap to the
 * phone's width, which matters far more on a 390px screen than matching the
 * pane's column count exactly.
 */
export function Terminal({ client, env, sessionId, status }: {
  client: Client; env: string; sessionId: string; status?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Xterm | null>(null);
  const seen = useRef('');

  // The poll reads the status through a ref so a working→blocked transition
  // adjusts the cadence without appearing in the effect's dependencies -
  // having it there tore down and rebuilt the whole terminal, wiping the
  // screen and scrollback at exactly the moment worth looking at.
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!host.current) return;

    const xterm = new Xterm({
      fontSize: 12,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: '#07090b', foreground: '#cfd6de', cursor: '#6ee7b7',
        black: '#14181d', red: '#f87171', green: '#6ee7b7', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#c084fc', cyan: '#67e8f9', white: '#e6eaef',
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host.current);
    try { fit.fit(); } catch { /* not laid out yet */ }
    term.current = xterm;
    seen.current = '';

    // Everything typed goes straight through, control characters included.
    const typed = xterm.onData((data) => {
      client.rpc(env, 'session.input', { id: sessionId, data, raw: true }).catch(() => {});
    });

    const onResize = () => { try { fit.fit(); } catch { /* hidden */ } };
    window.addEventListener('resize', onResize);

    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        try {
          const r = await client.rpc<{ text: string }>(env, 'session.attach', {
            id: sessionId, lines: 400, ansi: true,
          });
          const text = r.text ?? '';
          if (text !== seen.current) {
            if (text.startsWith(seen.current)) {
              xterm.write(text.slice(seen.current.length));
            } else {
              // The screen was redrawn rather than appended to.
              xterm.clear();
              xterm.write(text);
            }
            seen.current = text;
          }
        } catch { /* a dropped call should not end the session */ }
        await new Promise((r) => setTimeout(r, statusRef.current === 'working' ? 500 : 900));
      }
    };
    poll();

    return () => {
      stopped = true;
      typed.dispose();
      window.removeEventListener('resize', onResize);
      xterm.dispose();
      term.current = null;
    };
  }, [client, env, sessionId]);

  return <div className="xterm-host" ref={host} />;
}
