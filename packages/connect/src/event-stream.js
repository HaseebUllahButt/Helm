/** The reverse reader keeps only the newest replacement of a tool field. */
export function latestToolEvent(event, newer) {
  let shaped = event;
  if (event.type === 'history.reset') newer.clear();
  if (event.id && event.type.startsWith('item.')) {
    const fields = newer.get(event.id) ?? new Set();
    if (event.type === 'item.update' || event.type === 'item.done') {
      for (const key of ['output', 'changes', 'input']) {
        if (!Object.hasOwn(event, key)) continue;
        // Done events replace only defined output and truthy changes.
        // They never replace input. Match the chat reducer's rules.
        if (event.type === 'item.done' && (key === 'input'
          || key === 'output' && event[key] == null
          || key === 'changes' && !event[key])) continue;
        if (fields.has(key)) {
          if (shaped === event) shaped = { ...event };
          delete shaped[key];
        }
        fields.add(key);
      }
    }
    if (event.type === 'item.start') newer.delete(event.id);
    else newer.set(event.id, fields);
  }
  return shaped;
}

/** Keep event order, but send each tool's newest repeated output only once. */
export function streamBatch(events) {
  const newer = new Map();
  const batch = new Array(events.length);
  for (let i = events.length - 1; i >= 0; i--) {
    batch[i] = latestToolEvent(events[i], newer);
  }
  return batch;
}

/** Combine nearby tool updates. Readable text flushes waiting work at once. */
export class ChatEventStream {
  #batches = new Map();
  #timer = null;
  #urgent = false;
  #recipients;
  #emit;

  constructor({ recipients, emit }) {
    this.#recipients = recipients;
    this.#emit = emit;
  }

  push(id, event) {
    const batch = this.#batches.get(id) ?? [];
    batch.push(event);
    this.#batches.set(id, batch);
    const urgent = !event.type.startsWith('item.') || event.type === 'item.delta'
      || event.kind === 'text' || event.kind === 'error' || !!event.error;
    if (this.#timer && (!urgent || this.#urgent)) return;
    clearTimeout(this.#timer);
    this.#urgent = urgent;
    this.#timer = setTimeout(() => this.#flush(), urgent ? 0 : 150);
  }

  #flush() {
    this.#timer = null;
    this.#urgent = false;
    const batches = [...this.#batches];
    this.#batches.clear();
    for (const [id, events] of batches) {
      const to = this.#recipients(id);
      if (to?.length === 0) continue;
      this.#emit(id, streamBatch(events), to);
    }
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#urgent = false;
    this.#batches.clear();
  }
}
