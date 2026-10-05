/**
 * helm's own icon set: one stroke weight, one 24-unit grid, drawn rather than
 * typed. Text symbols like `⧉ ↻ ⚡ ◎` come from whatever font each phone has,
 * so the same button was a thin glyph on one device and a full-colour emoji on
 * another. Every icon inherits `currentColor` and hides from screen readers -
 * the button around it carries the name.
 */

export type IconName =
  | 'back' | 'forward' | 'up' | 'down' | 'arrow-up' | 'arrow-down'
  | 'more' | 'close' | 'refresh' | 'plus' | 'check' | 'checkbox'
  | 'subagents' | 'git' | 'branch' | 'terminal' | 'raw'
  | 'star' | 'star-on' | 'bolt' | 'model' | 'effort' | 'shield'
  | 'read' | 'edit' | 'run' | 'search' | 'web' | 'tool' | 'ask' | 'plan' | 'think' | 'alert'
  | 'folder' | 'repo' | 'machine' | 'transfer' | 'image' | 'sidebar' | 'jump' | 'stop'
  | 'tag' | 'cloud' | 'copy';

const PATHS: Record<IconName, JSX.Element> = {
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  more: <><circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: <><path d="M20 12a8 8 0 11-2.4-5.7" /><path d="M20 4v4.5h-4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checkbox: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M7.5 12l3 3L17 8.5" /></>,
  // Work handed on: a thread and the copy of it that does the job.
  subagents: <><rect x="3.5" y="8.5" width="12" height="12" rx="2.5" /><path d="M8.5 8.5V6A2.5 2.5 0 0111 3.5h7A2.5 2.5 0 0120.5 6v7a2.5 2.5 0 01-2.5 2.5h-2.5" /></>,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10M18 11c0 4-6 3-10 7" /></>,
  branch: <><circle cx="6" cy="18" r="2" /><circle cx="6" cy="6" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10c0 4-4 4-10.5 6.5" /></>,
  terminal: <><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" /></>,
  raw: <path d="M5 7h14M5 12h14M5 17h9" />,
  star: <path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.6l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" />,
  'star-on': <path d="M12 4.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.6l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" fill="currentColor" />,
  bolt: <path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12z" />,
  model: <><rect x="6.5" y="6.5" width="11" height="11" rx="2" /><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" /></>,
  effort: <><path d="M4.5 16a7.5 7.5 0 1115 0" /><path d="M12 16l3.5-4.5" /></>,
  shield: <path d="M12 3.5l7 2.7v5.3c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6.2z" />,
  read: <><path d="M7 3.5h7l4.5 4.5v12.5H7z" /><path d="M14 3.5V8h4.5M10 12.5h5.5M10 16h5.5" /></>,
  edit: <><path d="M5 19l1-4.2L15.6 5.2a2 2 0 012.8 0l.4.4a2 2 0 010 2.8L9.2 18 5 19z" /><path d="M13.8 7l3.2 3.2" /></>,
  run: <path d="M5 7l5 5-5 5M12 17h7" />,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></>,
  web: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.5 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.5-3.5-8.5s1-5.9 3.5-8.5z" /></>,
  tool: <path d="M14.5 5.5a4 4 0 00-5 5L4 16v4h4l5.5-5.5a4 4 0 005-5l-2.6 2.6-2.4-.6-.6-2.4z" />,
  ask: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 114 2c-.9.6-1.6 1.1-1.6 2.3" /><circle cx="12" cy="16.8" r=".6" fill="currentColor" /></>,
  plan: <path d="M9 6.5h10M9 12h10M9 17.5h10M5 6.5h.01M5 12h.01M5 17.5h.01" />,
  think: <><circle cx="12" cy="12" r="8.5" strokeDasharray="2.2 3" /></>,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.3" r=".6" fill="currentColor" /></>,
  folder: <path d="M3.5 7.5a2 2 0 012-2h4l2 2.2h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />,
  repo: <><path d="M3.5 7.5a2 2 0 012-2h4l2 2.2h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z" /><circle cx="12" cy="13.3" r="2" /></>,
  machine: <><rect x="3.5" y="4.5" width="17" height="11.5" rx="2" /><path d="M8.5 20h7M12 16v4" /></>,
  transfer: <path d="M5 8.5h13l-3.5-3.5M19 15.5H6l3.5 3.5" />,
  image: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 15.5l-5-5L6 19" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>,
  jump: <><path d="M4.5 12h11M11.5 7l5 5-5 5" /><path d="M19.5 5v14" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.8" fill="currentColor" stroke="none" />,
  tag: <><path d="M3.5 12.2V4.5a1 1 0 011-1h7.7l8.3 8.3a1.5 1.5 0 010 2.1l-6.4 6.4a1.5 1.5 0 01-2.1 0z" /><circle cx="8" cy="8" r="1.3" /></>,
  cloud: <path d="M7 18.5h10.5a3.5 3.5 0 00.4-7A5.5 5.5 0 007.3 10 4.3 4.3 0 007 18.5z" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2" /></>,
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >{PATHS[name]}</svg>
  );
}

/** The way back, the same size on every screen. */
export const BackIcon = () => <Icon name="back" size={20} />;

/** A tool call's kind, from the name the CLI gave it. */
export type ToolKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'tool' | 'ask' | 'plan';
const TOOL_KIND: Record<string, ToolKind> = {
  Read: 'read', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', apply_patch: 'edit',
  Bash: 'run', shell: 'run', Grep: 'search', Glob: 'search', ToolSearch: 'search',
  WebFetch: 'web', WebSearch: 'web', webSearch: 'web',
  Task: 'tool', Agent: 'tool', mcpToolCall: 'tool', AskUserQuestion: 'ask', ExitPlanMode: 'plan',
};
export const toolKind = (name: string): ToolKind =>
  TOOL_KIND[name] ?? (/read|cat|view/i.test(name) ? 'read'
    : /search|grep|glob|list|find/i.test(name) ? 'search'
    : /write|edit|patch|create/i.test(name) ? 'edit'
    : /bash|shell|exec|run|command/i.test(name) ? 'run' : 'tool');
