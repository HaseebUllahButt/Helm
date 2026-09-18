import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

/**
 * con's own confirm/ask sheets.
 *
 * `window.confirm` and `window.prompt` are gone from the app on purpose:
 * they render in the browser's chrome rather than the app's, iOS can
 * suppress them outright, and a native dialog over a sheet-styled app reads
 * like a crash report. These are the same question, styled, focusable, and
 * dismissable the way the rest of the app is.
 */
function Sheet({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus lands inside the sheet so Escape and Enter both behave, and so a
    // screen reader is told what appeared rather than left reading the page
    // behind it.
    ref.current?.querySelector<HTMLElement>('input, textarea, button.primary, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={label} ref={ref}>
        {children}
      </div>
    </div>
  );
}

/** "Are you sure?" - the destructive case gets a red verb, not an OK. */
export function Confirm({ title, body, confirmLabel = 'Confirm', danger, busy, onCancel, onConfirm }: {
  title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <Sheet onClose={onCancel} label={title}>
      <div className="modal-title">{title}</div>
      {body && <div className="modal-body">{body}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={danger ? 'primary danger' : 'primary'} onClick={onConfirm} disabled={busy} autoFocus>
          {busy ? '…' : confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

/** "What should it be called?" - the one-field prompt. */
export function TextPrompt({ title, value, placeholder, submitLabel = 'Save', busy, onCancel, onSubmit }: {
  title: string; value: string; placeholder?: string; submitLabel?: string; busy?: boolean;
  onCancel: () => void; onSubmit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const v = text.trim();
    if (v) onSubmit(v);
  };
  return (
    <Sheet onClose={onCancel} label={title}>
      <form onSubmit={submit}>
        <div className="modal-title">{title}</div>
        <input
          className="modal-input" value={text} placeholder={placeholder} autoFocus
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.target.select()}
        />
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !text.trim()}>{busy ? '…' : submitLabel}</button>
        </div>
      </form>
    </Sheet>
  );
}
