/** Naming fallbacks for engines that do not generate their own session name. */
export const GREETING = /^(hi+|hey+|hello+|yo|sup|hiya|howdy|test(ing)?|ping|ok(ay)?|thanks?( you)?|good (morning|afternoon|evening))[.\s!?,]*$/i;

/** Find the request, skipping greetings and the context wrappers CLIs prepend. */
/**
 * A title is what the owner said. "[Image #1]" and "[Pasted text #2 +40
 * lines]" are labels the CLIs put in the message for the model, not words.
 */
export function bareTitle(title) {
  return String(title ?? '').replace(/\[(?:Image|Pasted text) #\d+[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function informative(text) {
  const body = bareTitle(text) === '' ? '' : String(text ?? '').replace(/\[(?:Image|Pasted text) #\d+[^\]]*\] ?/g, '').replace(
    /<(environment_context|recommended_plugins|system_reminder|instructions|[\w-]+_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  for (const raw of body.split('\n')) {
    let line = raw.trim().replace(/^#{1,6}\s+/, '').replace(/^(?:[-*]|\d+[.)])\s+/, '');
    if (!line || GREETING.test(line) || /^<[^>]+>$/.test(line) || /^```/.test(line)) continue;
    // Headers introduce the actual request on the following line.
    if (/^(?:(?:please\s+)?(?:help me with|do)\s+)?(?:the following|instructions|task|request|context)\s*:?$/i.test(line)) continue;
    line = line
      .replace(/^(?:hi|hey|hello|alright|okay)[!,.:]?\s+(?:so[, ]+)?/i, '')
      .replace(/^what I (?:want|need) you to do is\s+(?:that\s+)?/i, '')
      .replace(/^(?:please\s+)?(?:can|could|would) you\s+(?:please\s+)?/i, '')
      .replace(/^(?:I (?:want|need|would like) you to|I'd like you to)\s+/i, '')
      .replace(/^please\s+/i, '')
      .trim();
    if (line && !GREETING.test(line)) return line;
  }
  return null;
}

/** Keep a readable phrase instead of chopping a word in half. */
export function promptTitle(samples, max = 60) {
  for (const sample of samples ?? []) {
    const line = informative(sample);
    if (!line) continue;
    if (line.length <= max) return line;
    const head = line.slice(0, max - 1);
    const boundary = head.lastIndexOf(' ');
    return (boundary > max / 2 ? head.slice(0, boundary) : head) + '…';
  }
  return null;
}
