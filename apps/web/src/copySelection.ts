/** Keep selected markup without turning text inside an item into a list. */
export function selectionClipboard(selection: Selection, root: HTMLElement) {
  const range = selection.getRangeAt(0);
  const fragment = range.cloneContents();
  const container = document.createElement('div');
  container.append(fragment);
  let ancestor = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  while (ancestor && ancestor !== root) {
    // Selecting words within an item selects prose, not its list marker.
    // A selection spanning items already contains LI nodes and retains its list.
    if (ancestor.tagName === 'LI') break;
    const wrapper = ancestor.cloneNode(false) as Element;
    wrapper.append(...Array.from(container.childNodes));
    container.append(wrapper);
    if (ancestor.classList.contains('md')) break;
    ancestor = ancestor.parentElement;
  }

  // Browser selections omit CSS list markers. Retain each original ordinal,
  // even when the selection starts halfway through a list. Ancestor items
  // aren't cloned when only their contents are selected.
  const originalItems = Array.from(root.querySelectorAll('li')).filter(li =>
    range.intersectsNode(li) && !li.contains(range.commonAncestorContainer));
  const copiedItems = Array.from(container.querySelectorAll('li'));
  originalItems.forEach((li, index) => {
    const list = li.parentElement;
    if (list?.tagName !== 'OL' || !copiedItems[index]) return;
    const items = Array.from(list.children).filter(child => child.tagName === 'LI');
    const reversed = list.hasAttribute('reversed');
    let number = Number(list.getAttribute('start') ?? (reversed ? items.length : 1));
    for (const item of items) {
      if (item.hasAttribute('value')) number = Number(item.getAttribute('value'));
      if (item === li) break;
      number += reversed ? -1 : 1;
    }
    copiedItems[index].setAttribute('value', String(number));
  });
  container.querySelectorAll('ol').forEach(list => {
    const first = list.querySelector(':scope > li');
    if (first?.hasAttribute('value')) list.setAttribute('start', first.getAttribute('value')!);
  });
  container.querySelectorAll('.codehead, button').forEach(el => el.remove());
  // Clipboard markup should contain prose, not application layout attributes.
  container.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      if (!['href', 'src', 'alt', 'title', 'start', 'value', 'reversed', 'checked', 'disabled', 'type'].includes(attr.name)) el.removeAttribute(attr.name);
    }
  });

  const plain = (node: Node, depth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return Array.from(node.childNodes).map(child => plain(child, depth)).join('');
    const tag = node.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'PRE') return `\n${node.textContent ?? ''}\n`;
    if (tag === 'OL' || tag === 'UL') {
      return '\n' + Array.from(node.children).map((li, index) => {
        const marker = tag === 'OL' ? `${li.getAttribute('value') ?? (Number(node.getAttribute('start') ?? 1) + index)}.` : '-';
        return `${'  '.repeat(depth)}${marker} ${Array.from(li.childNodes).map(child => plain(child, depth + 1)).join('').trim()}\n`;
      }).join('');
    }
    const content = Array.from(node.childNodes).map(child => plain(child, depth)).join('');
    if (tag === 'TD' || tag === 'TH') return `${content}\t`;
    if (/^(P|DIV|H[1-6]|BLOCKQUOTE|TR)$/.test(tag)) return `\n${content}\n`;
    return content;
  };
  return { text: plain(container).replace(/^\n+|\n+$/g, ''), html: container.innerHTML };
}

export async function writeSelectionClipboard(data: { text: string; html: string }) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([data.text], { type: 'text/plain' }),
        'text/html': new Blob([data.html], { type: 'text/html' }),
      })]);
      return;
    } catch { /* Plain text still carries the list markers if rich copy is blocked. */ }
  }
  await navigator.clipboard?.writeText(data.text);
}
