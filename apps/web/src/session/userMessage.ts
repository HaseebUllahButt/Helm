import type { Turn } from './types';

/** Display old wire envelopes without changing the stored user message. */
export function userMessage(text?: string, attachments: Turn['attachments'] = []) {
  const channel = text?.match(/^\s*<channel\s+source="helm-native"[^>]*>\s*([\s\S]*?)\s*<\/channel>\s*$/);
  if (channel) text = channel[1];
  const reply = text?.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
  if (reply) {
    try {
      const answers = JSON.parse(reply[1]);
      if (Array.isArray(answers) && answers.length && answers.every((a) => a && typeof a.answer === 'string')) {
        text = answers.map((a) => a.answer).join('\n\n');
      }
    } catch { /* An unfamiliar record stays readable. */ }
  }
  if (/^\s*<image name=/.test(text ?? '')) {
    const wrappers = [...(text ?? '').matchAll(/<image name=[^\n>]*? path="([^"\n]+)"\s*>\s*<\/image>/g)];
    if (wrappers.length) {
      text = text?.replace(/<image name=[^\n>]*? path="[^"\n]+"\s*>\s*<\/image>/g, '').trim().replace(/^(?:\[Image #\d+\]\s*)+/, '');
      if (!attachments?.length) attachments = wrappers.map((match) => ({
        filename: match[1].split('/').at(-1) || 'image', mime: 'image/png', missing: true,
      }));
    }
  }
  return { text, attachments };
}
