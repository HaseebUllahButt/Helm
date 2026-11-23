/** Hide literal keys even when a pipe delivers one value in several chunks. */
export function keyOutput(values) {
  const patterns = [...new Set(values.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))]
    .filter(Boolean).map(value => Buffer.from(value)).sort((a, b) => b.length - a.length);
  const retain = (patterns[0]?.length ?? 1) - 1;
  const hidden = Buffer.from('[hidden]');
  let pending = Buffer.alloc(0);
  return (chunk, final = false) => {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const limit = final ? data.length : Math.max(0, data.length - retain);
    let offset = 0;
    const parts = [];
    while (offset < limit) {
      let match = null, start = limit;
      for (const pattern of patterns) {
        const at = data.indexOf(pattern, offset);
        if (at !== -1 && at < start) { start = at; match = pattern; }
      }
      parts.push(data.subarray(offset, start));
      if (match) parts.push(hidden);
      offset = start + (match?.length ?? 0);
    }
    pending = data.subarray(offset);
    return Buffer.concat(parts);
  };
}

export function hideKeys(text, values) {
  return keyOutput(values)(Buffer.from(text), true).toString('utf8');
}
