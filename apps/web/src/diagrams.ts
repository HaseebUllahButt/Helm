import DOMPurify from 'dompurify';
import type { Mermaid } from 'mermaid';
import { CHART_COLOURS } from '@helm/protocol/visual';

/**
 * A ```mermaid block in a finished reply is drawn as a diagram, as T3 Code
 * does. Agents that cannot draw otherwise make boxes from text characters,
 * which break on a phone. The block keeps its source: Code shows it, Copy
 * copies it, and a broken diagram stays as code with the parser's message.
 *
 * Mermaid is about 1 MB, so it loads only when a diagram is on the screen.
 */

let mermaidModule: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  mermaidModule ??= import('mermaid').then((module) => module.default).catch((error: unknown) => {
    mermaidModule = null;
    throw error;
  });
  return mermaidModule;
}

type Drawn = { svg: string } | { error: string; retry: boolean };
// Keyed by theme and source. Settled results are kept so a reply that is
// built again (chat switch, highlighter arriving) shows its diagram at once.
const drawn = new Map<string, Drawn>();
const pending = new Map<string, Promise<Drawn>>();
const MAX_DRAWN = 64;
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
let purifier: ReturnType<typeof DOMPurify> | null = null;
// Diagrams come from agent text, so strip anything that can run script,
// follow a link or fetch a remote file, on top of Mermaid's strict mode.
function cleanSvg(svg: string): string {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.addHook('uponSanitizeElement', (node, data) => {
      if (data.tagName === 'style' && node.textContent) node.textContent = node.textContent.replace(REMOTE_CSS_URL, 'none');
    });
    purifier.addHook('uponSanitizeAttribute', (_node, data) => {
      if (data.attrName === 'style') data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, 'none');
    });
  }
  return purifier.sanitize(svg, {
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset', 'tabindex'],
    FORBID_TAGS: ['a', 'img', 'image', 'script'],
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
  }) as string;
}

/** Any CSS colour as #rrggbb: Mermaid reads hex and rgb, not oklch or var(). */
let probe: CanvasRenderingContext2D | null = null;
function hex(value: string, fallback: string): string {
  if (!value || value === 'transparent') return fallback;
  probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  if (!probe) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  if (a < 200) return fallback;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

const light = (color: string) => {
  const n = parseInt(color.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.5;
};

/**
 * Helm's current theme as Mermaid's base theme, so a diagram looks like the
 * chat: grey boxes with hairline edges and quiet lines, not the accent
 * colour. Where Mermaid colours parts (pie slices, timelines, mind maps,
 * charts) it takes the same tested series colours as saved pages.
 */
function diagramTheme() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const bg = hex(read('--bg'), '#0a0a0a');
  const dark = !light(bg);
  const text = hex(read('--text'), dark ? '#ededed' : '#1a1d24');
  const dim = hex(read('--text-dim'), dark ? '#c0c0c0' : '#3d4350');
  const raised = hex(read('--raised'), dark ? '#1c1c1c' : '#ffffff');
  const card = hex(read('--card'), dark ? '#131313' : '#ffffff');
  const edge = dark ? '#383835' : '#c3c2b7';
  const line = '#898781';
  const series = CHART_COLOURS[dark ? 'dark' : 'light'];
  const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  const numbered = (name: string, values: string[]) => Object.fromEntries(values.map((value, i) => [`${name}${i}`, value]));
  return {
    font,
    variables: {
      darkMode: dark, background: bg, fontFamily: font, fontSize: '14px',
      primaryColor: raised, primaryTextColor: text, primaryBorderColor: edge,
      secondaryColor: card, secondaryTextColor: text, secondaryBorderColor: edge,
      tertiaryColor: card, tertiaryTextColor: text, tertiaryBorderColor: edge,
      lineColor: line, textColor: text, mainBkg: raised, nodeBorder: edge,
      clusterBkg: card, clusterBorder: edge, titleColor: text, edgeLabelBackground: bg,
      noteBkgColor: card, noteTextColor: dim, noteBorderColor: edge,
      actorBkg: raised, actorBorder: edge, actorTextColor: text, actorLineColor: line,
      signalColor: line, signalTextColor: text, labelBoxBkgColor: card, labelBoxBorderColor: edge,
      activationBkgColor: card, activationBorderColor: edge, sequenceNumberColor: dark ? '#0b0b0b' : '#ffffff',
      // Pie slices, mind map branches, timeline sections, quadrant and journey colours.
      ...Object.fromEntries(series.map((colour, i) => [`pie${i + 1}`, colour])),
      pieStrokeColor: bg, pieStrokeWidth: '2px', pieOpacity: '1', pieOuterStrokeWidth: '0px', pieTitleTextColor: text, pieSectionTextColor: '#ffffff', pieLegendTextColor: dim,
      ...numbered('cScale', series),
      ...numbered('cScaleLabel', series.map(() => '#ffffff')),
      ...numbered('git', series),
      xyChart: { backgroundColor: bg, titleColor: text, xAxisLabelColor: dim, yAxisLabelColor: dim, xAxisTitleColor: dim, yAxisTitleColor: dim, xAxisLineColor: edge, yAxisLineColor: edge, xAxisTickColor: edge, yAxisTickColor: edge, plotColorPalette: series.join(',') },
    },
  };
}

// Mermaid fetches more of itself while it draws; a lost connection is worth a retry, bad syntax is not.
const CHUNK_ERROR = /dynamically imported module|importing a module script|failed to fetch/i;

async function draw(source: string, theme: ReturnType<typeof diagramTheme>): Promise<Drawn> {
  let mermaid: Mermaid;
  try { mermaid = await loadMermaid(); }
  catch { return { error: 'Helm cannot load the diagram tool.', retry: true }; }
  const id = `helm-diagram-${nextId++}`;
  try {
    // initialize() changes one shared setting, so diagrams draw one at a time.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      // A diagram must not turn these back on with its own settings line.
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'theme', 'themeVariables', 'fontFamily'],
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: 'base',
      themeVariables: theme.variables,
      fontFamily: theme.font,
    });
    const { svg } = await mermaid.render(id, source);
    return { svg: cleanSvg(svg) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The diagram has an error.';
    return { error: message, retry: CHUNK_ERROR.test(message) };
  } finally {
    document.getElementById(`d${id}`)?.remove();
  }
}

function result(source: string): Drawn | Promise<Drawn> {
  const theme = diagramTheme();
  const key = `${JSON.stringify(theme.variables)}\n${source}`;
  const hit = drawn.get(key);
  if (hit) { drawn.delete(key); drawn.set(key, hit); return hit; }
  let job = pending.get(key);
  if (!job) {
    job = queue.then(() => draw(source, theme));
    queue = job;
    pending.set(key, job);
    void job.then((done) => {
      pending.delete(key);
      if ('error' in done && done.retry) return;
      drawn.set(key, done);
      for (const old of drawn.keys()) { if (drawn.size <= MAX_DRAWN) break; drawn.delete(old); }
    });
  }
  return job;
}

function button(label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'copy'; b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function show(block: HTMLElement, done: Drawn) {
  block.querySelector(':scope > .diagram-view, :scope > .diagram-error')?.remove();
  block.querySelector(':scope > .codehead .diagram-toggle')?.remove();
  const pre = block.querySelector(':scope > pre');
  if ('error' in done) {
    const note = document.createElement('div');
    note.className = 'diagram-error'; note.setAttribute('role', 'note');
    note.textContent = `Helm cannot draw this diagram: ${done.error.split('\n')[0]}`;
    if (done.retry) note.append(' ', button('Try again', () => paint(block, true)));
    block.insertBefore(note, pre);
    block.classList.remove('diagram-shown');
    return;
  }
  const view = document.createElement('button');
  view.type = 'button'; view.className = 'diagram-view';
  view.setAttribute('aria-label', 'Open the diagram full size');
  view.innerHTML = done.svg;
  view.addEventListener('click', () => openFull(done.svg));
  block.insertBefore(view, pre);
  block.classList.add('diagram-shown');
  const toggle = button('Code', () => {
    const code = block.classList.toggle('diagram-shown') === false;
    toggle.textContent = code ? 'Diagram' : 'Code';
  });
  toggle.classList.add('diagram-toggle');
  block.querySelector(':scope > .codehead .copy')?.before(toggle);
}

function paint(block: HTMLElement, again = false) {
  const source = block.querySelector(':scope > pre code')?.textContent?.trim() ?? '';
  if (!source) return;
  block.dataset.drawn = '1';
  const done = result(source);
  if (!(done instanceof Promise)) { show(block, done); return; }
  if (!again) block.classList.add('diagram-drawing');
  void done.then((settled) => { block.classList.remove('diagram-drawing'); if (block.isConnected) show(block, settled); });
}

/** Draws every finished diagram block inside `root` that is not drawn yet. */
export function drawDiagrams(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>('.codeblock.diagram:not([data-drawn])');
  if (!blocks.length) return;
  watchTheme();
  blocks.forEach((block) => paint(block));
}

// A theme change draws the diagrams on screen again in the new colours.
let watching = false;
function watchTheme() {
  if (watching) return;
  watching = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => document.querySelectorAll<HTMLElement>('.codeblock.diagram[data-drawn]').forEach((block) => paint(block, true)), 50);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
}

/** The diagram on its own over the page; Escape, Close or a tap outside closes it. */
function openFull(svg: string) {
  const back = document.createElement('div');
  back.className = 'modal-back diagram-back';
  const box = document.createElement('div');
  box.className = 'diagram-full';
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Diagram');
  box.tabIndex = -1;
  const bar = document.createElement('div');
  bar.className = 'visual-bar';
  const name = document.createElement('strong');
  name.textContent = 'Diagram';
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = 'Close';
  const actions = document.createElement('span');
  actions.className = 'visual-actions';
  actions.append(close);
  bar.append(name, actions);
  const body = document.createElement('div');
  body.className = 'diagram-full-body';
  body.innerHTML = svg;
  box.append(bar, body);
  back.append(box);
  const before = document.activeElement as HTMLElement | null;
  const end = () => { back.remove(); document.removeEventListener('keydown', key, true); before?.focus?.(); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end(); } };
  close.addEventListener('click', end);
  back.addEventListener('click', (event) => { if (event.target === back) end(); });
  document.addEventListener('keydown', key, true);
  document.body.append(back);
  box.focus();
}
