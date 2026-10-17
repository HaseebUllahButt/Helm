/** A CLI's own records, turned into the events a chat is drawn from. */

/** A tool read from a CLI's own files: its one-line summary, plus what Claude said a command was for. */
export const externalInput = (tool) => (tool.name === 'Bash' && tool.description
  ? { command: tool.input, description: tool.description } : tool.input);

/**
 * Messages read from a CLI's own files as the events a chat is drawn from,
 * numbered from 1. `open` leaves the last turn running.
 */
export function transcriptEvents(messages, { open = false } = {}) {
  const events = [];
  let seq = 0, turnId = null, n = 0;
  const push = (event) => events.push({ ...event, seq: ++seq });
  const close = () => { if (turnId) push({ type: 'turn.done', turnId, status: 'ok' }); turnId = null; };
  for (const m of messages) {
    const at = Date.parse(m.at ?? '') || undefined;
    if (m.role === 'user') {
      close();
      turnId = `native-${++n}`;
      push({ type: 'turn.start', turnId, text: m.text ?? '', at });
      continue;
    }
    if (!turnId) { turnId = `native-${++n}`; push({ type: 'turn.start', turnId, text: '', at }); }
    if (m.text) {
      const id = `native-${++n}`;
      push({ type: 'item.start', id, turnId, kind: 'text' });
      push({ type: 'item.delta', id, turnId, text: m.text });
      push({ type: 'item.done', id, turnId, status: 'ok' });
    }
    for (const tool of m.tools ?? []) {
      const id = `native-${++n}`;
      push({ type: 'item.start', id, turnId, kind: 'tool', name: tool.name, input: externalInput(tool) });
      push({ type: 'item.done', id, turnId, status: 'ok' });
    }
  }
  if (!open) close();
  return events;
}
