import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Client } from './client';

/**
 * The keys a phone keyboard does not have, as the bytes a keyboard sends.
 *
 * They go down the same road as typing (`session.input`, raw), so a button
 * behaves exactly like the key it is named after on every kind of terminal.
 * Asking the machine to press a key *by name* depended on the terminal
 * backend knowing that name, and the pane fallback did not know most of them.
 * Arrows, Home and End change with the program's cursor-key mode (`app`):
 * vim, less and full-screen agents switch it on and expect ESC O A, not ESC [ A.
 */
type TermKey = { label: string; aria: string; bytes?: (app: boolean) => string; paste?: boolean; clear?: boolean; mod?: 'ctrl' | 'alt'; repeat?: boolean };
const csi = (normal: string, app: string) => (on: boolean) => (on ? app : normal);
// T3 Code's set: one row that scrolls, only while typing on a phone. A
// computer has the real keys, and the phone keyboard has Enter and delete.
const TERMKEYS: TermKey[] = [
  { label: 'esc', aria: 'Escape', bytes: () => '\x1b' },
  { label: 'ctrl', aria: 'Control, applies to the next key', mod: 'ctrl' },
  { label: 'alt', aria: 'Alt, applies to the next key', mod: 'alt' },
  { label: 'tab', aria: 'Tab', bytes: () => '\t' },
  { label: 'paste', aria: 'Paste from clipboard', paste: true },
  { label: 'clear', aria: 'Clear the screen', clear: true },
  { label: '↑', aria: 'Up', bytes: csi('\x1b[A', '\x1bOA'), repeat: true },
  { label: '↓', aria: 'Down', bytes: csi('\x1b[B', '\x1bOB'), repeat: true },
  { label: '←', aria: 'Left', bytes: csi('\x1b[D', '\x1bOD'), repeat: true },
  { label: '→', aria: 'Right', bytes: csi('\x1b[C', '\x1bOC'), repeat: true },
  { label: '~', aria: 'Tilde', bytes: () => '~' },
  { label: '|', aria: 'Pipe', bytes: () => '|' },
  { label: '/', aria: 'Slash', bytes: () => '/' },
  { label: '-', aria: 'Dash', bytes: () => '-' },
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
  const term = useRef<Xterm | null>(null);
  const [note, setNote] = useState('');
  const [armed, setArmed] = useState<'ctrl' | 'alt' | null>(null);
  const pending = useRef<'ctrl' | 'alt' | null>(null);
  const [typing, setTyping] = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeat = useRef<{ delay?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> }>({});
  const flash = (text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 1100);
  };

  // Everything typed or tapped goes straight through, control characters
  // included. Fire and forget: waiting for the round trip would only add latency.
  const send = (data: string) => {
    client.rpc(env, 'session.input', { id: sessionId, data, raw: true }, 10_000).catch(() => {});
  };
  const paste = async () => {
    try {
      if (!navigator.clipboard?.readText) return flash('Clipboard blocked');
      const text = await navigator.clipboard.readText();
      if (!text) return flash('Nothing to paste');
      send(text);
    } catch { flash('Clipboard blocked'); }
  };
  const disarm = () => { pending.current = null; setArmed(null); };
  const stopRepeat = () => {
    clearTimeout(repeat.current.delay);
    clearInterval(repeat.current.every);
    repeat.current = {};
  };
  const press = (k: TermKey) => {
    if (k.mod) {
      pending.current = pending.current === k.mod ? null : k.mod;
      setArmed(pending.current);
      return;
    }
    disarm();
    if (k.paste) { void paste(); return; }
    if (k.clear) { term.current?.clear(); return; }
    const once = () => send(k.bytes!(!!term.current?.modes.applicationCursorKeysMode));
    once();
    if (k.repeat) {
      stopRepeat();
      repeat.current.delay = setTimeout(() => { repeat.current.every = setInterval(once, 70); }, 380);
    }
  };

  useEffect(() => {
    if (!host.current) return;

    const xterm = new Xterm({
      fontSize: 13,
      lineHeight: 1.15,
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: '#0d0f12', foreground: '#e6e8eb', cursor: '#b4cbff', cursorAccent: '#0d0f12',
        selectionBackground: '#3b4b6b',
        black: '#1b1f25', red: '#f87171', green: '#6ee7b7', yellow: '#fbbf24',
        blue: '#7aa7ff', magenta: '#c084fc', cyan: '#67e8f9', white: '#e6eaef',
        brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#a7f3d0', brightYellow: '#fde68a',
        brightBlue: '#a5c4ff', brightMagenta: '#d8b4fe', brightCyan: '#a5f3fc', brightWhite: '#ffffff',
      },
    });
    term.current = xterm;
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
    const watcher = globalThis.crypto?.randomUUID?.() ?? `terminal-${Date.now()}-${Math.random()}`;

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
          id: sessionId, lines: 400, ansi: true, cols: xterm.cols, rows: xterm.rows, renew, watcher,
        });
        if (stopped) return;
        isPty = !!r.pty;
        if (r.text == null) return;
        // A pty's reply is the whole scrollback, so it always replaces what we
        // have: anything else would draw the bytes twice after a reconnect.
        if (isPty || r.text !== seen) show(r.text, true);
      } catch { /* offline; the reconnect handler tries again */ }
    };

    xterm.textarea?.addEventListener('focus', () => setTyping(true));
    // A tap on a key can blur for a moment before it takes the focus back.
    let away: ReturnType<typeof setTimeout> | undefined;
    xterm.textarea?.addEventListener('focus', () => clearTimeout(away));
    xterm.textarea?.addEventListener('blur', () => { away = setTimeout(() => { if (!stopped) setTyping(false); }, 150); });
    const typed = xterm.onData((data) => {
      let input = data;
      if (pending.current === 'alt' && data.length === 1) {
        disarm();
        input = `\x1b${data}`;
      } else if (pending.current === 'ctrl' && data.length === 1) {
        disarm();
        if (data === ' ') {
          input = '\0';
        } else if (/^[a-z@\[\\\]^_]$/i.test(data)) {
          input = String.fromCharCode(data.toLowerCase().charCodeAt(0) & 0x1f);
        }
      }
      send(input);
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

    // The box changes size for more reasons than the window does: the
    // sidebar folding, the phone keyboard opening, a rotation.
    let frame: ReturnType<typeof setTimeout> | undefined;
    const refit = () => {
      clearTimeout(frame);
      frame = setTimeout(() => { try { fit.fit(); } catch { /* hidden */ } }, 16);
    };
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null;
    watch?.observe(host.current);
    window.addEventListener('resize', refit);
    window.visualViewport?.addEventListener('resize', refit);

    // Tell the far end what we are drawing at, so the program lays itself out
    // for this screen. A herdr pane ignores it; its geometry is not ours.
    const resized = xterm.onResize(({ cols, rows }) => {
      client.rpc(env, 'session.resize', { id: sessionId, cols, rows }, 10_000).catch(() => {});
    });

    attach();
    // The renew keeps a watching viewer registered, so output stops being
    // pushed to a phone that has gone away.
    const renew = setInterval(() => attach(true), 25_000);
    // On a computer the terminal is what you came for: type straight away.
    if (window.matchMedia?.('(pointer: fine)').matches) xterm.focus();

    return () => {
      stopped = true;
      term.current = null;
      clearInterval(renew);
      clearTimeout(frame);
      if (noteTimer.current) clearTimeout(noteTimer.current);
      stopRepeat();
      off();
      typed.dispose();
      selected.dispose();
      resized.dispose();
      watch?.disconnect();
      window.removeEventListener('resize', refit);
      window.visualViewport?.removeEventListener('resize', refit);
      client.rpc(env, 'session.detach', { id: sessionId, watcher }, 5_000).catch(() => {});
      xterm.dispose();
    };
  }, [client, env, sessionId]);

  return (
    <div className="terminal-wrap">
      <div className="xterm-host" ref={host} />
      {typing && <div className="termkeys" role="toolbar" aria-label="Terminal keys">
        {TERMKEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            aria-label={k.aria}
            title={k.aria}
            aria-pressed={k.mod ? armed === k.mod : undefined}
            // Pressed on the way down, not on release: it is a keyboard.
            // Taking the default away keeps the focus - and so the phone
            // keyboard - on the terminal.
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              press(k);
            }}
            onPointerUp={stopRepeat}
            onPointerLeave={stopRepeat}
            onPointerCancel={stopRepeat}
            onContextMenu={(event) => event.preventDefault()}
            // Enter or Space on a focused button, from a hardware keyboard.
            onClick={(event) => { if (event.detail === 0) { press(k); stopRepeat(); } }}
          >{k.label}</button>
        ))}
      </div>}
      {note && <div className="terminal-copied" role="status">{note}</div>}
    </div>
  );
}
