// What helm knows about each agent CLI.
//
// `homeEnv` is the variable that isolates one account from another - this is
// the hook that makes multi-account work without helm ever touching
// credentials: point the variable at a different directory and you are a
// different user.
//
// `proc` describes how a running process identifies itself to inventory:
//   names               argv basenames that are this engine's CLI
//   scriptHints         argv[1] fragments for node-bundled CLIs whose
//                       process name is `node`/`MainThread` (cursor, gemini)
//   nonInteractiveSub   subcommands that are never a chat session
//                       (our own headless invocations land here)
//   nonInteractiveFlags flags whose presence means "not a TUI session"
//                       (-p, --mode rpc) even when the process stays up
// The default is `{ names: [bin] }` when `proc` is omitted.

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
    proc: { nonInteractiveSub: ['app-server', 'exec', 'login', 'logout', 'mcp', 'remote-control'] },
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
    proc: { nonInteractiveFlags: ['-p', '--print', '--input-format', '--output-format'],
      nonInteractiveSub: ['auth', 'mcp', 'update', 'install', 'doctor', 'remote-control'] },
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
    proc: {
      names: ['opencode'],
      nonInteractiveSub: ['acp', 'serve', 'run', 'stats', 'api', 'service'],
    },
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
    proc: {
      names: ['opencode2'],
      nonInteractiveSub: ['acp', 'serve', 'run', 'stats', 'api', 'service'],
    },
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
    proc: {
      names: ['devin'],
      nonInteractiveSub: ['acp'],
    },
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    homeEnv: 'GROK_HOME',
    defaultHome: '~/.grok',
    // sessions/<urlencoded cwd>/<uuid>/summary.json + chat_history.jsonl
    sessionsDir: 'sessions',
    resumeArgs: (id) => ['--resume', id],
    // Run headless through `grok agent stdio` - verified ACP, grok 1.0.41
    // (drivers/grok.js).
    driver: 'grok',
    proc: {
      names: ['grok'],
      // `grok agent` (stdio/headless/serve/leader) is the protocol side, not
      // a chat a person is looking at.
      nonInteractiveSub: ['agent', 'models', 'doctor', 'auth', 'login', 'mcp', 'config', 'plugin', 'version', 'update', 'init'],
      nonInteractiveFlags: ['-p', '--print'],
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    // The stable launcher; older installs shipped the same binary as `agent`.
    bin: 'cursor-agent',
    altBins: ['agent'],
    defaultHome: '~/.cursor',
    // chats/<hash>/<chatId>/meta.json + store.db; acp-sessions/<id>/meta.json
    sessionsDir: 'chats',
    resumeArgs: (id) => ['--resume', id],
    // Run headless through `cursor-agent acp` - verified ACP 2026.08.11
    // (drivers/cursor.js).
    driver: 'cursor',
    proc: {
      names: ['cursor-agent', 'agent'],
      // The auto-updated binary lives under the install tree; argv0 can also
      // be a bare `node` running a cursor-agent script.
      scriptHints: ['/cursor-agent/'],
      nonInteractiveSub: ['acp', 'login', 'logout', 'auth', 'mcp', 'update', 'upgrade', 'models', 'status', 'version', 'install', 'uninstall'],
      nonInteractiveFlags: ['-p', '--print', '--list-models'],
    },
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    bin: 'pi',
    homeEnv: 'PI_CODING_AGENT_DIR',
    defaultHome: '~/.pi/agent',
    // sessions/<dash-cwd>/<ts>_<uuid>.jsonl, first line carries id + cwd.
    sessionsDir: 'sessions',
    resumeArgs: (id) => ['--session', id],
    // Run headless through `pi --mode rpc` (drivers/pi.js).
    driver: 'pi',
    proc: {
      names: ['pi'],
      nonInteractiveSub: ['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth'],
      nonInteractiveFlags: ['-p', '--print', '--mode', '--list-models'],
    },
  },
  omp: {
    id: 'omp',
    label: 'OMP',
    bin: 'omp',
    // OMP has no home env var of its own; `--profile <name>` is how a second
    // account isolates auth, sessions and settings.
    defaultHome: '~/.omp/agent',
    sessionsDir: 'sessions',
    resumeArgs: (id) => ['-r', id],
    // Run headless through `omp --mode rpc`; it is the pi wire protocol plus
    // omp's own frames (drivers/pi.js).
    driver: 'omp',
    proc: {
      names: ['omp'],
      nonInteractiveFlags: ['-p', '--print', '--mode'],
    },
  },
  rovo: {
    id: 'rovo',
    label: 'Rovo Dev',
    bin: 'rovo',
    defaultHome: '~/.rovodev',
    resumeArgs: (id) => ['--restore', id],
    // `rovo acp` is a verified ACP endpoint (drivers/rovo.js).
    driver: 'rovo',
    proc: {
      names: ['rovo'],
      nonInteractiveSub: ['acp', 'login', 'auth'],
    },
  },
  agy: {
    id: 'agy',
    label: 'Antigravity CLI',
    bin: 'agy',
    // agy's store sits inside the gemini home: <GEMINI_CLI_HOME>/antigravity-cli.
    // A second account is the same variable a second gemini account uses.
    homeEnv: 'GEMINI_CLI_HOME',
    defaultHome: '~/.gemini',
    // antigravity-cli/conversations/<uuid>.db + conversation_summaries.db.
    sessionsDir: 'antigravity-cli/conversations',
    resumeArgs: (id) => ['--conversation', id],
    // Run headless through `agy --input-format stream-json --output-format
    // stream-json` - verified agy 1.2.12 (drivers/agy.js).
    driver: 'agy',
    proc: {
      names: ['agy'],
      // `agy -c`/`--conversation`/`--prompt-interactive` are TUI sessions and
      // stay adoptable; print/stream-json invocations are headless.
      nonInteractiveSub: ['models', 'agent', 'agents', 'mcp', 'mic-serve', 'plugin', 'plugins', 'remote-control', 'install', 'changelog', 'update', 'help'],
      nonInteractiveFlags: ['-p', '--print', '--prompt', '--input-format', '--output-format', '--remote-control'],
    },
  },
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    // Google's official ACP agent: not on PATH, never a TUI. helm installs
    // the managed runtime to ~/.helm/tools/antigravity-acp (`helm
    // antigravity install`) and discover resolves it there - so no bin and
    // no proc spec. GEMINI_HOME is a helm-owned profile dir per account;
    // the agent would otherwise share ~/.gemini with the agy CLI.
    managed: true,
    homeEnv: 'GEMINI_HOME',
    defaultHome: '~/.helm/antigravity',
    // Run headless through the managed ACP binary (drivers/antigravity.js).
    driver: 'antigravity',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    bin: 'gemini',
    homeEnv: 'GEMINI_CLI_HOME',
    defaultHome: '~/.gemini',
    resumeArgs: (id) => ['--resume', id],
    // `--experimental-acp` exists but is unverified; no driver yet.
    proc: {
      names: ['gemini'],
      // The shipped CLI is a node bundle; modern node reports comm
      // `MainThread`, so identity is argv[1] being the gemini script.
      scriptHints: ['@google/gemini-cli', '/gemini-cli/'],
      nonInteractiveSub: ['mcp'],
      nonInteractiveFlags: ['-p', '--print', '--output-format', '--list-sessions', '--experimental-acp'],
    },
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    bin: 'kimi',
    defaultHome: '~/.kimi-code',
    // TUI only: no headless protocol - discovery and inventory only.
    proc: {
      names: ['kimi'],
      nonInteractiveSub: ['login', 'auth'],
    },
  },
  muse: {
    id: 'muse',
    label: 'Muse',
    bin: 'muse',
    // muse keys off XDG like opencode: ~/.config/muse for config, data under
    // ~/.local/share/muse (sessions/YYYY/MM/DD/<uuid>/session.jsonl).
    homeEnv: 'XDG_CONFIG_HOME',
    defaultHome: '~/.config',
    resumeArgs: (id) => ['resume', id],
    // TUI only: no headless protocol - discovery and inventory only.
    proc: {
      names: ['muse', 'muse-bin'],
      // The launcher execs a versioned `muse-bin-<version>`; match the prefix.
      namesPrefix: ['muse-bin-'],
      nonInteractiveSub: ['login', 'auth'],
    },
  },
  shell: {
    id: 'shell',
    label: 'Shell',
    bin: null, // resolved to $SHELL at runtime
    plain: true,
  },
};

export const ENGINE_IDS = Object.keys(ENGINES);

/** The argv basenames that identify an engine's process. */
export function procNames(engine) {
  const e = ENGINES[engine];
  return e?.proc?.names ?? (e?.bin ? [e.bin] : []);
}

/**
 * Is this process argv an interactive chat session of `engine` - something a
 * person could be typing into in a terminal, and therefore a live session
 * helm can offer to adopt?
 *
 * A process is interactive when an argv entry is one of the engine's binary
 * names (or, for node-bundled CLIs, argv[1] is its script) AND the invocation
 * is not one of its headless shapes: helm's own `… acp` / `--mode rpc`
 * drivers must not pass for an external session, or inventory would claim a
 * helm-owned process is somebody typing in a terminal.
 */
export function isInteractiveProc(engine, argv) {
  const e = ENGINES[engine];
  if (!e?.bin || !Array.isArray(argv) || !argv.length) return false;
  const spec = e.proc ?? {};
  const names = [...(spec.names ?? [e.bin]), ...[e.bin, ...(e.altBins ?? [])].map((bin) => `.${bin}-helm-native`)];
  const prefixes = spec.namesPrefix ?? [];
  const at = argv.findIndex((x) => {
    const name = x.split('/').pop();
    return names.includes(name) || prefixes.some((p) => name.startsWith(p));
  });
  // Wherever the binary was identified, the subcommand is the token behind
  // it - `cursor-agent acp` as a name, or `node …/cursor-agent/… acp` for a
  // node-bundled CLI whose own process name is `node`.
  let subAt;
  if (at >= 0) subAt = at + 1;
  else {
    if (!spec.scriptHints?.length) return false;
    const script = argv[1] ?? '';
    if (!spec.scriptHints.some((h) => script.includes(h))) return false;
    subAt = 2;
  }
  const sub = argv[subAt];
  if (sub && !sub.startsWith('-') && (spec.nonInteractiveSub ?? []).includes(sub)) return false;
  const flags = new Set(argv);
  return !(spec.nonInteractiveFlags ?? []).some((f) => flags.has(f));
}

/** Map a resolved argv[0] back to an engine id, or null if we don't know it. */
export function engineForCommand(cmd) {
  if (!cmd) return null;
  const base = cmd.split('/').pop();
  for (const e of Object.values(ENGINES)) {
    const names = [e.bin, ...(e.altBins ?? [])].filter(Boolean);
    if (names.some((n) => base === n || base.startsWith(n + '.'))) return e.id;
  }
  return null;
}
