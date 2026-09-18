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
 * Two kinds of session arrive here. con's own terminals are a pty, so the
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

    /**
     * Predictive echo, the way mosh does it.
     *
     * A keystroke normally only appears once it has been to the machine and
     * back. On the same wifi that is a few milliseconds and nobody notices.
     * Relayed through a hub on the other side of the world it was measured
     * at over a second a round trip, and typing at that distance is
     * unusable - you are not typing, you are dictating and waiting.
     *
     * So when the link is slow, a printable character is drawn immediately
     * and remembered as owed. The machine's echo arrives a moment later and
     * almost always starts with exactly what was drawn, in which case that
     * prefix is dropped - it is already on screen. When it does not match,
     * the guess was wrong: erase it and let the machine's bytes stand. The
     * machine is always the authority; this only ever gets ahead of it.
     *
     * The guesses are deliberately timid, because a corrupted screen is far
     * worse than a slow one:
     *
     *   - nothing is predicted until the machine has been seen echoing, so
     *     a password prompt is not typed into in plain sight;
     *   - only printable characters, never control codes or escapes, whose
     *     effect cannot be guessed;
     *   - never in a full-screen program (vim, less), where a keystroke
     *     means something other than itself;
     *   - never close to the right edge, where erasing a wrong guess would
     *     have to cross a line break;
     *   - and never on a fast link, where there is nothing to win and a
     *     wrong guess would be the only thing anyone saw.
     */
    const PREDICT_ABOVE_MS = 60;
    const MAX_PREDICTED = 32;
    let owed = '';            // drawn here, not yet echoed back
    let owedSince = 0;
    let echoes = false;       // has this program been seen echoing?
    let fullScreen = false;   // vim, less, anything on the alternate screen
    let lastSent = '';

    const unpredict = () => {
      if (!owed) return;
      // Safe because nothing has been drawn since: any output would have
      // gone through `show` and settled these first.
      xterm.write('\b \b'.repeat(owed.length));
      owed = '';
    };

    const mayPredict = (data: string) => {
      const rtt = client.latency(env);
      if (!isPty || !echoes || fullScreen) return false;
      if (rtt == null || rtt < PREDICT_ABOVE_MS) return false;
      if (owed.length >= MAX_PREDICTED) return false;
      // One printable character. Anything else means something.
      if (data.length !== 1 || data < ' ' || data === '\x7f') return false;
      const buffer = xterm.buffer.active;
      return buffer.cursorX + owed.length + 2 < xterm.cols;
    };

    /** Output the machine sent, reconciled against anything drawn early. */
    const settle = (text: string) => {
      if (/\x1b\[\?(1049|47|1047)h/.test(text)) { unpredict(); fullScreen = true; }
      if (/\x1b\[\?(1049|47|1047)l/.test(text)) fullScreen = false;

      if (!owed) {
        // Not predicting, but still watching: a program that echoes what it
        // is sent is one whose echo can be drawn early next time.
        if (lastSent && text.startsWith(lastSent)) echoes = true;
        xterm.write(text);
        return;
      }
      if (text.startsWith(owed)) {
        const rest = text.slice(owed.length);
        owed = '';
        if (rest) xterm.write(rest);
        return;
      }
      if (owed.startsWith(text)) {
        // The echo is arriving in pieces; keep waiting for the rest.
        owed = owed.slice(text.length);
        owedSince = Date.now();
        return;
      }
      // Wrong. Take it back and believe the machine.
      unpredict();
      echoes = false;
      xterm.write(text);
    };

    const show = (text: string, reset: boolean) => {
      if (reset) {
        owed = '';
        xterm.reset();
        xterm.write(text);
        seen = text;
      } else {
        settle(text);
        seen += text;
      }
    };

    // A guess nobody ever confirmed. Usually a password prompt, which is
    // exactly when a character must not be left sitting on screen.
    const staleGuess = setInterval(() => {
      if (!owed) return;
      const rtt = client.latency(env) ?? 0;
      if (Date.now() - owedSince > Math.max(500, rtt * 3)) {
        unpredict();
        echoes = false;
      }
    }, 250);

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
      if (mayPredict(data)) {
        if (!owed) owedSince = Date.now();
        owed += data;
        xterm.write(data);
      }
      lastSent = data;
      client.rpc(env, 'session.input', { id: sessionId, data, raw: true }, 10_000).catch(() => {});
    });

    // How far away this machine is, which is what decides whether to guess.
    const stopLatency = client.watchLatency(env);

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
      clearInterval(staleGuess);
      stopLatency();
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
