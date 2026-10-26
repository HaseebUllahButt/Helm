/** Show plain messages. Keep technical failures out of the main message. */
export type ErrorContext = { machine?: string; fallback?: string };
const reportedErrors = new Set<string>();

function readableMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (/[\r\n\u2028\u2029]/.test(trimmed)) return;
  const line = trimmed.replace(/^Error:[ \t]*/i, '');
  if (!line || line.length > 160 || !/[a-z]/i.test(line)
    || /[\x00-\x1f\x7f\u2028\u2029{}\[\]\\/]/.test(line)
    || /\b[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+\b/i.test(line)
    || /\b(?:[0-9a-f]{8,}|0x[0-9a-f]+)\b/i.test(line)
    || /\bRPC\b|\b(?:Traceback|stack trace)\b|^at\s|^\w+Error:|["']\s*:/i.test(line)
    || /^".*"$|^(?:null|true|false)$/i.test(line)) return;
  return line[0].toUpperCase() + line.slice(1);
}

export function errorMessage(error: unknown, { machine, fallback = 'Helm cannot finish this action. Try again.' }: ErrorContext = {}): string {
  const value = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; status?: unknown; name?: unknown } : {};
  const message = typeof error === 'string' ? error : typeof value.message === 'string' ? value.message : '';
  const code = typeof value.code === 'string' ? value.code.toLowerCase() : '';
  const status = typeof value.status === 'number' ? String(value.status) : '';
  const name = typeof value.name === 'string' ? value.name : '';
  const text = `${code} ${status} ${name} ${message}`;
  const where = machine || 'This machine';
  const report = message || text;
  if (!reportedErrors.has(report)) {
    // Errors can name chats and requests, so the texts never repeat. Forget
    // them now and then; a second log line costs nothing.
    if (reportedErrors.size >= 200) reportedErrors.clear();
    reportedErrors.add(report);
    console.warn('Helm action failed:', error);
  }

  if (/model.*(not supported|not available|unavailable)|does not offer/i.test(text)) return 'This account cannot use this model. Select another model.';
  if (/an internal error occurred/i.test(text)) return 'The AI service did not finish this reply. Try again. Select another model if it fails again.';
  if (/file is empty/i.test(text)) return 'The file is empty. Select another file.';
  if (/file is [\d.]+ MB|file.*too large/i.test(text)) return 'The file is too large. Select a file smaller than 20 MB.';
  if (/cannot read HEIC/i.test(text)) return 'This browser cannot read HEIC photos. Send a JPEG photo.';
  if (/not an image|cannot read the image|no valid width or height/i.test(text)) return 'Helm cannot read this image. Select another image.';
  if (/invalid folder name|folder name cannot contain|escape the parent directory/i.test(text)) return 'Enter a folder name without / or \\. Try again.';
  if (/older target/i.test(text)) return `Update Helm on ${machine || 'the receiving machine'} before the next file send.`;
  if (/isolated Git worktree|worktree is shared|workspace is shared|another chat uses this folder/i.test(text)) return 'Another chat can use these files. Continue without restoring files.';
  if (/restarting|restart in progress|shutting down|daemon.*stopp/i.test(text)) return 'Helm is restarting. Try again when it is ready.';
  if (/\b(offline|unreachable|disconnected|econnrefused|econnreset|ehostunreach|enetunreach|enotfound)\b|not connected|connection (closed|lost)|failed to fetch|fetch failed|network ?error|\bload failed\b|socket/i.test(text)) {
    return `${where} is not connected. Check the connection. Try again.`;
  }
  if (/\b(timeout|timed out|etimedout|delivery_pending)\b|still unconfirmed/i.test(text)) return 'Helm did not get a reply in time. Try again.';
  if (/agent.*(not running|stopped|exited|not alive)|no longer running|not_running|no running agent|session.*(not alive|not running)/i.test(text)) return 'The agent is not running. Send a message to continue the chat.';
  if (/wait until.*(CLI|agent).*finishes|agent.*busy/i.test(text)) return 'Wait for the agent to finish this reply. Try again.';
  if (/command not found|spawn .*failed/i.test(text)) return `Install the agent on ${machine || 'this machine'}. Try again.`;
  if (/unknown_method|delivery_unsupported|unknown method|not supported|no handler/i.test(text)) return `Update Helm on ${machine || 'this machine'}. Try again.`;
  if (/invalid.*key|key.*(invalid|not accept)|does not look like.*key|did not accept.*key/i.test(text)) return 'Check the key. Enter a valid key and try again.';
  if (/\b(401|unauthorized|unauthorised)\b|not logged in|sign.?in|log.?in|authentication|credentials|token.*expired/i.test(text)) return `This account is signed out. Sign in again on ${machine || 'this machine'}. Try again.`;
  if (/\b(403|eacces|eperm)\b|permission denied|access denied|not allowed/i.test(text)) return 'Helm does not have access. Check the permissions and try again.';
  if (/\b(enospc|edquot)\b|no space left|disk.*full|quota.*exceeded|needs more free space/i.test(text)) return `Free some space on ${machine || 'this machine'}. Try again.`;
  if (/rate.?limit|\b429\b|usage limit/i.test(text)) return 'The service reached its usage limit. Try again later.';
  if (/context (window|length)|prompt is too long|too many tokens/i.test(text)) return 'This chat is too long. Summarize it or start a new chat.';
  if (/no conversation found|session.*not found|could not resume/i.test(text)) return 'This machine no longer has the chat history. Send a message to start again.';
  if (/\b(enoent|not_found)\b|no such file|not a file|file.*not found|folder.*not found/i.test(text)) return 'Helm cannot find the file or folder. Check that it still exists.';
  if (/already exists|\beexist\b/i.test(text)) return 'This name is already in use. Select another name.';
  if (/not a git|not.*repository/i.test(text)) return 'This folder has no Git history. Select a project folder.';
  if (/conflict|uncommitted changes|unsaved changes|local changes.*overwritten/i.test(text)) return `Save the file changes on ${machine || 'this machine'}. Try again.`;
  if (/diverged|combine.*changes/i.test(text)) return `Combine the changes on ${machine || 'this machine'} before you update Helm.`;
  if (/overloaded|service unavailable|\b5\d\d\b/i.test(text)) return 'The service is busy. Try again soon.';
  return readableMessage(message) ?? fallback;
}
