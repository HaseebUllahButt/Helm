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
  const apply = theme => {
    for (const [key, value] of Object.entries(theme)) {
      if (/^--[a-z0-9-]+$/.test(key)) document.documentElement.style.setProperty(key, value);
    }
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

/** The same isolated document is used by the chat and the screenshot preview. */
export function visualDocument(html, { token = '', theme = {}, expanded = false } = {}) {
  const values = JSON.stringify({ token, theme, expanded }).replace(/</g, '\\u003c');
  const boot = `<meta http-equiv="Content-Security-Policy" content="${VISUAL_POLICY}"><meta name="referrer" content="no-referrer"><style>:root{color-scheme:dark;--bg:#14161b;--card:#1b1e24;--raised:#242831;--mutedfg:#9ba2b1;--primary-q:#8590ff;--amber:#e8b23f;--amber-text:#e8b23f;--sky:#8ec6e8;--emerald:#9bc9b6;--red:#e88a8a;--text:#e8eaef;--text-dim:#b9bfcb;--line:#353943;--primary:#8590ff}html,body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif}img,svg,canvas{max-width:100%}body>img:only-child{display:block;max-height:var(--helm-picture-max,900px);width:auto;margin:0 auto}</style><script>(${bootVisual.toString()})(${values})</script>`;
  // Stored pages have been parsed and serialized on the machine first: the
  // first head here is the document head, never text inside an agent script.
  return html.replace(/<head>/i, `<head>${boot}`);
}
