/**
 * Mark an element while some of its content is out of sight past its right
 * edge, so the CSS can fade that edge instead of cutting a chip or ending a
 * title in "…". Use it as a ref.
 */
const watched = new WeakSet<HTMLElement>();
export function fadeWhenCut(el: HTMLElement | null) {
  if (!el || watched.has(el)) return;
  watched.add(el);
  // Once per frame, before paint: a check on each change measured the page
  // again in the middle of drawing a new chat, many times per chat switch.
  let frame = 0;
  const check = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      el.toggleAttribute('data-more', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    });
  };
  el.addEventListener('scroll', check, { passive: true });
  new ResizeObserver(check).observe(el);
  new MutationObserver(check).observe(el, { childList: true, subtree: true, characterData: true });
  check();
}
