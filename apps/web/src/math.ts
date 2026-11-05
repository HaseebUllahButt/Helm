import type Katex from 'katex';

/**
 * Math in a reply ($...$, $$...$$, \(...\), \[...\], ```math) is drawn with
 * KaTeX, as in T3 Code. md.ts marks each formula as a `.math` box that holds
 * its TeX as plain text, so the reader sees the source until KaTeX arrives
 * and a formula KaTeX cannot read stays readable.
 *
 * KaTeX output is added after DOMPurify, not passed through it: it needs
 * inline styles the sanitiser removes. That is safe because the TeX is only
 * text, `trust` stays off (no links, classes, styles or HTML from TeX), and
 * `maxSize` keeps a formula from covering the screen.
 */

let katex: typeof Katex | null = null;
let loading: Promise<void> | null = null;
function loadKatex(): Promise<void> {
  loading ??= import('./katex').then((module) => { katex = module.default; }).catch(() => { loading = null; });
  return loading;
}

// "" records TeX that KaTeX cannot read: it stays as its source, as in T3 Code.
const drawn = new Map<string, string>();
const MAX_DRAWN = 500;
function draw(tex: string, display: boolean): string {
  const key = (display ? 'd:' : 'i:') + tex;
  let html = drawn.get(key);
  if (html === undefined) {
    try {
      html = katex!.renderToString(tex, {
        displayMode: display, throwOnError: true, trust: false, strict: 'ignore',
        maxSize: 20, maxExpand: 1000, output: 'htmlAndMathml',
      });
    } catch { html = ''; }
    if (drawn.size >= MAX_DRAWN) drawn.delete(drawn.keys().next().value!);
    drawn.set(key, html);
  }
  return html;
}

/** Draw every formula still shown as source under root. */
export function drawMath(root: HTMLElement): void {
  const boxes = root.querySelectorAll<HTMLElement>('.math:not([data-tex])');
  if (!boxes.length) return;
  if (!katex) {
    void loadKatex().then(() => { if (katex && root.isConnected) drawMath(root); });
    return;
  }
  for (const box of boxes) {
    const tex = box.textContent ?? '';
    const html = draw(tex, box.classList.contains('math-display'));
    if (html) box.innerHTML = html;
    else box.classList.add('math-source');
    // Copy gives back the source (copySelection.ts).
    box.dataset.tex = tex;
  }
}
