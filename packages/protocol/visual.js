export const VISUAL_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** A real document avoids inheriting the app's script-src policy via srcdoc. */
function loadVisual() {
  const receive = event => {
    if (event.source !== parent || event.data?.type !== 'helm.visual.load' || typeof event.data.html !== 'string') return;
    removeEventListener('message', receive);
    document.open();
    document.write(event.data.html);
    document.close();
  };
  addEventListener('message', receive);
}

export function visualHostDocument() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>(${loadVisual.toString()})()</script></body></html>`;
}

/** Runs inside the opaque iframe; keep it independent of this module. */
function bootVisual(config) {
  // The theme goes into Helm's own style element, not inline on <html>, so a
  // page's own :root rules still win where the page sets them.
  const sheet = document.getElementById('helm-theme');
  const apply = theme => {
    let rule = '';
    for (const [key, value] of Object.entries(theme)) {
      if (/^--[a-z0-9-]+$/.test(key) && value) rule += `${key}:${String(value).replace(/[;{}<>]/g, '')};`;
    }
    if (sheet) sheet.textContent = `:root{${rule}}`;
    document.documentElement.style.colorScheme = theme.scheme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme.scheme || 'dark';
  };
  apply(config.theme);
  // In the chat a lone picture fits a screen (see the style below); full size, it fills the frame.
  if (config.expanded) document.documentElement.style.setProperty('--helm-picture-max', '100vh');
  addEventListener('message', event => {
    if (event.source === parent && event.data?.type === 'helm.visual.theme' && event.data.token === config.token) apply(event.data.theme || {});
  });
  const send = detail => parent.postMessage({ type: 'helm.visual', token: config.token, ...detail }, '*');
  let height = 0;
  const measure = () => {
    const next = Math.ceil(Math.max(document.body?.scrollHeight || 0, document.body?.getBoundingClientRect().height || 0));
    if (next !== height) { height = next; send({ height }); }
  };
  addEventListener('DOMContentLoaded', () => { new ResizeObserver(measure).observe(document.body); measure(); });
  addEventListener('load', measure);
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (href?.startsWith('#')) return;
    if (parent === window) return; // downloaded page: ordinary browser links
    event.preventDefault();
    if (event.isTrusted && /^https?:\/\//i.test(href || '')) send({ href });
  }, true);
  document.addEventListener('keydown', event => {
    if (parent !== window && event.key === 'Escape' && event.isTrusted) { event.preventDefault(); send({ escape: true }); }
  }, true);
}

/**
 * Chart colours from the dataviz skill's reference palette (2026-11-02): eight
 * series colours in a fixed order that colour-blind readers can still tell
 * apart next to each other, each stepped for the dark or light surface.
 * Checked with its validate_palette.js on Helm's dark, navy and light
 * backgrounds. In light mode slots 2-5 sit below 3:1, so charts label them.
 * Status colours are kept apart from series colours.
 */
const CHART_DARK = '--chart-1:#3987e5;--chart-2:#d95926;--chart-3:#199e70;--chart-4:#c98500;--chart-5:#d55181;--chart-6:#008300;--chart-7:#9085e9;--chart-8:#e66767;' +
  '--grid:#2c2c2a;--axis:#383835;--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;';
const CHART_LIGHT = '--chart-1:#2a78d6;--chart-2:#eb6834;--chart-3:#1baf7a;--chart-4:#eda100;--chart-5:#e87ba4;--chart-6:#008300;--chart-7:#6250d6;--chart-8:#e34948;' +
  '--grid:#e1e0d9;--axis:#c3c2b7;--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;';
/** The series colours, for diagrams drawn outside a page. */
export const CHART_COLOURS = {
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
};

/**
 * What every saved page starts from, as T3 Code does: Helm's colours, font
 * and text size, so a page looks like part of the reply before it adds a
 * line of its own CSS. The theme style after it fills in the live values.
 * The --chart-* colours are one set of series colours for every chart.
 * The common shadcn names (--background, --foreground, --border …) point at
 * Helm's colours, so a page written for them looks right too.
 */
export const VISUAL_BASE_CSS = ':root{color-scheme:dark;--bg:#0a0a0a;--card:#131313;--raised:#1c1c1c;--mutedfg:#9ba2b1;--primary-q:#a693ff;--amber:#e8b23f;--amber-text:#e8b23f;--sky:#8ec6e8;--emerald:#9bc9b6;--red:#e88a8a;--text:#ededed;--text-dim:#c0c0c0;--line:#2a2a2a;--primary:#7c5cff;' +
  '--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--font-mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;--radius:9px;' +
  CHART_DARK +
  '--background:var(--bg);--foreground:var(--text);--muted:var(--card);--muted-foreground:var(--mutedfg);--card-foreground:var(--text);--border:var(--line);--accent:var(--chart-1);--success:var(--good);--destructive:var(--critical)}' +
  `:root[data-theme="light"]{${CHART_LIGHT}}` +
  'html{background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}' +
  'body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}img,svg,canvas,video{max-width:100%}' +
  ':where(:focus-visible){outline:2px solid var(--primary-q);outline-offset:-2px}' +
  'body>img:only-child{display:block;max-height:var(--helm-picture-max,900px);width:auto;margin:0 auto}';

/** The same isolated document is used by the chat and the screenshot preview. */
export function visualDocument(html, { token = '', theme = {}, expanded = false } = {}) {
  const values = JSON.stringify({ token, theme, expanded }).replace(/</g, '\\u003c');
  const boot = `<meta http-equiv="Content-Security-Policy" content="${VISUAL_POLICY}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${VISUAL_BASE_CSS}</style><style id="helm-theme"></style><script>(${bootVisual.toString()})(${values})</script>`;
  // Stored pages have been parsed and serialized on the machine first: the
  // first head here is the document head, never text inside an agent script.
  return html.replace(/<head>/i, `<head>${boot}`);
}
