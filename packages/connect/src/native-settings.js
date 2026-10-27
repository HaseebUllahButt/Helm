/** Explicit launch choices only. Account defaults are not live provider state. */
export function nativeLaunchSettings(engine, args = []) {
  const flag = (...names) => {
    let value;
    for (let i = 0; i < args.length; i++) {
      if (names.includes(args[i])) value = args[++i];
      else for (const name of names) if (args[i]?.startsWith(`${name}=`)) value = args[i].slice(name.length + 1);
    }
    return typeof value === 'string' && value && !value.startsWith('-') ? value : undefined;
  };
  const out = {};
  const model = flag('--model', '-m');
  const effort = flag(...(['pi','omp'].includes(engine) ? ['--thinking'] : ['--effort']));
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (['claude','grok'].includes(engine)) {
    const mode = flag('--permission-mode');
    if (mode) out.mode = mode;
    // The allow flag makes bypass available; only the skip flag selects it.
    if (args.includes('--dangerously-skip-permissions')) out.mode = 'bypassPermissions';
  }
  if (engine === 'codex' && args.some(a => ['--yolo','--dangerously-bypass-approvals-and-sandbox'].includes(a))) out.mode = 'full';
  return out;
}


/** Match a reported Codex policy, including the object spelling used by its API. */
export function reportedMode(engine, info) {
  if (info.mode || info.permissionMode) return info.mode || info.permissionMode;
  if (engine !== 'codex') return undefined;
  const policy = info.sandbox ?? info.sandboxPolicy;
  const sandbox = typeof policy === 'string' ? policy : policy?.type;
  const approval = info.approvalPolicy;
  if (['danger-full-access','dangerFullAccess'].includes(sandbox) && approval === 'never') return 'full';
  if (['workspace-write','workspaceWrite'].includes(sandbox)) {
    if (approval === 'never') return 'edit';
    if (approval === 'on-request') return ['auto_review', 'guardian_subagent'].includes(info.approvalsReviewer) ? 'auto-review' : 'ask';
  }
  if (['read-only','readOnly'].includes(sandbox) && approval === 'untrusted') return 'readonly';
  return undefined;
}
