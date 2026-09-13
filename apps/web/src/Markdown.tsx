import { useEffect, useMemo, useRef } from 'react';
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

for (const [name, lang] of Object.entries({
  javascript, js: javascript, jsx: javascript, typescript, ts: typescript, tsx: typescript,
  python, py: python, bash, sh: bash, shell: bash, zsh: bash, json, css, xml, html: xml,
  go, rust, rs: rust, sql, yaml, yml: yaml, markdown, md: markdown, diff,
})) hljs.registerLanguage(name, lang);

/**
 * Agent prose as prose. The transcript is markdown - headings, lists, fenced
 * code - and rendering it is the difference between a chat you can read on a
 * phone and a wall of asterisks. Code blocks get a header with the language
 * and a copy button, the way T3 Code does it, and syntax colour for the
 * languages agents actually write. Sanitised because the agent's output
 * includes whatever it read from the web or a file.
 */
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

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ['data-copy'] });
  }, [text]);

  // One delegated handler for every copy button in this message.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onClick = async (ev: Event) => {
      const btn = (ev.target as HTMLElement).closest('button[data-copy]') as HTMLButtonElement | null;
      if (!btn) return;
      const code = btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
      try { await navigator.clipboard.writeText(code); btn.textContent = 'copied'; }
      catch { btn.textContent = 'failed'; }
      setTimeout(() => { btn.textContent = 'copy'; }, 1500);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);

  return <div ref={host} className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
