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

// Completed code blocks recur in the growing Markdown prefix and when a
// chat is reopened. Reuse their colors instead of tokenizing them each time.
// Both bounds keep streamed, ever-changing code from retaining a long chat.
const cache = new Map<string, string>();
let cacheSize = 0;
const MAX_CACHE_SIZE = 1_000_000;
const MAX_CACHE_ENTRIES = 64;

/** Optional color only; Markdown layout and copy controls never wait on this. */
export function highlight(text: string, language: string): string | null {
  if (!language || !hljs.getLanguage(language)) return null;
  const key = `${language}\0${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key); cache.set(key, cached);
    return cached;
  }
  const result = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  const size = (key.length + result.length) * 2;
  if (size <= MAX_CACHE_SIZE) {
    cache.set(key, result); cacheSize += size;
    while (cache.size > MAX_CACHE_ENTRIES || cacheSize > MAX_CACHE_SIZE) {
      const [oldKey, oldValue] = cache.entries().next().value!;
      cache.delete(oldKey); cacheSize -= (oldKey.length + oldValue.length) * 2;
    }
  }
  return result;
}
