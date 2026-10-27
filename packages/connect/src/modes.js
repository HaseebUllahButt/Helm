/**
 * How much an agent may do without asking, in each CLI's own terms.
 *
 * The app offers the same four ideas everywhere - ask, edit freely, act
 * without asking, read only - and each engine maps them onto its actual
 * flags. YOLO is the default unless an account explicitly configures another
 * mode. `short` is the one word the
 * composer's chip shows; `danger` marks a mode the app makes the owner
 * confirm when picked from the menu. The shift+tab cycle reaches it too.
 *
 * Codex carries two spellings of the same sandbox: `sandbox` is the string
 * `thread/start` takes, `sandboxPolicy` the object `turn/start` takes to
 * override it "for this turn and subsequent turns" - which is what makes
 * switching modes mid-session mean anything.
 */
export const MODES = {
  claude: [
    { id: 'default', label: 'Ask before acting', short: 'ask', hint: 'The agent asks before each edit and command.', cli: 'manual' },
    { id: 'acceptEdits', label: 'Edit freely', short: 'edit', hint: 'The agent edits files without asking. Commands need approval.', cli: 'acceptEdits' },
    { id: 'auto', label: 'Act without asking', short: 'auto', hint: 'Claude blocks risky actions without sending phone notifications.', cli: 'auto' },
    { id: 'bypassPermissions', label: 'Bypass all checks', short: 'yolo', hint: 'Claude’s --dangerously-skip-permissions skips approval requests. Hooks can block actions, and Claude can ask questions.', cli: 'bypassPermissions', danger: true },
  ],
  codex: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'The agent works inside the project folder. Other actions need approval.', approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
    { id: 'auto-review', label: 'Codex reviews', short: 'auto', hint: 'Codex’s free reviewer approves safe steps; you see the risky ones.', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'The agent writes inside the project folder without asking.', approvalPolicy: 'never', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
    { id: 'full', label: 'Act without asking', short: 'yolo', hint: 'The agent can access the whole machine without asking.', approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, danger: true },
    { id: 'readonly', label: 'Read only', short: 'read', hint: 'The agent cannot write files. Commands need approval.', approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
  ],
  // ACP engines: `acp` is the value for configId 'mode'. opencode only knows
  // build/plan, so `autoAllow` makes the driver itself answer the prompts a
  // mode would skip - an edit auto-allow still stops for a command.
  opencode: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'The agent asks before each edit and command.', acp: 'build' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'The agent edits files without asking. Commands need approval.', acp: 'build', autoAllow: ['edit'] },
    { id: 'auto', label: 'Act without asking', short: 'yolo', hint: 'The agent acts without approval requests or permission blocks.', acp: 'build', autoAllow: 'all', danger: true },
  ],
  opencode2: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'The agent asks before each edit and command.', acp: 'build' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'The agent edits files without asking. Commands need approval.', acp: 'build', autoAllow: ['edit'] },
    { id: 'auto', label: 'Act without asking', short: 'yolo', hint: 'The agent acts without approval requests or permission blocks.', acp: 'build', autoAllow: 'all', danger: true },
  ],
  // devin's session modes are its own words: Code is its default and asks on
  // the risky half, Ask runs no tools at all, Bypass is the dangerous one.
  devin: [
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'The agent edits files and runs safe commands without asking. Other actions need approval.', acp: 'accept-edits' },
    { id: 'read', label: 'Read only', short: 'read', hint: 'The agent answers without changing files or running commands.', acp: 'ask' },
    { id: 'yolo', label: 'Bypass all checks', short: 'yolo', hint: 'The agent acts without approval requests or permission blocks.', acp: 'bypass', danger: true },
  ],
  // Grok's permission-mode vocabulary is Claude's (`grok --permission-mode`
  // takes the same words); over ACP they land as the session mode picker or
  // configOptions, whichever the running build advertises.
  grok: [
    { id: 'default', label: 'Ask before acting', short: 'ask', hint: 'The agent asks before each edit and command.', acp: 'default' },
    { id: 'acceptEdits', label: 'Edit freely', short: 'edit', hint: 'The agent edits files without asking. Commands need approval.', acp: 'acceptEdits' },
    { id: 'auto', label: 'Act without asking', short: 'auto', hint: 'Grok blocks risky actions without sending phone notifications.', acp: 'auto' },
    { id: 'bypassPermissions', label: 'Bypass all checks', short: 'yolo', hint: 'The agent skips permission checks.', acp: 'bypassPermissions', approveAll: true, danger: true },
  ],
  // Cursor's execution modes are the ones its `--mode` flag documents; the
  // agent is free to refuse a name it does not carry, and the correction
  // lands as a settings update.
  cursor: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'The agent asks before each edit and command.', acp: 'ask' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'The agent edits files and runs commands.', acp: 'agent' },
    { id: 'auto', label: 'Act without asking', short: 'yolo', hint: 'The agent acts without approval requests or permission blocks.', acp: 'agent', autoAllow: 'all', danger: true },
  ],
  // agy's `--mode` flag knows accept-edits and plan; "everything" is the
  // --dangerously-skip-permissions flag. There is no way to answer a
  // permission prompt over stream-json, so ask relies on the account's own
  // settings/allow rules - unapproved tools simply do not run.
  agy: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'Tools follow your agy permission settings. The agent skips tools without approval.' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'accept-edits allows file changes. Other actions follow your settings.', agyMode: 'accept-edits' },
    { id: 'yolo', label: 'Act without asking', short: 'yolo', hint: 'The agent approves every tool action, including file changes and commands.', skipPermissions: true, danger: true },
  ],
  // The managed Google ACP agent carries default/auto_edit/yolo natively;
  // planning is its own /plan command rather than a session mode.
  antigravity: [
    { id: 'ask', label: 'Ask before acting', short: 'ask', hint: 'The agent asks before each edit and command.', acp: 'default' },
    { id: 'edit', label: 'Edit freely', short: 'edit', hint: 'The agent edits files without asking. Commands need approval.', acp: 'auto_edit' },
    { id: 'yolo', label: 'Act without asking', short: 'yolo', hint: 'The agent acts without approval requests or permission blocks.', acp: 'yolo', danger: true },
  ],
  // Pi and OMP run their tools without asking; approval lives in extension
  // dialogs, which arrive as permission requests whatever helm calls it -
  // so they carry no entry and the app shows no mode picker for them.
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

// These are bash-guard's session states, not permissions for Pi's other tools.
export const BASH_GUARD_MODES = [
  { id: 'guard', label: 'Bash guard on', short: 'guard', hint: 'bash-guard asks before flagged commands. Other tools follow their extension settings.' },
  { id: 'guard-off', label: 'Bash guard off', short: 'guard off', hint: 'bash-guard skips command approval requests. It still blocks commands that can cause severe damage.', danger: true },
];
