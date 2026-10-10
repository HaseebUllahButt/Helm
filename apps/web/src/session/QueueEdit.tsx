import { useRef, useState, type FormEvent } from 'react';
import { Sheet } from '../Modal';
import { Icon } from '../Icon';
import { IMAGE_ACCEPT, looksLikeImage, prepareImage, clipboardImages } from './image';
import type { Turn } from './types';

type Image = { filename: string; mime: string; data: string };

/**
 * Editing a message still waiting in the queue: its words and its pictures.
 * Pictures can be added (button or paste), removed, and are labelled the way
 * the composer labels them, so "[Image #2]" still means the second one.
 */
export function QueueEdit({ turn, busy, onCancel, onSave }: {
  turn: Turn; busy?: boolean; onCancel: () => void;
  onSave: (text: string, attachments: Image[]) => void;
}) {
  const [text, setText] = useState(turn.text);
  const [images, setImages] = useState<Image[]>(() => (turn.attachments ?? [])
    .filter((a) => a.data).map((a) => ({ filename: a.filename, mime: a.mime, data: a.data! })));
  const [error, setError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const add = async (files: File[]) => {
    const picked = files.filter(looksLikeImage);
    if (!picked.length) return;
    setError('');
    const at = box.current?.selectionStart ?? text.length;
    const ready: Image[] = [];
    for (const f of picked) {
      try { const p = await prepareImage(f); ready.push({ filename: p.name, mime: p.mime, data: p.data }); }
      catch (e: any) { setError(`${f.name}: ${e.message}`); }
    }
    if (!ready.length) return;
    const labels = ready.map((_, i) => `[Image #${images.length + i + 1}]`).join(' ');
    setImages((now) => [...now, ...ready]);
    setText((now) => {
      const pre = now.slice(0, at), post = now.slice(at);
      return `${pre}${pre && !/\s$/.test(pre) ? ' ' : ''}${labels}${/^\s/.test(post) ? '' : ' '}${post}`;
    });
  };
  const remove = (index: number) => {
    const gone = index + 1;
    setImages((now) => now.filter((_, i) => i !== index));
    setText((now) => now.replace(new RegExp(`\\[Image #${gone}\\] ?`, 'g'), '')
      .replace(/\[Image #(\d+)\]/g, (label, n) => Number(n) > gone ? `[Image #${Number(n) - 1}]` : label));
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (text.trim() || images.length) onSave(text.trim(), images);
  };

  return (
    <Sheet onClose={onCancel} label="Edit queued message">
      <form onSubmit={submit}>
        <div className="modal-title">Edit queued message</div>
        {images.length > 0 && (
          <div className="attach-previews">
            {images.map((a, i) => (
              <span key={i} className="attach-preview" title={`[Image #${i + 1}] ${a.filename}`}>
                <img src={`data:${a.mime};base64,${a.data}`} alt={`Image #${i + 1}`} />
                <button type="button" onClick={() => remove(i)} aria-label={`remove Image #${i + 1}`}><Icon name="close" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea ref={box} className="modal-input" aria-label="Edit queued message" value={text} rows={5} maxLength={32000}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = clipboardImages(event.clipboardData);
            if (files.length) { event.preventDefault(); void add(files); }
          }} />
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost queue-edit-add" disabled={busy} onClick={() => file.current?.click()}>
            <Icon name="image" size={14} /> Add image
          </button>
          <input ref={file} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={(e) => { if (e.target.files?.length) void add(Array.from(e.target.files)); e.target.value = ''; }} />
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || (!text.trim() && !images.length)}>{busy ? '…' : 'Save'}</button>
        </div>
      </form>
    </Sheet>
  );
}
