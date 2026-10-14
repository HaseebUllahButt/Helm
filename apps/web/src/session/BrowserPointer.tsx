import { useEffect, useState, type CSSProperties } from 'react';

export type Pointer = { x: number; y: number; box?: { x: number; y: number; width: number; height: number }; action: string; label: string; by: 'agent' | 'guide'; note?: string; seq: number; at: number };

const RIPPLES = new Set(['click', 'type', 'select', 'upload', 'drag']);
const pct = (value: number, of: number) => `${(value / of) * 100}%`;

/**
 * Where the agent is acting, drawn over the live page in page coordinates.
 * It glides with a transform measured in the frame's own size, so resizing
 * the panel or switching phone/desktop size keeps it on the spot. An agent
 * pointer fades after a few idle seconds; a guide stays until the owner
 * clicks, the agent points elsewhere, or a minute passes.
 */
export function BrowserPointer({ pointer, viewport, dismissed }: { pointer?: Pointer | null; viewport: { width: number; height: number }; dismissed: number }) {
  const [shown, setShown] = useState<Pointer | null>(null), [live, setLive] = useState(false);
  const seq = pointer && pointer.seq !== dismissed ? pointer.seq : 0;
  useEffect(() => {
    if (!seq || !pointer) { setLive(false); return; }
    setShown(pointer); setLive(true);
    const timer = setTimeout(() => setLive(false), pointer.by === 'guide' ? 60000 : 3500);
    return () => clearTimeout(timer);
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps -- the object is new on every poll; only a new seq is a new move
  if (!shown) return null;
  const fx = Math.max(0, Math.min(1, shown.x / viewport.width)), fy = Math.max(0, Math.min(1, shown.y / viewport.height));
  const guide = shown.by === 'guide', words = shown.note || shown.label;
  return <div className={`bp-pointer${live ? ' live' : ''}${guide ? ' guide' : ''}`}>
    {guide && shown.box && <div className="bp-highlight" style={{ left: pct(shown.box.x, viewport.width), top: pct(shown.box.y, viewport.height), width: pct(shown.box.width, viewport.width), height: pct(shown.box.height, viewport.height) }} />}
    <div className={`bp-cursor${fx > 0.5 ? ' flip-x' : ''}${fy > 0.82 ? ' flip-y' : ''}`} style={{ '--fx': fx, '--fy': fy } as CSSProperties}>
      {(guide || RIPPLES.has(shown.action)) && <span key={shown.seq} className="bp-ripple" />}
      <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true"><path d="M1.5 1.5v16.2l4.3-4.1 2.9 6.6 2.9-1.3-2.8-6.4h6z" /></svg>
      {words && <span className="bp-bubble" role={guide ? 'status' : undefined}>{words}</span>}
    </div>
  </div>;
}
