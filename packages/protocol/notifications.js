/** Short labels shared by push previews and the in-app notification. */
const labels = {
  codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', opencode2: 'OpenCode 2',
  devin: 'Devin', grok: 'Grok', cursor: 'Cursor', pi: 'Pi', omp: 'OMP', rovo: 'Rovo Dev',
  agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Gemini', kimi: 'Kimi', muse: 'Muse',
};
export const agentLabel = (engine) => labels[engine] || 'Your agent';

export function notificationContext(session) {
  const title = String(session?.title || session?.cwd?.split('/').filter(Boolean).pop() || 'Your chat')
    .replace(/https?:\/\/\S+|\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?\S*|(?:\b[\w.-]+:\d+)\S*/gi, '')
    .replace(/(?:^|\s)(?:~?\/|[A-Z]:\\)\S+/gi, ' ')
    .replace(/\s+/g, ' ').trim() || 'Your chat';
  return title.length > 72 ? `${title.slice(0, 71)}…` : title;
}
