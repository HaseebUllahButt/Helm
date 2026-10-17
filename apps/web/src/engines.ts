// The badge itself is EngineMark; this is what an engine is called.
const ENGINE: Record<string, { label: string; cls: string }> = {
  claude:   { label: 'Claude Code', cls: 'claude' },
  codex:    { label: 'Codex',       cls: 'codex' },
  opencode: { label: 'opencode',    cls: 'opencode' },
  opencode2:{ label: 'OpenCode 2',  cls: 'opencode2' },
  devin:    { label: 'Devin',       cls: 'devin' },
  grok:     { label: 'Grok',        cls: 'grok' },
  cursor:   { label: 'Cursor',      cls: 'cursor' },
  pi:       { label: 'Pi',          cls: 'pi' },
  omp:      { label: 'OMP',         cls: 'omp' },
  agy:      { label: 'Antigravity CLI', cls: 'agy' },
  antigravity: { label: 'Antigravity', cls: 'agy' },
  gemini:   { label: 'Gemini',      cls: 'gemini' },
  kimi:     { label: 'Kimi',        cls: 'kimi' },
  muse:     { label: 'Muse',        cls: 'muse' },
  shell:    { label: 'Terminal',    cls: 'shell' },
};

export const engineOf = (id?: string) => ENGINE[id ?? ''] ?? { label: id ?? 'agent', cls: 'other' };
