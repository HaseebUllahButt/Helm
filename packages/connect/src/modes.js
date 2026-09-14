/**
 * How much an agent may do without asking, in each CLI's own terms.
 *
 * The app offers the same four ideas everywhere - ask, edit freely, act
 * without asking, read only - and each engine maps them onto its actual
 * flags. The first entry is the default. `danger` marks a mode the app
 * should make the owner confirm.
 */
export const MODES = {
  claude: [
    { id: 'default', label: 'Ask before acting', hint: 'every edit and command is a question', cli: 'manual' },
    { id: 'acceptEdits', label: 'Edit freely', hint: 'edits go through, commands still ask', cli: 'acceptEdits' },
    { id: 'plan', label: 'Plan first', hint: 'read-only until you approve a plan', cli: 'plan' },
    { id: 'auto', label: 'Act without asking', hint: 'a safety classifier still stops dangerous commands', cli: 'auto' },
    { id: 'bypassPermissions', label: 'Bypass all checks', hint: 'nothing asks and nothing stops', cli: 'bypassPermissions', danger: true },
  ],
  codex: [
    { id: 'ask', label: 'Ask before acting', hint: 'sandboxed in the workspace; anything else asks', approvalPolicy: 'on-request', sandbox: 'workspace-write' },
    { id: 'edit', label: 'Edit freely', hint: 'writes inside the workspace, never asks', approvalPolicy: 'never', sandbox: 'workspace-write' },
    { id: 'full', label: 'Act without asking', hint: 'no sandbox, no questions', approvalPolicy: 'never', sandbox: 'danger-full-access', danger: true },
    { id: 'readonly', label: 'Read only', hint: 'cannot write; every command asks', approvalPolicy: 'untrusted', sandbox: 'read-only' },
  ],
};

export const modesFor = (engine) => MODES[engine] ?? [];
export const defaultMode = (engine) => modesFor(engine)[0]?.id ?? null;
export const modeFor = (engine, id) =>
  modesFor(engine).find((m) => m.id === id) ?? modesFor(engine)[0] ?? null;

/** What the old `auto` toggle meant, for callers that still send it. */
export const modeFromAuto = (engine, auto) => {
  const list = modesFor(engine);
  return (auto ? list.find((m) => m.id === 'auto' || m.id === 'full') : list[0])?.id ?? null;
};
