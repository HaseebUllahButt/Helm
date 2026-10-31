const articles = new Set(['the', 'a', 'an']);
const fields = ['textbox', 'input', 'textarea', 'searchbox', 'combobox', 'select'];
const kinds = { button: ['button', 'summary'], link: ['link', 'a'], box: fields, field: fields, input: fields, textbox: fields, textarea: fields, checkbox: ['checkbox'], radio: ['radio'], tab: ['tab'], menu: ['menu', 'menuitem', 'button', 'combobox'], option: ['option', 'radio', 'menuitem'], dropdown: ['select', 'combobox'], switch: ['switch'] };
export const words = value => (String(value).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter(word => !articles.has(word));

export function scoreTargets(target, elements, purpose) {
  const wanted = words(target), hints = [];
  while (wanted.length > 1 && kinds[wanted.at(-1)]) hints.push(...kinds[wanted.pop()]);
  while (wanted.length > 1 && kinds[wanted[0]]) hints.push(...kinds[wanted.shift()]);
  const allowed = purpose === 'type' ? fields : purpose === 'select' ? ['combobox', 'select'] : purpose === 'upload' ? ['file', 'button', 'link'] : null;
  return elements.filter(e => (!hints.length || hints.includes(e.role)) && (!allowed || allowed.includes(e.role))).map(e => {
    const name = words(e.name), matched = wanted.filter(word => name.includes(word)).length;
    const match = !wanted.length || !matched ? 0 : name.join(' ') === wanted.join(' ') ? 1000 : matched === wanted.length ? 800 : matched > wanted.length / 2 ? 600 * matched / wanted.length : 0;
    return { ...e, score: match + (match ? (e.visible !== false ? 4 : 0) + (!e.disabled ? 2 : 0) + (e.inViewport !== false ? 1 : 0) : 0) };
  }).sort((a, b) => b.score - a.score || a.ref - b.ref);
}

export function resolveTarget(target, elements, purpose) {
  const ranked = scoreTargets(target, elements, purpose), candidates = ranked.slice(0, 5);
  if (!ranked[0]?.score || ranked[0].score === ranked[1]?.score) {
    const error = new Error(`${ranked[0]?.score ? 'ambiguous' : 'no matching'} target ${JSON.stringify(target)}; choose an element number: ${candidates.map(e => `[${e.ref}] ${e.role} ${JSON.stringify(e.name)}`).join(', ') || 'none'}`);
    error.candidates = candidates; throw error;
  }
  return ranked[0];
}

const targetFields = target => typeof target === 'number' || typeof target === 'string' && /^\d+$/.test(target.trim()) ? { ref: Number(target) } : target && typeof target === 'object' ? target : { target };
export function normalizeAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('browser action must be an object');
  if (action.kind) return action;
  if (Array.isArray(action.actions)) return { ...action, kind: 'batch' };
  if ('goto' in action) return { ...action, kind: 'navigate', url: action.goto };
  for (const kind of ['click', 'hover', 'select']) if (kind in action) return { ...action, kind, ...targetFields(action[kind]), ...(kind === 'select' ? { option: action.option } : {}) };
  if ('type' in action) return { ...action, kind: 'type', text: action.type, ...(action.into != null ? targetFields(action.into) : {}), clear: action.clear === true, enter: action.enter === true, append: action.clear !== true };
  if ('key' in action) return { ...action, kind: 'key' };
  if ('scroll' in action) { if (!['up', 'down'].includes(action.scroll) || !Number.isFinite(action.pages ?? 1) || (action.pages ?? 1) < 0) throw new Error('scroll needs up or down and a positive page count'); return { ...action, kind: 'scroll', direction: action.scroll }; }
  if ('wait_for' in action) return { ...action, kind: 'wait', text: action.wait_for };
  if ('back' in action && action.back === true) return { ...action, kind: 'back' };
  if ('check' in action) { if (action.expect != null && typeof action.expect !== 'boolean') throw new Error('check expect must be true or false'); return { ...action, kind: 'check', expect: action.expect ?? true }; }
  if ('evaluate' in action || typeof action.script === 'string') return { ...action, kind: 'evaluate', script: action.evaluate ?? action.script };
  if ('upload' in action) return { ...action, kind: 'upload', ...targetFields(action.upload) };
  if (typeof action.wait === 'string') return { ...action, kind: 'wait', selector: action.wait };
  if ('resize' in action) return { ...action, kind: 'resize', ...(action.resize && typeof action.resize === 'object' ? action.resize : {}) };
  if ('dialog' in action) return { ...action, kind: 'dialog', accept: action.accept ?? action.dialog === 'accept' };
  for (const kind of ['forward', 'reload', 'console', 'network']) if (action[kind] === true) return { ...action, kind };
  return action;
}

export function readOnlyAction(action) {
  action = normalizeAction(action);
  return ['look', 'console', 'network', 'screenshot', 'point', 'navigate', 'back', 'forward', 'check'].includes(action.kind) || action.kind === 'wait' && Object.hasOwn(action, 'wait_for') || action.kind === 'batch' && Array.isArray(action.actions) && action.actions.every(readOnlyAction);
}
