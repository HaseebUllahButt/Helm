import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Client } from './client';

/**
 * The keys a phone keyboard does not have. `key` names a key the daemon
 * translates (or hands herdr by name); `paste` reads the clipboard into
 * the terminal as typed input - the only way ^V exists at all.
 */
const TERMKEYS: { label: string; key?: string; paste?: boolean; modifier?: 'ctrl' }[] = [
  { label: 'ctrl', modifier: 'ctrl' },
  { label: 'esc', key: 'Escape' },
  { label: 'tab', key: 'Tab' },
  { label: 'enter', key: 'Enter' },
  { label: '⌫', key: 'Backspace' },
  { label: '←', key: 'Left' },
  { label: '↑', key: 'Up' },
  { label: '↓', key: 'Down' },
  { label: '→', key: 'Right' },
  { label: 'home', key: 'Home' },
  { label: 'end', key: 'End' },
  { label: 'pgup', key: 'PageUp' },
  { label: 'pgdn', key: 'PageDown' },
  { label: '^C', key: 'C-c' },
  { label: '^D', key: 'C-d' },
  { label: '^Z', key: 'C-z' },
  { label: 'paste', paste: true },
];

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
  const [note, setNote] = useState('');
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlPending = useRef(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 1100);
  };

  const sendKey = (key: string) => {
    client.rpc(env, 'session.keys', { id: sessionId, keys: [key] }, 10_000).catch(() => {});
  };
  const paste = async () => {
    try {
      if (!navigator.clipboard?.readText) return flash('clipboard blocked');
      const text = await navigator.clipboard.readText();
      if (!text) return flash('nothing on the clipboard');
      await client.rpc(env, 'session.input', { id: sessionId, data: text, raw: true }, 10_000);
    } catch { flash('clipboard blocked'); }
  };

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

    // xterm turns a wheel gesture into Up/Down keypresses when the active
    // buffer has nothing to scroll. At a shell prompt those bytes are input,
    // not scrolling, and can become history navigation or visible escape
    // characters. Only let xterm handle the wheel when real scrollback exists;
    // full-screen alternate buffers never have browser-owned scrollback.
    xterm.attachCustomWheelEventHandler((event) => {
      const buffer = xterm.buffer.active;
      if (buffer.type === 'alternate' || buffer.baseY === 0) {
        event.preventDefault();
        return false;
      }
      return true;
    });

    let seen = '';
    let stopped = false;
    let isPty = false;

    const show = (text: string, reset: boolean) => {
      if (reset) {
        xterm.reset();
        xterm.write(text);
        seen = isPty ? '' : text;
      } else {
        xterm.write(text);
        // PTY snapshots always replace the terminal on attach; retaining a
        // second copy of every output chunk only grows memory for long sessions.
        if (!isPty) seen += text;
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
      let input = data;
      if (ctrlPending.current && data.length === 1) {
        ctrlPending.current = false;
        setCtrlArmed(false);
        if (data === ' ') {
          input = '\0';
        } else if (/^[a-z@\[\\\]^_]$/i.test(data)) {
          input = String.fromCharCode(data.toLowerCase().charCodeAt(0) & 0x1f);
        }
      }
      client.rpc(env, 'session.input', { id: sessionId, data: input, raw: true }, 10_000).catch(() => {});
    });
    const selected = xterm.onSelectionChange(() => {
      const text = xterm.getSelection();
      if (text) navigator.clipboard?.writeText(text).then(() => {
        if (!stopped) flash('Copied');
      }).catch(() => {});
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
      if (noteTimer.current) clearTimeout(noteTimer.current);
      off();
      typed.dispose();
      selected.dispose();
      resized.dispose();
      window.removeEventListener('resize', onResize);
      client.rpc(env, 'session.detach', { id: sessionId }, 5_000).catch(() => {});
      xterm.dispose();
    };
  }, [client, env, sessionId]);

  return (
    <div className="terminal-wrap">
      <div className="xterm-host" ref={host} />
      <div className="termkeys" role="toolbar" aria-label="terminal keys">
        {TERMKEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            aria-pressed={k.modifier === 'ctrl' ? ctrlArmed : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (k.modifier === 'ctrl') {
                ctrlPending.current = !ctrlPending.current;
                setCtrlArmed(ctrlPending.current);
              } else {
                ctrlPending.current = false;
                setCtrlArmed(false);
                if (k.paste) paste();
                else if (k.key) sendKey(k.key);
              }
            }}
          >{k.label}</button>
        ))}
      </div>
      {note && <div className="terminal-copied" role="status">{note}</div>}
    </div>
  );
}
