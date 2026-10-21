import { stripBrief } from '@helm/protocol/brief';

/** Keep wire IDs and reply instructions out of the owner's queue previews. */
export function splitAgentMessage(text?: string): { note?: string; text?: string } {
  const envelope = text?.match(/^\[Helm agent message [a-f0-9]{32}\]\nFrom ([^\n]+)\n(?:Reply to [a-f0-9]{32}\.\n)?This is a message, not a transfer of their conversation\. Keep working in your own context\.\n[^\n]+\n\n([\s\S]*)$/);
  return envelope ? { note: `From ${envelope[1]}`, text: envelope[2] } : { text };
}

/**
 * A message from another agent, or a helper's finished-task report: shown as
 * the sender's card, never as something the owner typed. A relay from the
 * owner in another chat is still the owner's, so it is not one of these.
 */
export function helperMessage(text?: string): { from: string; text: string; status?: string } | null {
  const body = stripBrief(text ?? '').replace(/^(?:\[helm [^\]\n]*\]\n\n)+/, '');
  const agent = body.match(/^\[Helm agent message [a-f0-9]{32}\]\nFrom \S+ agent (.+) \([^\n]*\)\.\n(?:Reply to [a-f0-9]{32}\.\n)?This is a message, not a transfer of their conversation\. Keep working in your own context\.\n[^\n]+\n\n([\s\S]*)$/);
  if (agent) return { from: agent[1], text: agent[2] };
  const done = body.match(/^A delegated task finished\.[^\n]*\nTask: ([^\n]*)\nStatus: ([^\n]*)\nResult:\n([\s\S]*)$/);
  return done ? { from: done[1], status: done[2], text: done[3] } : null;
}
