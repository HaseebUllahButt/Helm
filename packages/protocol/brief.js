/**
 * Helm's brief to a CLI with no instructions channel, taken back off the
 * front of a message. It now goes out with the message and is never saved
 * as the owner's words, but chats from before that - and histories read
 * back from a CLI's own files - still begin with it. Shared by the app's
 * transcript and `helm thread`, so neither shows Helm's words as the owner's.
 */
const HELM_BRIEF_TAGGED = /^\s*<helm_instructions>[\s\S]*?<\/helm_instructions>\s*(?:<user_request>\n?([\s\S]*?)\n?<\/user_request>\s*$)?/;
const HELM_BRIEF_OLD = /^\[Helm[ :][\s\S]*?\]\n\n/;

/**
 * The writing rules, said again at the end of every message. The full rules
 * sit in the standing instructions (writingNote, delegation.js), but agents
 * drift back to their own style once those are far behind. One line at the
 * point of reply costs little and does not break the CLI's prompt cache.
 */
export const WRITING_REMINDER = '<helm_reminder>Reply in Simplified Technical English. Put the result first. Use short sentences and plain words. Cut filler, hedging and recaps.</helm_reminder>';
/** Helm's notes at the end of a message: the reminder, and the made-way note. */
const REMINDER_TAIL = /(?:\s*<helm_(reminder|note)>[\s\S]*?<\/helm_\1>)+\s*$/;

export const withReminder = (text) => `${text}\n\n${WRITING_REMINDER}`;

/**
 * Added to the owner's message when Helm stopped a reply so that a CLI
 * which reads input only between turns gets it at once.
 */
export const MADE_WAY_NOTE = '<helm_note>Helm stopped your last reply so that this message reached you at once. Answer it. Then continue the stopped work, unless this message changes it.</helm_note>';

export function stripBrief(text) {
  text = text.replace(REMINDER_TAIL, '');
  const tagged = HELM_BRIEF_TAGGED.exec(text);
  if (tagged) return tagged[1]?.replace(REMINDER_TAIL, '') ?? text.slice(tagged[0].length);
  const old = HELM_BRIEF_OLD.exec(text);
  // Only a whole run of [Helm …] lines: every line of it is one of them, or
  // continues one ("- Run something…").
  if (old && old[0].split('\n').filter(Boolean).every((line) => line.startsWith('[Helm') || !line.startsWith('['))) return text.slice(old[0].length);
  return text;
}
