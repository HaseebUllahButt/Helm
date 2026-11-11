import { stripBrief } from '@helm/protocol/brief';

/** Keep wire IDs and reply instructions out of the owner's queue previews. */
export function splitAgentMessage(text?: string): { note?: string; text?: string } {
  const envelope = text?.match(/^\[Helm agent message [a-f0-9]{32}\]\nFrom ([^\n]+)\n(?:Reply to [a-f0-9]{32}\.\n)?This is a message, not a transfer of their conversation\. Keep working in your own context\.\n[^\n]+\n\n([\s\S]*)$/);
  return envelope ? { note: `From ${envelope[1]}`, text: envelope[2] } : { text };
}

type HelperMessage = { from: string; text: string; status?: string };

const TASK_DONE = /^A delegated task finished\.[^\n]*\nTask: ([^\n]*)\n(?:Machine: [^\n]*\n)?Status: ([^\n]*)\nResult:\n([\s\S]*?)(?:\nFull output: helm delegate-result \S+)?$/;
// Helpers that end while their chat works reach it in one message: each
// report ends with its command line, and the next one starts after it.
const NEXT_REPORT = /(?<=\nFull output: helm delegate-result \S+)\n\n(?=A delegated task finished\.)/;

/**
 * Messages from other agents, or helpers' finished-task reports: each shown
 * as the sender's card, never as something the owner typed. A relay from the
 * owner in another chat is still the owner's, so it is not one of these.
 * Empty when the text is the owner's own.
 */
export function helperMessages(text?: string): HelperMessage[] {
  const body = stripBrief(text ?? '').replace(/^(?:\[helm [^\]\n]*\]\n\n)+/, '');
  const agent = body.match(/^\[Helm agent message [a-f0-9]{32}\]\nFrom \S+ agent (.+) \([^\n]*\)\.\n(?:Reply to [a-f0-9]{32}\.\n)?This is a message, not a transfer of their conversation\. Keep working in your own context\.\n[^\n]+\n\n([\s\S]*)$/);
  if (agent) return [{ from: agent[1], text: agent[2] }];
  // A helper on another machine adds its Machine line. The last line tells
  // the parent agent how to read the full output; the owner opens the card.
  const reports = body.split(NEXT_REPORT).map((part) => part.match(TASK_DONE));
  if (reports.some((done) => !done)) return [];
  return reports.map((done) => ({ from: done![1], status: done![2], text: done![3] }));
}

/** The first of `helperMessages`, or null when the text is the owner's own. */
export function helperMessage(text?: string): HelperMessage | null {
  return helperMessages(text)[0] ?? null;
}
