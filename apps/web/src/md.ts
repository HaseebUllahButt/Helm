import { marked } from 'marked';
import DOMPurify from 'dompurify';

let highlighting: typeof import('./highlight') | null = null;
let pending: Promise<void> | null = null;
export const hasHighlighting = () => highlighting !== null;
/** Coloured HTML for code once highlighting has loaded, else null. */
export const highlightCode = (text: string, language: string) => highlighting?.highlight(text, language) ?? null;

/** Failure keeps formatted, escaped code readable without an unhandled rejection. */
export function loadHighlighting(): Promise<void> {
  if (highlighting) return Promise.resolve();
  if (!pending) pending = import('./highlight').then((module) => {
    highlighting = module;
  }).catch(() => { pending = null; });
  return pending;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const codeBlock = ({ text, lang }: { text: string; lang?: string }) => {
  const language = (lang || '').split(/\s+/)[0].toLowerCase();
  const colored = text.length <= 40_000 ? highlighting?.highlight(text, language) : null;
  const body = colored ?? escapeHtml(text);
  return `<div class="codeblock"><div class="codehead"><span>${escapeHtml(language || 'text')}</span>` +
    `<button type="button" class="copy" data-copy>Copy</button></div>` +
    `<pre><code class="hljs${colored != null ? ` language-${language}` : ''}">${body}</code></pre></div>`;
};
// Only our renderer may create controls or style classes. Raw HTML from a
// tool result is displayed literally; otherwise it can forge the copy button
// (and its clipboard action) or put a password field into a trusted thread.
marked.use({ gfm: true, breaks: true, renderer: {
  code: codeBlock,
  html: ({ text }) => escapeHtml(text),
} });

// Agent output is untrusted content. App classes such as `modal-back` can
// cover the controls without JavaScript or inline styles. Retain only the
// renderer's local code styles, never application layout or focus attributes.
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'class') {
    data.attrValue = data.attrValue.split(/\s+/).filter((name) =>
      /^(?:codeblock|codehead|copy|hljs|hljs-[\w-]+|language-[\w-]+)$/.test(name),
    ).join(' ');
  }
});

export function render(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del',
      'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'button', 'input'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'type', 'disabled', 'checked', 'start', 'data-copy'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    FORBID_ATTR: ['style', 'id', 'name', 'autofocus', 'tabindex', 'role', 'popover'],
    FORBID_TAGS: ['form', 'textarea', 'select', 'style', 'dialog'],
  });
}
