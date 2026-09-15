import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Client } from './client';

/**
 * A real terminal in the browser.
 *
 * Attaching says how big we are drawing and gets back everything worth
 * showing; after that the daemon pushes output as it happens (`session.data`).
 *
 * Two kinds of session arrive here. helm's own terminals are a pty, so the
 * pushes are the raw byte stream and every one is an append - and because the
 * program is told our size, it renders for this screen instead of being
 * reflowed into it. A herdr pane (an agent someone started at the keyboard)
 * is still sampled as a rendered screen, where `reset` means the program
 * redrew and the text replaces what we have.
 */
export function Terminal({ client, env, sessionId }: {
  client: Client; env: string; sessionId: string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;

    const xterm = new Xterm({
      fontSize: 12.5,
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: '#0a0a0a', foreground: '#e5e5e5', cursor: '#b4cbff',
        black: '#14181d', red: '#f87171', green: '#6ee7b7', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#c084fc', cyan: '#67e8f9', white: '#e6eaef',
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host.current);
    try { fit.fit(); } catch { /* not laid out yet */ }

    let seen = '';
    let stopped = false;
    let isPty = false;

    const show = (text: string, reset: boolean) => {
      if (reset) {
        xterm.reset();
        xterm.write(text);
        seen = text;
      } else {
        xterm.write(text);
        seen += text;
      }
    };

    /**
     * `renew` keeps our place in the daemon's list of viewers without asking
     * for the screen again. A pty would otherwise hand back its whole
     * scrollback every time and we would redraw it, which is a flicker once
     * every renewal for no reason.
     */
    const attach = async (renew = false) => {
      try {
        const r = await client.rpc<{ text: string | null; pty?: boolean }>(env, 'session.attach', {
          id: sessionId, lines: 400, ansi: true, cols: xterm.cols, rows: xterm.rows, renew,
        });
        if (stopped) return;
        isPty = !!r.pty;
        if (r.text == null) return;
        // A pty's reply is the whole scrollback, so it always replaces what we
        // have: anything else would draw the bytes twice after a reconnect.
        if (isPty || r.text !== seen) show(r.text, true);
      } catch { /* offline; the reconnect handler tries again */ }
    };

    // Everything typed goes straight through, control characters included.
    // Fire and forget: waiting for the round trip would only add latency.
    const typed = xterm.onData((data) => {
      client.rpc(env, 'session.input', { id: sessionId, data, raw: true }, 10_000).catch(() => {});
    });

    const off = client.on((e, kind, payload) => {
      if (e === env && kind === 'session.data' && payload?.id === sessionId) {
        show(payload.text ?? '', !!payload.reset);
      }
      // Back after a drop: ask for everything, since pushes were missed.
      if (kind === 'connection' && payload?.online) attach();
      if (e === env && kind === 'session.exit' && payload?.id === sessionId) {
        xterm.write('\r\n\x1b[2m[ the terminal ended ]\x1b[0m\r\n');
      }
    });

    const onResize = () => { try { fit.fit(); } catch { /* hidden */ } };
    window.addEventListener('resize', onResize);

    // Tell the far end what we are drawing at, so the program lays itself out
    // for this screen. A herdr pane ignores it; its geometry is not ours.
    const resized = xterm.onResize(({ cols, rows }) => {
      client.rpc(env, 'session.resize', { id: sessionId, cols, rows }, 10_000).catch(() => {});
    });

    attach();
    // The renew keeps a watching viewer registered, so output stops being
    // pushed to a phone that has gone away.
    const renew = setInterval(() => attach(true), 25_000);

    return () => {
      stopped = true;
      clearInterval(renew);
      off();
      typed.dispose();
      resized.dispose();
      window.removeEventListener('resize', onResize);
      client.rpc(env, 'session.detach', { id: sessionId }, 5_000).catch(() => {});
      xterm.dispose();
    };
  }, [client, env, sessionId]);

  return <div className="xterm-host" ref={host} />;
}
