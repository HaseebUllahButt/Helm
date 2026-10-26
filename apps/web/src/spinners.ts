/**
 * The "working" spinner (`.tspin`) turns in 45° steps, five times a second,
 * from one timer for the whole app. A CSS rotation redrew the page 60 times a
 * second for as long as any chat on any machine worked: about a tenth of a
 * core on a laptop, all day. Hidden windows and reduced motion stay still.
 */
const STEP_MS = 200;

export function turnSpinners(doc: Document = document, every = STEP_MS) {
  const spinners = doc.getElementsByClassName('tspin');
  const still = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let angle = 0;
  return setInterval(() => {
    if (doc.hidden || !spinners.length || still?.matches) return;
    angle = (angle + 45) % 360;
    for (const el of Array.from(spinners)) (el as HTMLElement).style.transform = `rotate(${angle}deg)`;
  }, every);
}
