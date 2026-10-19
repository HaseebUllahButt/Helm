import { memo } from 'react';
/**
 * helm's own icon set: one stroke weight, one 24-unit grid, drawn rather than
 * typed. Text symbols like `⧉ ↻ ⚡ ◎` come from whatever font each phone has,
 * so the same button was a thin glyph on one device and a full-colour emoji on
 * another. Every icon inherits `currentColor` and hides from screen readers -
 * the button around it carries the name.
 */

export type IconName =
  | 'back' | 'forward' | 'popout' | 'up' | 'down' | 'arrow-up' | 'arrow-down'
  | 'more' | 'close' | 'refresh' | 'plus' | 'check' | 'checkbox'
  | 'subagents' | 'git' | 'branch' | 'terminal' | 'raw'
  | 'star' | 'star-on' | 'bolt' | 'model' | 'effort' | 'shield' | 'key'
  | 'read' | 'edit' | 'run' | 'search' | 'web' | 'tool' | 'ask' | 'plan' | 'think' | 'alert'
  | 'folder' | 'repo' | 'machine' | 'transfer' | 'image' | 'sidebar' | 'jump' | 'stop'
  | 'tag' | 'cloud' | 'copy' | 'github' | 'lock';

const PATHS: Record<IconName, JSX.Element> = {
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  popout: <><path d="M13.5 4.5h6v6" /><path d="M19.5 4.5L11 13" /><path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" /></>,
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
  // Echo: a dot with two fading arcs behind it - you, sent out in several places.
  // An ouroboros, the snake eating its own tail: agents that hand work on
  // and back. "Ouroboros" by Lorc, game-icons.net, CC BY 3.0
  // (creativecommons.org/licenses/by/3.0); drawn filled on its 512 grid,
  // scaled to sit at the same size as the line icons.
  subagents: <path transform="translate(2.5 2.5) scale(.0371)" fill="currentColor" stroke="none" d="M365.8 22.43c-10.6.2-22.6 2.5-36.5 7.6c-51.7-7.9-149.3 1.1-219.4 67.5C91.73 113 75.93 132 63.51 154.1C5.036 258.4 43.62 394.3 150.4 457.6C257 520.8 390.1 487.3 448.5 383c48.1-85.5 30.6-192.7-36.4-263.2c-7.9-3.5-16.1-6.1-24.4-5.9c1.7 1.4 3.1 2.7 4.7 4.1l-12.6 13.9c-2.3-2.2-5-4.6-7.2-6.3c-1.3 4.3-1.6 10.1-.2 17.3c42.4 51.9 55 135.2 23.8 191.2c-38.7 69.3-128.2 93.7-197.5 52.3c-69.4-41.3-85.6-127.1-46.9-196.4c23.7-42.5 68.2-66.4 112.1-66.2c10.4 0 20.8 1.4 30.8 4.3c-3.9-12.9-6-24.2-8.1-36.77l6.2-3.1c9.4-4.7 17.7-11.6 25.2-20.5l-5.6-.7l2.4-18.6c4.1.51 8.1 1.1 12.2 1.7l-1.1 6.9c5.2 3.14 10.6 6.44 16 9.7c-9.4 14.3-20.7 26.4-34.4 34.67c2.7 14 7.5 30.6 15.4 46.5c14.2 26.1 32.9 50.5 59.1 53.9c-14-17.6-22.8-34.6-26.8-50c-4.5-17.3-3.1-33.2 6.1-44.3c6.8-8.27 17.5-12.37 29.7-12.07c4.1.1 8.3.6 12.7 1.6c16.5 3.97 35.5 14.47 56.8 32.47c8.2-10.5 9.8-23 7.6-37.07c-31.5-9.2-45.4-70.8-102.3-70m2.9 16.4c4.4.1 9.4 1.2 14.4 3.3c13 5.4 21.5 15.8 18.9 23.1s-15.3 8.8-28.4 3.3s-21.6-15.8-19-23.1c1.5-4.1 6.2-6.4 12.3-6.6zm-73.4 8l-.7 18.7c-6-.36-12.1-.6-18.1-.3l-.5-18.6c6.4-.27 12.9-.1 19.3.2m-38.6 1l1.8 18.6c-6.3.78-12.2 1.29-17.6 2.5l-3.5-18.4c6.9-.99 12.8-2.16 19.3-2.6zm-38 7.29l4.6 17.81c-6.1 1.64-11 3.3-16.9 5.4l-6.5-17.5c7.9-2.65 11.8-4.19 18.8-5.71m-36.9 13.31l8.2 16.8c-5.5 2.62-11.4 5.72-16 8.4l-9.3-16.2c5.8-3.17 11.9-6.32 17.1-9M159 103.3c-5.4 3.9-9.3 7-14 10.9L132.9 100c5-4.5 10.9-8.79 15.4-12.27c3.2 5.27 7.1 10.45 10.7 15.57m-40.4 10l13.3 13.1c-4.2 4.5-8.6 9.2-11.9 13.3l-14.5-11.9c4.2-5.2 9.2-10.6 13.1-14.5m287.7 18.4c4.4 4.9 9.1 10.3 12.6 14.9L404.1 158c-3.7-4.8-8-9.7-11.6-13.6zM93.76 143.4L109.1 154c-3.4 5.1-6.7 10.6-9.41 15.1l-16.25-9.2c3.29-5.7 6.87-11.8 10.32-16.5m336.34 19.2c3.6 5.6 7.1 11.9 9.6 17.1l-16.6 8.4c-3-5.8-5.6-10.4-8.8-15.5zM74.6 177.3l16.99 7.8c-2.53 5.7-4.93 11.7-6.66 16.5l-17.6-6.2c1.65-6.4 3.64-12.6 7.27-18.1m373 20.3l.1.1v.1c2.2 6.1 4.4 12.3 5.9 18.6l-18 4.7c-1.8-5.9-3.6-11.9-5.5-16.9c5.9-2 11.7-4.3 17.5-6.6M61.67 214l18.08 4.7c-1.45 6-2.71 12.3-3.6 17.5l-18.42-3.1c1.24-6.7 2.44-13.7 3.94-19.1m396.03 21.5c.6 6.7 1.6 13.6 2 19.6l-18.6 1c-.3-5.8-1.1-11.6-1.8-17.4c5.6-1.2 12.4-2.2 18.4-3.2M55.52 252.7l18.41 1c-.51 6 0 11.9 0 17.9l-18.67.7c-.15-6.8 0-13.8.26-19.6m385.68 21.1l18.7 1c-.4 7.4-.9 12.7-1.8 19.5l-18.5-2.5c.9-6 1.3-12 1.6-18m-362.73 33l-18.19 4.3c-1.51-6.3-2.45-12.8-3.32-19.2l18.52-2.5c.47 5.7 1.81 12.4 2.99 17.4m357.83 2.3l18.2 4.3c-1.4 6.4-3.2 12.5-5.2 18.7v.1l-.1.1c-5.9-2.1-11.8-4-17.7-5.9v-.2c1.9-5.6 3.6-11.3 4.8-17.1M83.39 323.8c2.16 6.2 4.23 11.1 6.62 16.5l-16.94 7.8c-2.96-5.8-5.04-12-7.17-18.2c5.61-2 12.5-4.2 17.49-6.1m341.71 19.3l17.2 7.3c-2.8 6.7-5.6 11.8-8.5 17.6l-16.4-8.9c2.9-5.2 5.5-11.2 7.7-16M98.28 355.9c3.22 5.2 6.52 10.7 9.82 14.8l-14.98 11.2c-4.1-5.6-8.23-11.6-11.13-16.4c4.67-3.5 10.88-6.7 16.29-9.6m310.02 18.5l15.5 10.4c-4.1 6.1-7.1 10.4-11.3 15.7L397.8 389c3.7-4.7 7.1-9.6 10.5-14.6m-288.9 10c4 4.5 8.3 8.7 12.6 12.8l-12.7 13.7c-4.8-4.5-9.8-9.6-13.8-13.8zm266.7 18l13.6 12.9c-5.1 5.2-9.3 9.4-14.2 13.6l-12.2-14.1c4.5-4.2 9.2-8.5 12.8-12.4m-240.5 6.2c4.7 3.6 9.6 7.1 14.7 10.4l-10.2 15.7c-5.5-3.5-10.6-7.3-15.8-11.2zm213.8 17.2l10.7 15.3c-5.4 3.8-11.3 7.6-16.3 10.5l-9.4-16.2c5.8-3.3 9.8-6 15-9.6m-183.6 2.4c5.2 3 10.6 5.6 16.1 8.1l-7.9 17c-5.8-2.8-11.6-5.6-17.3-8.7zm152.8 15.1l7.5 17.1c-6 2.8-12.2 4.9-18.5 6.9l-5.5-17.9c5.6-1.6 11.1-3.7 16.5-6.1m-120 .1c5.8 2.2 11.8 4.2 16.8 5.8l-5.2 18c-6.4-2.1-13-4.2-18.5-6.5c2.3-5.7 4.7-12 6.9-17.3m34 10c6 1.1 12.1 1.8 17.4 2.2l-1 18.7c-6.8-.9-13.8-1.4-19.8-2.5zm52.4.2l3.3 18.4c-6.6 1.6-12.6 2.3-19.7 2.3l-.9-18.6c5.8-.3 11.5-1.2 17.3-2.1" />,
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
  key: <><circle cx="8" cy="15" r="3.5" /><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2" /></>,
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
  github: <><path d="M15 21v-3.5a3.6 3.6 0 00-1-2.8c3.2-.4 6.5-1.6 6.5-7a5.4 5.4 0 00-1.5-3.8 5 5 0 00-.1-3.7s-1.2-.4-3.9 1.4a13.4 13.4 0 00-7 0C5.3 1.8 4.1 2.2 4.1 2.2a5 5 0 00-.1 3.7 5.4 5.4 0 00-1.5 3.8c0 5.4 3.3 6.6 6.5 7a3.6 3.6 0 00-1 2.8V21" /><path d="M8 18.5c-3 .9-3-1.6-4.5-2" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V7.5a3.5 3.5 0 017 0v3" /></>,
};

// Icons sit in every row and header, and take only plain values: they skip
// drawing again when those are the same.
export const Icon = memo(function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >{PATHS[name]}</svg>
  );
});

/** The way back, the same size on every screen. */
export const BackIcon = memo(() => <Icon name="back" size={20} />);

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
