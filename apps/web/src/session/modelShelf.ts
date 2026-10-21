/**
 * Which models a picker shows first, out of everything a CLI lists.
 *
 * Claude lists every version since 4.5 plus dated copies, devin prints each
 * model once per thinking level, speed and partner model (800 rows), and
 * opencode or pi list every provider they reach. The picker shows the newest
 * of each line, folds devin's levels into the thinking and speed chips, and
 * leaves the rest one search away.
 */

/** More than this after trimming is an aggregator's list: search it instead. */
export const SHORT_MAX = 12;

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const SPEEDS = ['fast', 'priority', 'lightning'];

/** "opencode/gpt-6-sol" -> "opencode"; a plain id has none. */
export const providerOf = (id: string) => {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : '';
};

/** A model's line and version: "Claude Opus 4.5" -> "claude opus #", [4, 5]. */
function lineOf(id: string, labels: Record<string, string>) {
  const provider = providerOf(id);
  let name = (labels[id] || id.slice(provider ? provider.length + 1 : 0).replace(/(\d)-(?=\d)/g, '$1.')).toLowerCase();
  // "(latest)" and "(Antigravity)" say nothing about which line it is.
  name = name.replace(/\s*\((latest|[^)]*)\)/g, (m, word) =>
    word === 'latest' || (provider && word.includes(provider)) ? '' : m).replace(/[-.]?\d{8}\b/, '').trim();
  const version = (name.match(/\d+(?:\.\d+)*/g) ?? []).join('.').split('.').filter(Boolean).map(Number);
  return { key: `${provider}|${name.replace(/\d+(?:\.\d+)*/g, '#').replace(/[\s_-]+/g, ' ')}`, version };
}

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d > 0;
  }
  return false;
};

/**
 * Split a list into what the picker shows and what waits behind "more".
 * `keep` (the model in use, the default) always shows. A list still too long
 * after keeping only the newest of each line shows just `keep`.
 */
export function shelve(ids: string[], labels: Record<string, string>, keep: string[]) {
  const best = new Map<string, number[]>();
  const lines = new Map(ids.map((id) => [id, lineOf(id, labels)]));
  for (const { key, version } of lines.values()) {
    const top = best.get(key);
    if (!top || newer(version, top)) best.set(key, version);
  }
  let main = ids.filter((id) => {
    const line = lines.get(id)!;
    return !newer(best.get(line.key)!, line.version) && !/^fusion\b/i.test(labels[id] ?? id);
  });
  if (main.length > SHORT_MAX) main = [];
  for (const id of keep) if (id && ids.includes(id) && !main.includes(id)) main.push(id);
  main = ids.filter((id) => main.includes(id));
  return { main, rest: ids.filter((id) => !main.includes(id)) };
}

export interface Variant { id: string; effort: string; speed: string }

/**
 * devin bakes the thinking level and speed into each model's name
 * ("claude-opus-5-5-high-fast"). A base with two or more such variants
 * becomes one row; its levels and speeds become the other chips.
 */
export function foldTiers(ids: string[], labels: Record<string, string>) {
  const groups = new Map<string, Variant[]>();
  for (const id of ids) {
    const parts = id.split('-');
    const speed = SPEEDS.includes(parts.at(-1)!) ? parts.pop()! : '';
    const effort = EFFORTS.includes(parts.at(-1)!) ? parts.pop()! : '';
    if (!speed && !effort) continue;
    const base = parts.join('-');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push({ id, effort, speed });
  }
  const variants = new Map<string, Variant[]>();
  const baseOf = new Map<string, string>();
  const names: Record<string, string> = {};
  for (const [base, list] of groups) {
    // A real model already called this ("swe-1-7") keeps its rows.
    if (list.length < 2 || ids.includes(base)) continue;
    variants.set(base, list);
    for (const v of list) baseOf.set(v.id, base);
    const label = labels[list[0].id];
    names[base] = label
      ? label.replace(/\s+(fast|priority|lightning)$/i, '').replace(/\s+(no|none|minimal|low|medium|high|xhigh|max)(\s+thinking)?$/i, '').trim()
      : base;
  }
  return { variants, baseOf, names };
}

/**
 * The variant to run when the owner picks a base, a level or a speed: the
 * one asked for, keeping whatever else matches the variant in use.
 */
export function variantFor(list: Variant[], want: Partial<Pick<Variant, 'effort' | 'speed'>>, now?: Variant) {
  const effort = want.effort ?? now?.effort;
  const speed = want.speed ?? now?.speed ?? '';
  return list.find((v) => v.effort === effort && v.speed === speed)
    ?? (want.effort !== undefined ? list.find((v) => v.effort === effort) : undefined)
    ?? (want.speed !== undefined ? list.find((v) => v.speed === speed) : undefined)
    ?? list.find((v) => !v.speed && v.effort === 'medium')
    ?? list.find((v) => !v.speed)
    ?? list[0];
}

/** The thinking levels a base offers at a speed, lowest first. */
export function levelsOf(list: Variant[], speed: string) {
  const at = list.filter((v) => v.speed === speed && v.effort);
  return [...new Set((at.length ? at : list.filter((v) => v.effort)).map((v) => v.effort))]
    .sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
}
