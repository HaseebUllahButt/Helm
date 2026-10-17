/** Keep wire IDs and reply instructions out of the owner's queue previews. */
export function splitAgentMessage(text?: string): { note?: string; text?: string } {
  const envelope = text?.match(/^\[Helm agent message [a-f0-9]{32}\]\nFrom ([^\n]+)\n(?:Reply to [a-f0-9]{32}\.\n)?This is a message, not a transfer of their conversation\. Keep working in your own context\.\n[^\n]+\n\n([\s\S]*)$/);
  return envelope ? { note: `From ${envelope[1]}`, text: envelope[2] } : { text };
}
