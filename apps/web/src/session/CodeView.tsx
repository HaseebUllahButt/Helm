import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { highlightCode, loadHighlighting, hasHighlighting } from '../md';

/**
 * Code to read, not edit: a whole file or a diff, drawn as rows with a line
 * number gutter. Wrapped lines stay in the code column instead of running
 * back under the numbers, which is what made diffs hard to read on a phone.
 */

const LANG: Record<string, string> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', css: 'css',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml', go: 'go', rs: 'rust', sql: 'sql',
  yaml: 'yaml', yml: 'yaml', md: 'markdown', diff: 'diff', patch: 'diff',
};
export const langOf = (path: string) => LANG[(/\.([^./]+)$/.exec(path)?.[1] ?? '').toLowerCase()] ?? '';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Coloured HTML cut into lines. highlight.js spans can cross a newline (a
 * block comment, a long string), so each line closes what is open at its end
 * and the next one reopens it.
 */
function htmlLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === '\n') { lines.push(line + '</span>'.repeat(open.length)); line = open.join(''); }
    else if (part.startsWith('<span')) { open.push(part); line += part; }
    else if (part === '</span>') { open.pop(); line += part; }
    else line += part;
  }
  lines.push(line);
  return lines;
}

/** One line of HTML per line of `text`, coloured when highlighting is ready. */
function colour(text: string, language: string, ready: boolean): string[] {
  const html = ready && language && text.length <= 400_000 ? highlightCode(text, language) : null;
  return html ? htmlLines(html) : text.split('\n').map(escapeHtml);
}

function useHighlighting() {
  const [ready, setReady] = useState(hasHighlighting);
  useEffect(() => {
    let live = true;
    loadHighlighting().then(() => { if (live) setReady(hasHighlighting()); });
    return () => { live = false; };
  }, []);
  return ready;
}

/** Tabs as two spaces, so indents line up and can be trimmed. */
const untab = (s: string) => s.replace(/^\t+/, (t) => '  '.repeat(t.length));
const indentOf = (s: string) => (s.trim() ? /^ */.exec(s)![0].length : Infinity);

type Row =
  | { kind: 'add' | 'del' | 'ctx'; n: number; text: string }
  | { kind: 'hunk'; n: number; text: string };

/** `@@ -34,6 +34,7 @@ export function x` -> rows with line numbers. File headers are dropped. */
function diffRows(diff: string): Row[] {
  const rows: Row[] = [];
  let oldN = 0, newN = 0, head = true;
  for (const l of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (hunk) {
      head = false; oldN = Number(hunk[1]); newN = Number(hunk[2]);
      rows.push({ kind: 'hunk', n: newN, text: hunk[3] });
      continue;
    }
    if (head && /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) continue;
    if (l.startsWith('\\')) continue; // "\ No newline at end of file"
    if (l.startsWith('+')) rows.push({ kind: 'add', n: newN++, text: untab(l.slice(1)) });
    else if (l.startsWith('-')) rows.push({ kind: 'del', n: oldN++, text: untab(l.slice(1)) });
    else if (!head) { rows.push({ kind: 'ctx', n: newN, text: untab(l.slice(1)) }); oldN++; newN++; }
  }
  while (rows.length && rows[rows.length - 1].kind === 'ctx' && !rows[rows.length - 1].text) rows.pop();
  return rows;
}

const SIGN = { add: '+', del: '−', ctx: ' ' };

/**
 * A diff. `trim` cuts the indent every line shares, so a change deep inside
 * a function starts at the left edge instead of half a phone width in.
 */
export function DiffView({ text, path, wrap, trim = wrap }: { text: string; path: string; wrap: boolean; trim?: boolean }) {
  const ready = useHighlighting();
  const language = langOf(path);
  const rows = useMemo(() => diffRows(text), [text]);
  const html = useMemo(() => {
    // The new side and the old side are each coloured as a whole, so a
    // comment or string that spans lines is coloured right on both.
    const side = (keep: 'add' | 'del') => {
      const picked = rows.filter((r) => r.kind === 'ctx' || r.kind === keep);
      const lines = colour(picked.map((r) => r.text).join('\n'), language, ready);
      return new Map(picked.map((r, i) => [r, lines[i]]));
    };
    const after = side('add'), before = side('del');
    return (r: Row) => after.get(r) ?? before.get(r) ?? escapeHtml(r.text);
  }, [rows, language, ready]);
  const cut = useMemo(() => {
    if (!trim) return 0;
    const n = Math.min(...rows.filter((r) => r.kind !== 'hunk').map((r) => indentOf(r.text)));
    return Number.isFinite(n) ? n : 0;
  }, [rows, trim]);
  if (!rows.length) return <div className="cv-empty">The text did not change.</div>;
  const digits = String(Math.max(...rows.map((r) => r.n), 1)).length;
  return (
    <div className={`cv diff-view${wrap ? ' wrap' : ''}`} style={{ '--cv-digits': `${digits}ch` } as CSSProperties}>
      <div className="cv-in">
        {rows.map((r, i) => r.kind === 'hunk'
          ? <div key={i} className="cv-hunk"><span>Line {r.n}</span>{r.text && <code>{r.text.trim()}</code>}</div>
          : <div key={i} className={`cv-row ${r.kind}`}>
              <span className="cv-n" aria-hidden="true">{r.n}</span>
              <span className="cv-s" aria-label={r.kind === 'add' ? 'added' : r.kind === 'del' ? 'removed' : undefined}>{SIGN[r.kind]}</span>
              <code className="cv-c" dangerouslySetInnerHTML={{ __html: trimHtml(html(r), cut) || ' ' }} />
            </div>)}
      </div>
    </div>
  );
}

/** Drops `n` leading spaces from a line of HTML whose first characters are the indent. */
function trimHtml(html: string, n: number): string {
  if (!n) return html;
  let i = 0, dropped = 0, out = '';
  while (i < html.length && dropped < n) {
    if (html[i] === '<') { const end = html.indexOf('>', i); out += html.slice(i, end + 1); i = end + 1; }
    else if (html[i] === ' ') { i++; dropped++; }
    else break;
  }
  return out + html.slice(i);
}

/** A whole file, with `mark` lines (1-based, inclusive) picked out. */
export function FileView({ text, path, wrap, mark }: { text: string; path: string; wrap: boolean; mark?: [number, number] }) {
  const ready = useHighlighting();
  const lines = useMemo(() => colour(text.replace(/\n$/, '').split('\n').map(untab).join('\n'), langOf(path), ready), [text, path, ready]);
  useEffect(() => {
    if (mark) document.getElementById(`cv-line-${mark[0]}`)?.scrollIntoView({ block: 'center' });
  }, [mark, lines.length]);
  return (
    <div className={`cv file-view${wrap ? ' wrap' : ''}`} style={{ '--cv-digits': `${String(lines.length).length}ch` } as CSSProperties}>
      <div className="cv-in">
        {lines.map((l, i) => (
          <div key={i} id={`cv-line-${i + 1}`} className={`cv-row${mark && i + 1 >= mark[0] && i + 1 <= mark[1] ? ' mark' : ''}`}>
            <span className="cv-n" aria-hidden="true">{i + 1}</span>
            <code className="cv-c" dangerouslySetInnerHTML={{ __html: l || ' ' }} />
          </div>
        ))}
      </div>
    </div>
  );
}
