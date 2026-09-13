import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Agent prose as prose. The transcript is markdown - headings, lists, fenced
 * code - and rendering it is the difference between a chat you can read on a
 * phone and a wall of asterisks. Sanitised because the agent's output includes
 * whatever it read from the web or a file.
 */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [text]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
