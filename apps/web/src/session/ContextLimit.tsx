import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import { loadAccounts } from '../accountsCache';
import { Icon } from '../Icon';
import { useDismiss } from '../useDismiss';
import { ContextMeter, size } from './ContextMeter';

/** The sizes worth offering. Anything at or above the model's whole window is just "Full". */
const PRESETS = [750_000, 500_000, 350_000, 200_000];

/**
 * The context meter for a Claude chat, with its "Compact at" menu: how big
 * the conversation may grow before Claude summarises it. The choice belongs
 * to the Claude account, not the chat, so it is saved on every machine that
 * has that account - otherwise the same login would compact differently
 * depending on where the chat happened to run. Other engines keep the plain
 * meter. (Codex sets its own limit in its config file; Helm leaves that alone.)
 */
export function ContextLimit({ client, env, machines, session }: {
  client: Client; env: Environment; machines?: Environment[]; session: Session;
}) {
  const ctx = session.context!;
  const editable = session.engine === 'claude' && !!session.profileId && !session.brain && !!(ctx.model || session.model);
  const [open, setOpen] = useState(false);
  // Under the composer it opens upward; a short chat leaves the composer near the top, so then it opens downward.
  const [down, setDown] = useState(false);
  const slot = useRef<HTMLSpanElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: string; warn?: string } | null>(null);
  // The new size only shows in the numbers after the next reply, so what was
  // just picked is what the check mark follows until then.
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  useEffect(() => setChosen(undefined), [ctx.window, session.id]);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  if (!editable) return <ContextMeter used={ctx.used} window={ctx.window} compacted={ctx.compacted} />;

  const full = ctx.full && ctx.full >= ctx.window ? ctx.full : undefined;
  const isFull = full ? ctx.window >= full : false;
  const now: number | null = chosen !== undefined ? chosen : isFull ? null : ctx.window;
  // A size set by hand (383k) shows up as its own row, so the check has somewhere to be.
  const sizes = [...new Set([...PRESETS, ...(typeof now === 'number' ? [now] : [])])]
    .filter((n) => !full || n < full).sort((a, b) => b - a);

  const save = async (value: number | null) => {
    if (busy) return;
    setBusy(true); setNote(null); setChosen(value);
    const model = ctx.model || session.model!;
    try {
      // This machine first: it knows which account the chat runs on, and says so for the rest.
      const first = await client.rpc<{ matched: number; account: string }>(env.id, 'account.contextLimit', { profileId: session.profileId, model, window: value }, 20_000);
      const others = (machines ?? []).filter((m) => m.id !== env.id);
      const results = await Promise.all(others.map(async (m) => {
        if (!m.online) {
          // An offline machine only counts if this device remembers it having the account.
          const known = await loadAccounts(m.id);
          return { m, state: known?.profiles.some((p: any) => p.account === first.account) ? 'offline' as const : 'none' as const };
        }
        try {
          const r = await client.rpc<{ matched: number }>(m.id, 'account.contextLimit', { account: first.account, model, window: value }, 20_000);
          return { m, state: r.matched > 0 ? 'saved' as const : 'none' as const };
        } catch { return { m, state: 'failed' as const }; }
      }));
      const saved = (first.matched > 0 ? 1 : 0) + results.filter((r) => r.state === 'saved').length;
      const offline = results.filter((r) => r.state === 'offline').length;
      const failed = results.filter((r) => r.state === 'failed').map((r) => r.m.name);
      const warn = [
        offline ? `${offline} offline. Their limits stay the same` : '',
        failed.length ? `Helm cannot reach ${failed.join(', ')}` : '',
      ].filter(Boolean).join('. ');
      setNote({ ok: `Saved on ${saved} machine${saved === 1 ? '' : 's'}`, warn: warn || undefined });
    } catch (e: any) {
      setChosen(undefined);
      setNote({ ok: '', warn: e?.message || "Helm cannot save this limit." });
    } finally { setBusy(false); }
  };

  const row = (label: string, value: number | null, selected: boolean) => (
    <button key={label} type="button" role="menuitemradio" aria-checked={selected} className={selected ? 'on' : undefined}
      disabled={busy} onClick={() => void save(value)}>
      <span>{label}</span>{selected && <span className="check"><Icon name="check" size={15} /></span>}
    </button>
  );
  return (
    <span className="ctx-slot" ref={slot}>
      <ContextMeter used={ctx.used} window={ctx.window} compacted={ctx.compacted} open={open} onPress={() => { setDown((slot.current?.getBoundingClientRect().top ?? 999) < 360); setOpen((v) => !v); setNote(null); }} />
      {open && (
        <div className={`menu ctx-menu${down ? ' down' : ''}`} role="menu" aria-label="Summarize at">
          <div className="ctx-menu-title">Summarize at</div>
          {row(full ? `Full (${size(full)})` : 'Full', null, now === null)}
          {sizes.map((n) => row(size(n), n, now === n))}
          <div className="ctx-menu-note" role="status">
            {note?.ok && <span>{note.ok}</span>}
            {note?.warn && <span className="warn">{note.warn}</span>}
            {!note && <span>This limit applies to every chat on this account, on every machine.</span>}
          </div>
        </div>
      )}
    </span>
  );
}
