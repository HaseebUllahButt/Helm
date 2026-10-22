import { useEffect, useRef } from 'react';
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, serializerCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm, remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { Plugin } from '@milkdown/kit/prose/state';
import { $prose, getMarkdown, replaceAll } from '@milkdown/kit/utils';

/** Table rule rows as people write them (`| --- |`), not one dash per cell. */
const tidy = (md: string) => md.replace(/^\|(?: *:?-+:? *\|)+ *$/gm, (row) => row.replace(/-+/g, '---'));

/**
 * A Markdown file shown as its page, which the owner reads and types into.
 * The editor writes the Markdown again on each change, in the file's own
 * style. Until the owner changes something, the file text passes through as
 * it was, so opening a note never marks it unsaved. It takes focus only when
 * `focus` is set (a new, empty note), so an agent opening a note never pulls
 * the cursor out of the chat. Ctrl/⌘ click opens a link.
 */
export default function PageEditor({ text, label, focus, onChange }: {
  text: string; label: string; focus?: boolean;
  onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  // The text the editor shows now, and how the editor writes the opened file.
  const shown = useRef(text);
  const opened = useRef<{ text: string; written: string } | null>(null);
  const replacing = useRef(false);
  const calls = useRef({ onChange }); calls.current = { onChange };
  const same = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let alive = true;
    const made = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, shown.current);
        // Write lists and tables in the file's own plain style.
        const bullet = /^\s*\* /m.test(shown.current) && !/^\s*- /m.test(shown.current) ? '*' as const : '-' as const;
        ctx.update(remarkStringifyOptionsCtx, (o) => ({ ...o, bullet, rule: '-' as const }));
        ctx.set(remarkGFMPlugin.options.key, { tablePipeAlign: false });
        ctx.update(editorViewOptionsCtx, (o) => ({
          ...o, attributes: { class: 'md canvas-md', spellcheck: 'true', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' },
        }));
      })
      // Each change goes out at once, so Ctrl/⌘ S right after typing saves it.
      .use($prose((ctx) => new Plugin({ view: () => ({ update: (view, before) => {
        // The editor's own fixes while it opens (a table made whole) are not edits.
        const o = opened.current;
        if (!o || replacing.current || view.state.doc.eq(before.doc)) return;
        const markdown = tidy(ctx.get(serializerCtx)(view.state.doc));
        const next = markdown === o.written ? o.text : markdown;
        if (same(next, shown.current)) return;
        shown.current = next;
        calls.current.onChange(next);
      } }) })))
      .use(commonmark).use(gfm).use(history).use(clipboard);
    made.create().then((e) => {
      if (!alive) { void e.destroy(); return; }
      editor.current = e;
      opened.current = { text: shown.current, written: tidy(e.action(getMarkdown())) };
      if (focus) e.action((ctx) => ctx.get(editorViewCtx).focus());
    });
    return () => { alive = false; void editor.current?.destroy(); editor.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The file changed under the editor (the agent wrote it, or the owner chose
  // the new file): show that text instead.
  useEffect(() => {
    if (same(text, shown.current)) return;
    shown.current = text;
    const e = editor.current;
    if (!e) return;
    replacing.current = true;
    try { e.action(replaceAll(text, true)); } finally { replacing.current = false; }
    opened.current = { text, written: tidy(e.action(getMarkdown())) };
  }, [text]);

  return <div ref={host} className="canvas-body canvas-page-edit"
    onClick={(e) => {
      const link = (e.target as HTMLElement).closest('a');
      if (!link?.href || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      window.open(link.href, '_blank', 'noopener');
    }}
    onKeyDown={(e) => {
      // Escape leaves the page instead of closing the canvas.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); (document.activeElement as HTMLElement | null)?.blur(); }
    }} />;
}
