import { errorMessage, isMissingSavedChat, missingFolderPath, SAFETY_BLOCK } from '../errors';

/** A task outcome, with a safe message and a way to continue. */
export interface Problem { title: string; text: string; action?: string; changeModel?: boolean; raw?: string }
type Kind = 'limited' | 'error' | 'interrupted' | 'restart';

function tidy(message: string): string {
  const line = message.split('\n').find((l) => l.trim()) ?? '';
  const t = line
    .replace(/^\s*\w+ exited with code \d+:\s*/i, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\s+([.,:])/g, '$1').replace(/[:\s]+$/, '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
}

function resetTime(message: string): string {
  const epoch = message.match(/\|(\d{10})\b/);
  if (epoch) {
    const at = new Date(Number(epoch[1]) * 1000);
    if (!Number.isNaN(at.getTime())) return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return message.match(/resets? (?:at )?(\d{1,2}(?::\d{2})?\s*[ap]m)\b/i)?.[1]?.trim() ?? '';
}

export function plainError(message: string): string {
  return errorMessage(message, { fallback: 'The agent stopped before the task finished. Try again.' });
}

export function plainProblem(kind: Kind, message: string): Problem {
  const raw = message?.trim() || undefined;
  if (kind === 'restart') return {
    title: 'Response interrupted', action: 'Continue',
    text: 'The agent stopped before this reply finished. Continue from the saved chat.',
  };
  if (kind === 'interrupted') return {
    title: 'Task stopped', action: 'Continue',
    text: raw && !/^the task was stopped\.?$/i.test(raw) ? tidy(raw) : 'You stopped this task.',
  };
  if (kind === 'limited') {
    const when = resetTime(message ?? '');
    return {
      title: 'Usage limit reached', action: 'Resume',
      raw,
      text: when ? `This account’s limit resets at ${when}. Waiting messages stay until you continue.` : 'This account reached its usage limit. Waiting messages stay until you continue.',
    };
  }
  if (SAFETY_BLOCK.test(message ?? '')) return { title: 'Blocked for safety', action: 'Try again', text: plainError(message), raw };
  const folder = missingFolderPath(message ?? '');
  if (folder) return {
    title: 'Chat folder missing', action: 'Try again',
    text: `Restore the folder ${folder} on the chat’s machine. Then try again.`, raw,
  };
  if (isMissingSavedChat(message)) return {
    title: 'Saved chat missing', text: plainError(message), raw,
  };
  if (/\b401\b|unauthori[sz]ed|authentication required|not logged in|missing api key|no api key found/i.test(message)) return {
    title: 'Check this account', action: 'Try again', text: plainError(message), raw,
  };
  if (/model.*(?:not supported|not enabled|not available|unavailable|at capacity)|does not offer/i.test(message)) return {
    title: 'Model unavailable', action: 'Try again', changeModel: true, text: plainError(message), raw,
  };
  return { title: 'Task failed', action: 'Try again', text: plainError(message ?? ''), raw };
}
