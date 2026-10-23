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
