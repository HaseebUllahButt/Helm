import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';

/**
 * The markdown engine, kept out of the first load.
 *
 * marked, DOMPurify and highlight.js together are a third of the JavaScript
 * this app ships, and none of it is needed to sign in or to pick a machine.
 * Splitting it into its own chunk means a phone on a slow link paints the
 * machine list without waiting for a syntax highlighter it may never use.
 * `Markdown.tsx` pulls this in on idle, so by the time a conversation opens
 * it is almost always already here.
 */

for (const [name, lang] of Object.entries({
  javascript, js: javascript, jsx: javascript, typescript, ts: typescript, tsx: typescript,
  python, py: python, bash, sh: bash, shell: bash, zsh: bash, json, css, xml, html: xml,
  go, rust, rs: rust, sql, yaml, yml: yaml, markdown, md: markdown, diff,
})) hljs.registerLanguage(name, lang);

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const codeBlock = ({ text, lang }: { text: string; lang?: string }) => {
  const language = (lang || '').split(/\s+/)[0].toLowerCase();
  const known = language && hljs.getLanguage(language);
  const body = known
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeHtml(text);
  return `<div class="codeblock"><div class="codehead"><span>${escapeHtml(language || 'text')}</span>` +
    `<button type="button" class="copy" data-copy>copy</button></div>` +
    `<pre><code class="hljs${known ? ` language-${language}` : ''}">${body}</code></pre></div>`;
};
marked.use({ gfm: true, breaks: true, renderer: { code: codeBlock } });

/** Sanitised because an agent's output includes whatever it read from the web. */
export function render(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ['data-copy'] });
}
