import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Client } from './client';

/**
 * A real terminal in the browser.
 *
 * The daemon watches the pane and pushes what changed (`session.data`), so
 * the phone never asks "anything new?" across the network. Attaching returns
 * the current screen; every push after that is either an append or, when the
 * program redrew, a replacement. The attach is renewed periodically so the
 * daemon keeps watching, and re-done after a reconnect, when pushes may have
 * been missed - the full screen that comes back is compared with what we have
 * and replaces it only if they differ.
 *
 * Appending rather than repainting a fixed-size screen lets xterm wrap to the
 * phone's width, which matters far more on a 390px screen than matching the
 * pane's column count exactly.
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
        background: '#07090b', foreground: '#d5dbe3', cursor: '#7dd3fc',
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

    const show = (text: string, reset: boolean) => {
      if (reset) {
        xterm.clear();
        xterm.write(text);
        seen = text;
      } else {
        xterm.write(text);
        seen += text;
      }
    };

    const attach = async () => {
      try {
        const r = await client.rpc<{ text: string }>(env, 'session.attach', {
          id: sessionId, lines: 400, ansi: true,
        });
        if (stopped) return;
        const text = r.text ?? '';
        if (text !== seen) show(text, true);
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
      if (kind === 'connection' && payload?.online) attach();
    });

    const onResize = () => { try { fit.fit(); } catch { /* hidden */ } };
    window.addEventListener('resize', onResize);

    attach();
    const renew = setInterval(attach, 25_000);

    return () => {
      stopped = true;
      clearInterval(renew);
      off();
      typed.dispose();
      window.removeEventListener('resize', onResize);
      client.rpc(env, 'session.detach', { id: sessionId }, 5_000).catch(() => {});
      xterm.dispose();
    };
  }, [client, env, sessionId]);

  return <div className="xterm-host" ref={host} />;
}
