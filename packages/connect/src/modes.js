/**
 * How much an agent may do without asking, in each CLI's own terms.
 *
 * The app offers the same four ideas everywhere - ask, edit freely, act
 * without asking, read only - and each engine maps them onto its actual
 * flags. The first entry is the default. `short` is the one word the
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
    { id: 'plan', label: 'Plan first', short: 'plan', hint: 'read-only until you approve a plan', cli: 'plan' },
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
    { id: 'plan', label: 'Plan first', short: 'plan', hint: 'read-only until you approve a plan', acp: 'plan' },
    { id: 'auto', label: 'Act without asking', short: 'yolo', hint: 'nothing asks and nothing stops', acp: 'build', autoAllow: 'all', danger: true },
  ],
  opencode2: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'every edit and command is a question', acp: 'build' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'edits go through, commands still ask', acp: 'build', autoAllow: ['edit'] },
    { id: 'plan', label: 'Plan first', short: 'plan', hint: 'read-only until you approve a plan', acp: 'plan' },
    { id: 'auto', label: 'Act without asking', short: 'yolo', hint: 'nothing asks and nothing stops', acp: 'build', autoAllow: 'all', danger: true },
  ],
  // devin's session modes are its own words: Code is its default and asks on
  // the risky half, Ask runs no tools at all, Bypass is the dangerous one.
  devin: [
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'edits and safe commands go through, the rest ask', acp: 'accept-edits' },
    { id: 'read', label: 'Read only', short: 'read', hint: 'answers without touching anything', acp: 'ask' },
    { id: 'plan', label: 'Plan first', short: 'plan', hint: 'plans changes before implementing', acp: 'plan' },
    { id: 'yolo', label: 'Bypass all checks', short: 'yolo', hint: 'nothing asks and nothing stops', acp: 'bypass', danger: true },
  ],
};

export const modesFor = (engine) => MODES[engine] ?? [];
export const defaultMode = (engine) => modesFor(engine)[0]?.id ?? null;
export const modeFor = (engine, id) =>
  modesFor(engine).find((m) => m.id === id) ?? modesFor(engine)[0] ?? null;

/** What the old `auto` toggle meant, for callers that still send it. */
export const modeFromAuto = (engine, auto) => {
  const list = modesFor(engine);
  return (auto ? list.find((m) => m.id === 'auto' || m.id === 'full' || m.danger) : list[0])?.id ?? null;
};
