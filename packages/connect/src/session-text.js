/** Small text checks the session parts share. */

/** A title cut to fit, with the cut said out loud. */
export const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

const linkText = (value, max = 200) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;

export const parentLink = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  const handoffId = linkText(value.handoffId, 80);
  const machineId = linkText(value.machineId, 80);
  const sessionId = linkText(value.sessionId, 80);
  if (!handoffId || !machineId || !sessionId) return undefined;
  return {
    handoffId,
    machineId,
    sessionId,
    sourceFolder: linkText(value.sourceFolder, 1024) || null,
    digest: linkText(value.digest, 128) || null,
  };
};

export const missingClaudeConversation = (error, sessionId) => {
  if (typeof error !== 'string' || !sessionId) return false;
  const missing = /No conversation found with session ID:\s*(\S+)/i.exec(error);
  return missing?.[1] === sessionId;
};
