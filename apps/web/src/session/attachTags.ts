/**
 * Tags in the message box that stand for one thing: "[Image #2]", "[File:
 * notes.pdf]" and a big paste's "⟦pasted text 1 · 3,412 chars⟧". A delete
 * that touches one takes all of it, so a single Backspace removes the tag
 * and the composer drops the attachment behind it. Read from the change
 * itself, not the key, because phone keyboards do not report Backspace.
 */
const TAG = /\[Image #\d+\]|\[File: [^\]\n]+\]|⟦pasted text \d+ · [\d,]+ chars⟧/g;

export type TagEdit = { text: string; caret: number; removed: string[] };

/**
 * `before` became `after` by a deletion that cut into a tag: the text with
 * every touched tag gone whole, where the caret goes, and the tags removed.
 * Null for any other change - typing, or a delete that touched no tag.
 * `live` says which tags still stand for something; a "[Image #9]" typed
 * by hand is only letters.
 */
export function wholeTagEdit(before: string, after: string, live: (tag: string) => boolean = () => true): TagEdit | null {
  if (after.length >= before.length) return null;
  let head = 0;
  while (head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  // Only a pure deletion: nothing typed in place of what went.
  if (head + tail !== after.length) return null;
  let from = head, to = before.length - tail;
  const removed: string[] = [];
  let touched = false;
  for (const m of before.matchAll(TAG)) {
    const start = m.index!, end = start + m[0].length;
    if (end <= from || start >= to) continue;
    if (!live(m[0])) continue;
    if (start < from || end > to) touched = true;
    from = Math.min(from, start);
    to = Math.max(to, end);
    removed.push(m[0]);
  }
  // A whole tag deleted by selection is already gone; it still takes its attachment.
  if (!removed.length) return null;
  // The space written after a tag leaves with it, unless it separates words.
  if (touched && before[to] === ' ' && (from === 0 || /\s/.test(before[from - 1]))) to++;
  return { text: before.slice(0, from) + before.slice(to), caret: from, removed };
}

/**
 * After pictures are removed: any other copy of a gone label leaves too, and
 * the labels after them move up, so "[Image #2]" still names the second one.
 */
export function renumberImages(text: string, gone: number[]): string {
  if (!gone.length) return text;
  return text.replace(/\[Image #(\d+)\]( ?)/g, (_, n, space) => {
    const at = Number(n);
    if (gone.includes(at)) return '';
    return `[Image #${at - gone.filter((g) => g < at).length}]${space}`;
  });
}
