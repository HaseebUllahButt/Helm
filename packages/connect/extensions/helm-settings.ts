import { sendHook } from '../src/claude-hooks.js';

/** Observe the running Pi, including changes at the keyboard, without changing its defaults. */
export default function helmSettings(pi: any) {
  let ctx: any, timer: ReturnType<typeof setInterval> | undefined;
  let guard: string | null = null, previous = '', sending = false;
  let restore: (() => void) | undefined;
  const snapshot = () => ({
    model: ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model?.id,
    effort: pi.getThinkingLevel(),
    permissionControl: guard ? 'bash-guard' : 'none', mode: guard,
    session_id: ctx.sessionManager.getSessionId(), transcript_path: ctx.sessionManager.getSessionFile(),
  });
  const report = async () => {
    if (!ctx || sending) return;
    const state = snapshot(), json = JSON.stringify(state);
    // RPC delivers changes on the provider wire. A native terminal repeats
    // its snapshot so a daemon reconnect also learns the current settings.
    if (!process.env.HELM_NATIVE_SESSION) {
      if (json !== previous) ctx.ui.setStatus('helm-settings', json);
      previous = json;
      return;
    }
    sending = true;
    try { await sendHook(process.env.HELM_NATIVE_SESSION, { hook_event_name: 'HelmSettings', ...state }, { timeoutMs: 500 }); }
    finally { sending = false; }
  };
  pi.on('session_start', async (_event: any, context: any) => {
    restore?.(); clearInterval(timer); ctx = context; previous = '';
    // The extension itself is the authority: do not advertise a guard merely
    // because a directory exists. Headless subagents have a different policy.
    const hasGuard = !Number(process.env.PI_SUBAGENT_DEPTH) && pi.getCommands().some((c: any) => c.name === 'bash-guard');
    guard = hasGuard ? (guard ?? (pi.getFlag('--bash-guard-disabled') === true ? 'guard-off' : 'guard')) : null;
    const ui = ctx.ui, original = ui.setStatus;
    // Retain every status, footer, and notification. Observe only the badge
    // published by the installed bash-guard; no shell checks live in Helm.
    const observe = function (key: string, text: string | undefined) {
      original.call(ui, key, text);
      if (hasGuard && key.trim() === 'bash-guard') {
        guard = text ? 'guard-off' : 'guard'; void report();
      }
    };
    ui.setStatus = observe;
    restore = () => { if (ui.setStatus === observe) ui.setStatus = original; };
    await report();
    timer = setInterval(() => void report(), 1500); timer.unref?.();
  });
  pi.on('model_select', async (_event: any, context: any) => { ctx = context; await report(); });
  pi.on('session_shutdown', async () => { clearInterval(timer); restore?.(); ctx = null; });
}
