import { ENGINES } from './engines.js';

/** Native dialogs, not headless-driver modes: those can depend on Helm answering approvals. */
const PICKERS = {
  claude: { model: '/model', effort: '/effort', mode: '/permissions', settings: '/config' },
  codex: { model: '/model', mode: '/permissions', settings: '/help' },
  opencode: { model: '/models' },
  opencode2: { model: '/models' },
  devin: { model: '/model', mode: '/mode', settings: '/config' },
  grok: { model: '/model', effort: '/effort', mode: '/settings', settings: '/settings' },
  cursor: { model: '/model', settings: '/config' },
  pi: { model: '/model', effort: '/thinking', settings: '/settings' },
  omp: { model: '/model', effort: '/effort', settings: '/settings' },
  agy: { model: '/model' },
  gemini: { model: '/model', settings: '/settings' },
  kimi: { model: '/model', mode: '/permission', settings: '/settings' },
};

/** Every shared CLI has a tray. Unknown controls open its terminal without sending guessed commands. */
export function nativeControls(engine) {
  if (!ENGINES[engine]?.bin || ENGINES[engine].plain) return [];
  return Object.keys({ ...PICKERS[engine], settings: true });
}
export function nativeControlCommand(engine, kind) {
  if (!nativeControls(engine).includes(kind)) throw new Error('this CLI does not offer that control');
  return PICKERS[engine]?.[kind] ?? null;
}
export function nativeCommands(engine) {
  return [...new Set(Object.values(PICKERS[engine] ?? {}))].map(command => ({
    name: command.slice(1), description: 'Open the CLI control', source: engine,
  }));
}

/** These CLIs accept a model selector; some versions still ask for a final native confirmation. */
export function nativeSettingCommand(engine, kind, value) {
  const models = ['claude', 'devin', 'grok', 'cursor', 'pi', 'omp', 'agy', 'kimi'];
  const effort = { claude: '/effort', grok: '/effort', pi: '/thinking', omp: '/effort' };
  const prefix = kind === 'model' && models.includes(engine) ? '/model' : kind === 'effort' ? effort[engine] : null;
  if (!prefix) throw new Error('Use this CLI\'s native picker to change that setting.');
  if (typeof value !== 'string' || !value || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+\[\]-]*$/.test(value)) throw new Error('invalid CLI setting');
  return `${prefix} ${value}`;
}
export const nativeModelChoices = engine => ['devin', 'grok', 'cursor', 'pi', 'omp', 'agy', 'kimi'].includes(engine);
export const nativeEffortChoices = engine => ['grok', 'pi', 'omp'].includes(engine);
