// Grow a text box to fit its text without moving anything around it.
// Measuring means collapsing the box for a moment. Without a hold on the
// space it fills, that collapse makes the chat above it taller, the
// browser pulls the chat's scroll back, and the regrow leaves it there:
// the whole screen shakes on each key press. Holding the parent's height
// and the box's own scroll keeps the screen still while it measures.
export function fitTextarea(el: HTMLTextAreaElement, max = Infinity, extra = 0) {
  const holder = el.parentElement;
  const held = holder?.style.minHeight ?? '';
  const scroll = el.scrollTop;
  const pageScroll = document.scrollingElement?.scrollTop;
  if (holder) holder.style.minHeight = `${holder.offsetHeight}px`;
  el.style.height = '0px';
  const next = `${Math.min(el.scrollHeight + extra, max)}px`;
  el.style.height = next;
  if (holder) holder.style.minHeight = held;
  el.scrollTop = scroll;
  if (pageScroll != null && document.scrollingElement && document.scrollingElement.scrollTop !== pageScroll) {
    document.scrollingElement.scrollTop = pageScroll;
  }
}
