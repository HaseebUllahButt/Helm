import { useState } from 'react';
import type { Mode } from '../client';

/** The word on the chip: the mode's own short form, or the first of its label. */
export const modeShort = (m: Mode | undefined, fallback?: string | null) =>
  m?.short ?? m?.label?.split(' ')[0].toLowerCase() ?? fallback ?? 'mode';

/**
 * How much the agent may do without asking, changed mid-conversation.
 *
 * Docked above the composer, in the same slot as a permission prompt,
 * because that is where the question "should I have let it do that?"
 * actually occurs to you. A dangerous mode takes two taps: the first turns
 * the row into its own confirmation, so a thumb on a phone cannot hand an
 * agent the whole machine by accident.
 */
export function ModeSheet({ modes, current, onPick, onClose, busy }: {
  modes: Mode[]; current?: string | null;
  onPick: (id: string) => void; onClose: () => void; busy?: boolean;
}) {
  const [arming, setArming] = useState<string | null>(null);

  const choose = (m: Mode) => {
    if (m.id === current) return onClose();
    if (m.danger && arming !== m.id) return setArming(m.id);
    onPick(m.id);
  };

  return (
    <div className="modesheet" role="listbox" aria-label="permissions">
      <div className="modesheet-head">
        <span>permissions</span>
        <button className="x" onClick={onClose} aria-label="close">✕</button>
      </div>
      {modes.map((m) => {
        const on = m.id === current;
        const armed = arming === m.id;
        return (
          <button
            key={m.id} role="option" aria-selected={on} disabled={busy}
            className={`moderow${on ? ' on' : ''}${m.danger ? ' danger' : ''}${armed ? ' armed' : ''}`}
            onClick={() => choose(m)}
          >
            <span className="grow">
              <span className="rt">{m.label}</span>
              <span className="rm">{armed ? 'Tap again to confirm' : m.hint}</span>
            </span>
            {on ? <span className="check">✓</span> : <span className="short">{modeShort(m)}</span>}
          </button>
        );
      })}
      <div className="modesheet-foot">shift+tab cycles the safe modes</div>
    </div>
  );
}
