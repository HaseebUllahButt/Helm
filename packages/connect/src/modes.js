/**
 * How much an agent may do without asking, in each CLI's own terms.
 *
 * The app offers the same four ideas everywhere - ask, edit freely, act
 * without asking, read only - and each engine maps them onto its actual
 * flags. YOLO is the default unless an account explicitly configures another
 * mode. `short` is the one word the
 * composer's chip shows; `danger` marks a mode the app makes the owner
 * confirm and never reaches by the cycle shortcut.
 *
 * Codex carries two spellings of the same sandbox: `sandbox` is the string
 * `thread/start` takes, `sandboxPolicy` the object `turn/start` takes to
 * override it "for this turn and subsequent turns" - which is what makes
 * switching modes mid-session mean anything.
 */
export const MODES = {
  claude: [
    { id: 'default', label: 'Ask before acting', short: 'ask', hint: 'every edit and command is a question', cli: 'manual' },
    { id: 'acceptEdits', label: 'Edit freely', short: 'edit', hint: 'edits go through, commands still ask', cli: 'acceptEdits' },
    { id: 'auto', label: 'Act without asking', short: 'auto', hint: 'Claude blocks risky actions quietly; they will not ping your phone', cli: 'auto' },
    { id: 'bypassPermissions', label: 'Bypass all checks', short: 'yolo', hint: 'permission checks are off; direct questions from Claude still need an answer', cli: 'bypassPermissions', danger: true },
  ],
  codex: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'sandboxed in the workspace; anything else asks', approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'writes inside the workspace, never asks', approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
    { id: 'full', label: 'Act without asking', short: 'yolo', hint: 'no sandbox, no questions', approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, danger: true },
    { id: 'readonly', label: 'Read only', short: 'read', hint: 'cannot write; every command asks', approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
  ],
  // ACP engines: `acp` is the value for configId 'mode'. opencode only knows
  // build/plan, so `autoAllow` makes the driver itself answer the prompts a
  // mode would skip - an edit auto-allow still stops for a command.
  opencode: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'every edit and command is a question', acp: 'build' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'edits go through, commands still ask', acp: 'build', autoAllow: ['edit'] },
    { id: 'auto', label: 'Act without asking', short: 'yolo', hint: 'nothing asks and nothing stops', acp: 'build', autoAllow: 'all', danger: true },
  ],
  opencode2: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'every edit and command is a question', acp: 'build' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'edits go through, commands still ask', acp: 'build', autoAllow: ['edit'] },
    { id: 'auto', label: 'Act without asking', short: 'yolo', hint: 'nothing asks and nothing stops', acp: 'build', autoAllow: 'all', danger: true },
  ],
  // devin's session modes are its own words: Code is its default and asks on
  // the risky half, Ask runs no tools at all, Bypass is the dangerous one.
  devin: [
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'edits and safe commands go through, the rest ask', acp: 'accept-edits' },
    { id: 'read', label: 'Read only', short: 'read', hint: 'answers without touching anything', acp: 'ask' },
    { id: 'yolo', label: 'Bypass all checks', short: 'yolo', hint: 'nothing asks and nothing stops', acp: 'bypass', danger: true },
  ],
  // Grok's permission-mode vocabulary is Claude's (`grok --permission-mode`
  // takes the same words); over ACP they land as the session mode picker or
  // configOptions, whichever the running build advertises.
  grok: [
    { id: 'default', label: 'Ask before acting', short: 'ask', hint: 'every edit and command is a question', acp: 'default' },
    { id: 'acceptEdits', label: 'Edit freely', short: 'edit', hint: 'edits go through, commands still ask', acp: 'acceptEdits' },
    { id: 'auto', label: 'Act without asking', short: 'auto', hint: 'Grok blocks risky actions quietly; they will not ping your phone', acp: 'auto' },
    { id: 'bypassPermissions', label: 'Bypass all checks', short: 'yolo', hint: 'permission checks are off', acp: 'bypassPermissions', approveAll: true, danger: true },
  ],
  // Cursor's execution modes are the ones its `--mode` flag documents; the
  // agent is free to refuse a name it does not carry, and the correction
  // lands as a settings update.
  cursor: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'every edit and command is a question', acp: 'ask' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'agent mode: edits and commands run', acp: 'agent' },
    { id: 'auto', label: 'Act without asking', short: 'yolo', hint: 'nothing asks and nothing stops', acp: 'agent', autoAllow: 'all', danger: true },
  ],
  // agy's `--mode` flag knows accept-edits and plan; "everything" is the
  // --dangerously-skip-permissions flag. There is no way to answer a
  // permission prompt over stream-json, so ask relies on the account's own
  // settings/allow rules - unapproved tools simply do not run.
  agy: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'tools follow your agy permission settings; unapproved ones are skipped' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'accept-edits: file changes go through, the rest follows settings', agyMode: 'accept-edits' },
    { id: 'yolo', label: 'Act without asking', short: 'yolo', hint: 'approves every tool call, including writes and commands', skipPermissions: true, danger: true },
  ],
  // The managed Google ACP agent carries default/auto_edit/yolo natively;
  // planning is its own /plan command rather than a session mode.
  antigravity: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'every edit and command is a question', acp: 'default' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'file edits go through, commands still ask', acp: 'auto_edit' },
    { id: 'yolo', label: 'Act without asking', short: 'yolo', hint: 'nothing asks and nothing stops', acp: 'yolo', danger: true },
  ],
  // Pi and OMP run their tools without asking; approval lives in extension
  // dialogs, which arrive as permission requests whatever helm calls it -
  // so they carry no entry and the app shows no mode picker for them.
  // Rovo's ACP surface has no verified mode vocabulary yet either.
};

export const modesFor = (engine) => MODES[engine] ?? [];
export const defaultMode = (engine) =>
  (modesFor(engine).find((m) => m.short === 'yolo') ?? modesFor(engine)[0])?.id ?? null;
export const modeFor = (engine, id) =>
  modesFor(engine).find((m) => m.id === id) ?? modesFor(engine).find((m) => m.id === defaultMode(engine)) ?? null;

/** What the old `auto` toggle meant, for callers that still send it. */
export const modeFromAuto = (engine, auto) => {
  const list = modesFor(engine);
  return (auto ? list.find((m) => m.id === 'auto' || m.id === 'full' || m.danger) : list[0])?.id ?? null;
};
