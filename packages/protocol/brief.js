/**
 * Helm's brief to a CLI with no instructions channel, taken back off the
 * front of a message. It now goes out with the message and is never saved
 * as the owner's words, but chats from before that - and histories read
 * back from a CLI's own files - still begin with it. Shared by the app's
 * transcript and `helm thread`, so neither shows Helm's words as the owner's.
 */
const HELM_BRIEF_TAGGED = /^\s*<helm_instructions>[\s\S]*?<\/helm_instructions>\s*(?:<user_request>\n?([\s\S]*?)\n?<\/user_request>\s*$)?/;
const HELM_BRIEF_OLD = /^\[Helm[ :][\s\S]*?\]\n\n/;

export function stripBrief(text) {
  const tagged = HELM_BRIEF_TAGGED.exec(text);
  if (tagged) return tagged[1] ?? text.slice(tagged[0].length);
  const old = HELM_BRIEF_OLD.exec(text);
  // Only a whole run of [Helm …] lines: every line of it is one of them, or
  // continues one ("- Run something…").
  if (old && old[0].split('\n').filter(Boolean).every((line) => line.startsWith('[Helm') || !line.startsWith('['))) return text.slice(old[0].length);
  return text;
}
