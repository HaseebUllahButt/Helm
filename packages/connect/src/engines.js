// What helm knows about each agent CLI.
//
// `homeEnv` is the variable that isolates one account from another - this is
// the hook that makes multi-account work without helm ever touching
// credentials: point the variable at a different directory and you are a
// different user.

export const ENGINES = {
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    homeEnv: 'CODEX_HOME',
    defaultHome: '~/.codex',
    // Where this engine records its own sessions, relative to its home.
    sessionsDir: 'sessions',
    sessionIndex: 'session_index.jsonl',
    resumeArgs: (id) => ['resume', id],
    // Run headless through `codex app-server` (drivers/codex.js).
    driver: 'codex',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    defaultHome: '~/.claude',
    sessionsDir: 'projects',
    resumeArgs: (id) => ['--resume', id],
    // Run headless through `claude -p` stream-json (drivers/claude.js).
    driver: 'claude',
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    // opencode keys off XDG rather than a dedicated variable, so isolating an
    // account means moving the whole XDG config root.
    homeEnv: 'XDG_CONFIG_HOME',
    defaultHome: '~/.config',
    configPath: 'opencode/opencode.json',
    sessionsDir: 'opencode/storage',
    resumeArgs: (id) => ['--session', id],
    // Run headless through `opencode acp` (drivers/opencode.js).
    driver: 'opencode',
  },
  opencode2: {
    id: 'opencode2',
    label: 'OpenCode 2',
    bin: 'opencode2',
    // V2 deliberately shares provider credentials and configuration with V1,
    // but keeps its own session schema inside the shared data database.
    homeEnv: 'XDG_CONFIG_HOME',
    defaultHome: '~/.config',
    configPath: 'opencode/opencode.jsonc',
    resumeArgs: (id) => ['--session', id],
    // V2's ACP command uses the process cwd; it has no --cwd flag.
    driver: 'opencode2',
  },
  devin: {
    id: 'devin',
    label: 'Devin',
    bin: 'devin',
    // Same XDG caveat as opencode: config lives in ~/.config/devin, the login
    // in ~/.local/share/devin.
    homeEnv: 'XDG_CONFIG_HOME',
    defaultHome: '~/.config',
    configPath: 'devin/config.json',
    // Run headless through `devin acp` (drivers/devin.js).
    driver: 'devin',
  },
  shell: {
    id: 'shell',
    label: 'Shell',
    bin: null, // resolved to $SHELL at runtime
    plain: true,
  },
};

export const ENGINE_IDS = Object.keys(ENGINES);

/** Map a resolved argv[0] back to an engine id, or null if we don't know it. */
export function engineForCommand(cmd) {
  if (!cmd) return null;
  const base = cmd.split('/').pop();
  for (const e of Object.values(ENGINES)) {
    if (e.bin && (base === e.bin || base.startsWith(e.bin + '.'))) return e.id;
  }
  return null;
}
