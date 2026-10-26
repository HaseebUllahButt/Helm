/** Short labels shared by push previews and the in-app notification. */
const labels = {
  codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', opencode2: 'OpenCode 2',
  devin: 'Devin', grok: 'Grok', cursor: 'Cursor', pi: 'Pi', omp: 'OMP',
  agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Gemini', kimi: 'Kimi', muse: 'Muse',
};
export const agentLabel = (engine) => labels[engine] || 'Your agent';

// Addresses and paths stay in the chat, never on a lock screen. A link
// keeps its words and loses its target; a path inside brackets or quotes
// goes too.
const scrub = (text) => String(text ?? '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(?:https?|file):\/\/\S+|\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?\S*|(?:\b[\w.-]+:\d+)\S*/gi, '')
  .replace(/(^|[\s([{<"'`])(?:~?\/|[A-Z]:\\)[^\s)\]}>"'`]+/gi, '$1')
  .replace(/\(\s*\)|\[\s*\]|\{\s*\}|<\s*>|"\s*"|'\s*'|`\s*`/g, '')
  .replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
const cap = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function notificationContext(session) {
  const title = scrub(session?.title || session?.cwd?.split('/').filter(Boolean).pop() || 'Your chat') || 'Your chat';
  return cap(title, 72);
}

/** The first line of an agent's words, plain and short, for a notice. */
export function notificationLine(text, max = 110) {
  const line = String(text ?? '').split('\n').map((l) => l.replace(/^\s*(?:[#>*-]+|\d+\.)\s*/, '').replace(/[*_`]/g, '')).find((l) => l.trim()) ?? '';
  return cap(scrub(line), max);
}
