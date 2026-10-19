/**
 * Mark an element while some of its content is out of sight past its right
 * edge, so the CSS can fade that edge instead of cutting a chip or ending a
 * title in "…". Use it as a ref.
 */
const watched = new WeakSet<HTMLElement>();
export function fadeWhenCut(el: HTMLElement | null) {
  if (!el || watched.has(el)) return;
  watched.add(el);
  const check = () => el.toggleAttribute('data-more', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  el.addEventListener('scroll', check, { passive: true });
  new ResizeObserver(check).observe(el);
  new MutationObserver(check).observe(el, { childList: true, subtree: true, characterData: true });
  check();
}
