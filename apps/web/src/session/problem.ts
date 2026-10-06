/**
 * What went wrong, in words the owner can act on.
 *
 * The CLIs report failures as their own log lines - "claude exited with code
 * 1: No conversation found with session ID: c11b0faa-…" - and those were
 * shown as they came, three times over. This turns the common ones into a
 * sentence; the original stays available behind "Details".
 */
export interface Problem { title: string; text: string; action: string; raw?: string }

type Kind = 'limited' | 'error' | 'interrupted' | 'restart';

const RULES: [RegExp, string][] = [
  [/no conversation found|session .*not found|could not resume/i,
    'The saved history for this chat is gone from this machine, so it could not carry on. Sending again starts it fresh.'],
  [/\b401\b|unauthori[sz]ed|not logged in|log ?in again|invalid api key|authentication|oauth token .*expired|credentials/i,
    'This account is signed out on this machine. Sign in again there, then try again.'],
  [/overloaded|\b529\b|\b5\d\d\b.*(error|server)|internal server error|service unavailable/i,
    'The AI service is busy right now. Try again in a moment.'],
  [/econnreset|etimedout|enotfound|eai_again|fetch failed|network|socket hang up|timed? ?out/i,
    'The machine could not reach the AI service. Check its internet, then try again.'],
  [/context (window|length)|prompt is too long|too many tokens|maximum context/i,
    'This chat has grown too long for the model. Start a new chat, or compact this one.'],
  [/command not found|enoent|spawn .* failed|no such file/i,
    'The agent could not be started on this machine. Check that it is installed.'],
];

/** The bit worth reading out of a raw line: no ids, no "x exited with code 1:" prefix. */
function tidy(message: string): string {
  const line = message.split('\n').find((l) => l.trim()) ?? '';
  const t = line
    .replace(/^\s*\w+ exited with code \d+:\s*/i, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\s+([.,:])/g, '$1').replace(/[:\s]+$/, '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
}

/** "resets 5pm", from either a sentence or Claude's "...|<epoch seconds>". */
function resetTime(message: string): string {
  const epoch = message.match(/\|(\d{10})\b/);
  if (epoch) {
    const at = new Date(Number(epoch[1]) * 1000);
    if (!Number.isNaN(at.getTime())) return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return message.match(/resets? (?:at )?([^.|\n]+)/i)?.[1]?.trim() ?? '';
}

export function plainError(message: string): string {
  for (const [rule, text] of RULES) if (rule.test(message)) return text;
  // "claude exited with code 143" and nothing after it says only that it died.
  const t = tidy(message);
  if (!t || /exited with code|exited unexpectedly|^(killed|terminated)$|sig(term|kill)/i.test(t)) return 'The agent closed in the middle of the task.';
  return t;
}

export function plainProblem(kind: Kind, message: string): Problem {
  const raw = message?.trim() || undefined;
  if (kind === 'restart') return {
    title: 'Task paused', action: 'Resume',
    text: 'Helm restarted while the agent was working. Resume picks up from the saved conversation.',
  };
  if (kind === 'interrupted') return {
    title: 'Task stopped', action: 'Continue',
    text: raw && !/^the task was stopped\.?$/i.test(raw) ? tidy(raw) : 'You stopped this task.',
  };
  if (kind === 'limited') {
    const when = resetTime(message ?? '');
    return {
      title: 'Usage limit reached', action: 'Resume', raw,
      text: when ? `This account's limit resets at ${when}. Your queued messages wait until you resume.` : 'This account hit its usage limit. Your queued messages wait until you resume.',
    };
  }
  const text = plainError(message ?? '');
  return { title: 'Task failed', action: 'Try again', text, raw: raw && raw !== text ? raw : undefined };
}
