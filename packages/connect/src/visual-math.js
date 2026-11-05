import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Math in a saved page ($...$, $$...$$, \(...\), \[...\]) is drawn with
 * KaTeX inside the page, as replies are (apps/web/src/math.ts). The page
 * frame cannot load scripts or fonts from outside, so a page with math gets
 * KaTeX, its style sheet and its fonts (as data) written into it: about
 * 650 KB. Pages without math get nothing.
 *
 * The page's own scripts often write the text (a lesson that redraws a table
 * when a button is pressed), so a small script draws math in the page at
 * load and again whenever the page changes.
 */

// The same rules as md.ts. A single $ follows Pandoc's rule so prices stay
// text: no space after the opening $, none before the closing $, and no
// digit right after it.
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$])\$(?![\s$])((?:\\[\s\S]|[^\\$\n])+?)(?<!\s)\$(?!\d)/;
// Text in these is code or already drawn, never math.
const SKIP = new Set(['script', 'style', 'textarea', 'code', 'pre', 'kbd', 'samp', 'svg', 'math', 'noscript', 'template', 'title']);
// Math that a script writes: TeX inside a script's strings, such as
// '$W_Q$' or '\\(d_k\\)'. A template literal like `${a}-${b}` has no _, ^
// or \ between the dollars, so it does not count.
const SCRIPT_MATH = /\$[^\s$`'"{}][^$\n`'"]*?[\\_^][^$\n`'"]*?[^\s\\$]\$|\\\\[([][^\n]*?\\\\[)\]]/;

let kit = null;
function katexKit() {
  if (kit) return kit;
  const dist = dirname(createRequire(import.meta.url).resolve('katex'));
  const font = (name) => `url(data:font/woff2;base64,${readFileSync(join(dist, 'fonts', `${name}.woff2`)).toString('base64')}) format("woff2")`;
  // Each font as woff2 data only: every browser that runs Helm reads woff2.
  const css = readFileSync(join(dist, 'katex.min.css'), 'utf8')
    .replace(/src:url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]*"\))*/g, (_, name) => `src:${font(name)}`);
  if (/url\(fonts\//.test(css)) throw new Error('KaTeX fonts were not embedded');
  kit = { script: readFileSync(join(dist, 'katex.min.js'), 'utf8'), css };
  return kit;
}

/** Runs inside the page; keep it independent of this module. */
function drawPageMath(source, skip) {
  const rule = new RegExp(source, 'g');
  const skipped = new Set(skip);
  const options = (display) => ({ displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxSize: 20, maxExpand: 1000, output: 'htmlAndMathml' });
  const draw = (root) => {
    const found = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        for (let el = node.parentElement; el; el = el.parentElement) {
          if (skipped.has(el.localName) || el.isContentEditable || el.classList.contains('katex') || el.classList.contains('helm-math-source')) return NodeFilter.FILTER_REJECT;
        }
        rule.lastIndex = 0;
        return rule.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) found.push(walker.currentNode);
    for (const node of found) {
      const parts = document.createDocumentFragment();
      let at = 0;
      rule.lastIndex = 0;
      for (let match; (match = rule.exec(node.data));) {
        const tex = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim();
        if (!tex) continue;
        const display = match[1] !== undefined || match[2] !== undefined;
        parts.append(node.data.slice(at, match.index));
        const box = document.createElement('span');
        box.className = display ? 'helm-math helm-math-display' : 'helm-math';
        try { window.katex.render(tex, box, options(display)); }
        catch { box.className = 'helm-math-source'; box.textContent = match[0]; }
        box.dataset.tex = tex;
        parts.append(box);
        at = match.index + match[0].length;
      }
      if (!at) continue;
      parts.append(node.data.slice(at));
      node.replaceWith(parts);
    }
  };
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      observer.disconnect();
      if (document.body) draw(document.body);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    });
  });
  const start = () => {
    if (document.body) draw(document.body);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  // Copy gives back the TeX, not the drawn pieces twice.
  document.addEventListener('copy', (event) => {
    const selection = getSelection();
    if (!selection?.rangeCount || !event.clipboardData) return;
    const box = document.createElement('div');
    box.append(selection.getRangeAt(0).cloneContents());
    const anchor = selection.anchorNode?.parentElement?.closest('.helm-math');
    if (!box.querySelector('.helm-math') && !anchor) return;
    if (anchor && !box.querySelector('.helm-math')) { event.clipboardData.setData('text/plain', `$${anchor.dataset.tex}$`); event.preventDefault(); return; }
    for (const math of box.querySelectorAll('.helm-math')) {
      const fence = math.classList.contains('helm-math-display') ? '$$' : '$';
      math.replaceWith(`${fence}${math.dataset.tex}${fence}`);
    }
    event.clipboardData.setData('text/plain', box.textContent);
    event.preventDefault();
  });
}

const PAGE_CSS = '.helm-math-display{display:block;overflow-x:auto;overflow-y:hidden;margin:.65em 0}.helm-math-display .katex-display{margin:0}';

function hasMath(node) {
  if (node.nodeName === '#text') return MATH.test(node.value);
  if (node.tagName === 'script') return node.childNodes?.some((child) => child.nodeName === '#text' && SCRIPT_MATH.test(child.value));
  if (SKIP.has(node.tagName)) return false;
  return (node.childNodes ?? []).some(hasMath) || (node.content ? hasMath(node.content) : false);
}

/**
 * Add KaTeX to a parsed page (parse5) that has math in its text or its
 * scripts. Returns true when it did.
 */
export function addPageMath(doc, { parseFragment }) {
  if (!hasMath(doc)) return false;
  const find = (node, name) => node.tagName === name ? node : (node.childNodes ?? []).reduce((hit, child) => hit ?? find(child, name), null);
  const head = find(doc, 'head');
  if (!head) return false;
  const { script, css } = katexKit();
  const boot = `(${drawPageMath.toString()})(${JSON.stringify(MATH.source)}, ${JSON.stringify([...SKIP])})`;
  // First in the head, so the page's own styles and scripts come after it.
  const added = parseFragment(`<style>${css}${PAGE_CSS}</style><script>${script}</script><script>${boot}</script>`, { scriptingEnabled: false });
  for (const node of added.childNodes.reverse()) {
    node.parentNode = head;
    head.childNodes.unshift(node);
  }
  return true;
}
