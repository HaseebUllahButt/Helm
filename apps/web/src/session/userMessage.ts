import type { Turn } from './types';

/** Display old wire envelopes without changing the stored user message. */
export function userMessage(text?: string, attachments: Turn['attachments'] = []) {
  const channel = text?.match(/^\s*<channel\s+source="helm-native"[^>]*>\s*([\s\S]*?)\s*<\/channel>\s*$/);
  if (channel) text = channel[1];
  // A message for one of the chat's helpers, which the agent was asked to
  // pass on: what the owner wrote, and to whom. The ask is Helm's.
  let to: string | undefined;
  const relay = text?.match(/^\s*<subagent-message\s+to="[^"]*"\s+title="([^"]*)">\n?([\s\S]*?)\n?<\/subagent-message>/);
  if (relay) { to = relay[1]; text = relay[2]; }
  // A message Helm pasted into a terminal CLI comes back from the CLI's own
  // record wrapped as a paste; the wrapper is the CLI's bookkeeping, not
  // what the owner wrote.
  const pasted = text?.match(/^\s*<pasted_content\b[^>]*>\s*([\s\S]*?)\s*<\/pasted_content>\s*$/);
  if (pasted) text = pasted[1];
  // Pictures sent to a terminal CLI travel as files it is told to read; the
  // note is for the CLI, the pictures are what to show.
  const note = text?.match(/\n*Read the attached image files before answering:\n((?:\[Image #\d+\]: "[^"\n]+"\n?)+)\s*$/);
  if (note) {
    text = text!.slice(0, note.index).trim();
    if (!attachments?.length) attachments = [...note[1].matchAll(/\[Image #\d+\]: "([^"\n]+)"/g)].map((m) => ({
      filename: m[1].split('/').at(-1) || 'image', mime: 'image/jpeg', missing: true,
    }));
  }
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
  // Claude's record of a command it ran itself (/model, /cost, a model
  // picked from the menu) comes back in its own markup. The caveat is for
  // the model; the command reads as typed; what it printed is an answer,
  // not something the owner said.
  let printed = false;
  if (/^\s*<local-command-caveat>/.test(text ?? '')) text = '';
  const command = text?.match(/^\s*<command-name>\s*([^<]*?)\s*<\/command-name>/);
  if (command) {
    const args = text?.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim();
    text = args ? `${command[1]} ${args}` : command[1];
  }
  if (/^\s*<local-command-(?:stdout|stderr)>/.test(text ?? '')) {
    text = [...text!.matchAll(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g)]
      .map((m) => m[1]).join('\n').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    printed = true;
  }
  // "[Image #1] [Image #2] look at this" opens by saying pictures came with
  // it, and the pictures show that. Later labels ("compare [Image #1] with
  // [Image #2]") say which is which, so they stay.
  if (attachments?.length && text) text = text.replace(/^(?:\s*\[Image #\d+\])+\s*/, '');
  return { text, attachments, printed, to };
}
