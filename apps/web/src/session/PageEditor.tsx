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
 * A Markdown file edited as the page it makes, the way Read shows it. The
 * editor writes the Markdown again on each change, so a save can tidy small
 * details (spacing, list marks). Until the owner changes something, the file
 * text passes through as it was, so opening Edit alone never marks it unsaved.
 */
export default function PageEditor({ text, label, onChange, onEscape }: {
  text: string; label: string;
  onChange: (text: string) => void;
  onEscape: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  // The text the editor shows now, and how the editor writes the opened file.
  const shown = useRef(text);
  const opened = useRef<{ text: string; written: string } | null>(null);
  const replacing = useRef(false);
  const calls = useRef({ onChange, onEscape }); calls.current = { onChange, onEscape };
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
      e.action((ctx) => ctx.get(editorViewCtx).focus());
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
    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); calls.current.onEscape(); } }} />;
}
