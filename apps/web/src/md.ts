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
  if (language === 'math') return mathBox(text, true, 'div');
  // A mermaid block is drawn as a diagram once its reply ends (diagrams.ts).
  if (language === 'mermaid') {
    return `<div class="codeblock diagram"><div class="codehead"><span>diagram</span>` +
      `<button type="button" class="copy" data-copy>Copy</button></div>` +
      `<pre><code class="hljs">${escapeHtml(text)}</code></pre></div>`;
  }
  return `<div class="codeblock"><div class="codehead"><span>${escapeHtml(language || 'text')}</span>` +
    `<button type="button" class="copy" data-copy>Copy</button></div>` +
    `<pre><code class="hljs${colored != null ? ` language-${language}` : ''}">${body}</code></pre></div>`;
};
// Math becomes a `.math` box that holds its TeX as text; math.ts draws it.
// A single $ follows Pandoc's rule so prices stay text: no space after the
// opening $, none before the closing $, and no digit right after it. It
// never runs into code: `$x$` stays code.
const mathBox = (tex: string, display: boolean, tag = 'span') =>
  `<${tag} class="math math-${display ? 'display' : 'inline'}">${escapeHtml(tex.trim())}</${tag}>`;
const INLINE_MATH: [RegExp, boolean][] = [
  [/^\$\$(?!\$)([\s\S]+?)\$\$/, true],
  [/^\\\[([\s\S]+?)\\\]/, true],
  [/^\\\(([\s\S]+?)\\\)/, false],
  [/^\$(?![\s$])((?:\\[\s\S]|[^\\$\n`])+?)(?<!\s)\$(?!\d)/, false],
];
const BLOCK_MATH = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/;
type MathToken = { type: 'math' | 'inlineMath'; raw: string; text: string; display: boolean };
marked.use({ extensions: [{
  name: 'math', level: 'block',
  tokenizer(src: string): MathToken | undefined {
    const match = BLOCK_MATH.exec(src);
    const text = match && (match[1] ?? match[2]);
    if (match && text?.trim()) return { type: 'math', raw: match[0], text, display: true };
  },
  renderer: (token) => mathBox(token.text, true, 'div'),
}, {
  name: 'inlineMath', level: 'inline',
  start(src: string) { const at = src.search(/\$|\\[([]/); return at < 0 ? undefined : at; },
  tokenizer(src: string): MathToken | undefined {
    for (const [rule, display] of INLINE_MATH) {
      const match = rule.exec(src);
      if (match && match[1].trim()) return { type: 'inlineMath', raw: match[0], text: match[1], display };
    }
  },
  renderer: (token) => mathBox(token.text, token.display),
}] });

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
const keepCodeClasses = (_node: Element, data: { attrName: string; attrValue: string }) => {
  if (data.attrName === 'class') {
    data.attrValue = data.attrValue.split(/\s+/).filter((name) =>
      /^(?:codeblock|codehead|diagram|copy|math|math-inline|math-display|hljs|hljs-[\w-]+|language-[\w-]+)$/.test(name),
    ).join(' ');
  }
};
const CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del',
    'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'button', 'input'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'type', 'disabled', 'checked', 'start', 'data-copy'],
  ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  FORBID_ATTR: ['style', 'id', 'name', 'autofocus', 'tabindex', 'role', 'popover'],
  FORBID_TAGS: ['form', 'textarea', 'select', 'style', 'dialog'],
};
// A streaming reply sanitises its growing end about twice a second per
// paragraph. Reading the rules once, not on every call, and handing back
// nodes instead of HTML to parse again took a third off that work.
const toHtml = DOMPurify(window);
toHtml.setConfig(CONFIG);
toHtml.addHook('uponSanitizeAttribute', keepCodeClasses);
const toNodes = DOMPurify(window);
toNodes.setConfig({ ...CONFIG, RETURN_DOM_FRAGMENT: true });
toNodes.addHook('uponSanitizeAttribute', keepCodeClasses);

export function render(text: string): string {
  return toHtml.sanitize(marked.parse(text, { async: false }) as string) as string;
}

/** The same as render, as nodes ready to add to the page. */
export function renderNodes(text: string): DocumentFragment {
  return toNodes.sanitize(marked.parse(text, { async: false }) as string) as unknown as DocumentFragment;
}
