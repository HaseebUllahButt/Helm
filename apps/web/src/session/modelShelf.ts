/**
 * Which models a picker shows first, out of everything a CLI lists.
 *
 * Claude lists every version since 4.5 plus dated copies, devin prints each
 * model once per thinking level, speed and partner model (800 rows), and
 * opencode or pi list every provider they reach. The picker shows the newest
 * of each line, folds devin's levels into the thinking and speed chips, and
 * leaves the rest one search away.
 */

/** The most rows a picker shows before "more". */
export const SHORT_MAX = 20;

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const SPEEDS = ['fast', 'priority', 'lightning'];
const TIER = /^(none|minimal|low|medium|high|xhigh|max|thinking)$/;

/** "opencode/gpt-6-sol" -> "opencode"; a plain id has none. */
export const providerOf = (id: string) => {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : '';
};

const UPPER = new Set(['gpt', 'glm', 'oss', 'swe', 'ai']);

/**
 * A name worth reading: "claude-haiku-5-5" -> "Claude Haiku 5.5",
 * "GPT-6.1-Sol" -> "GPT-6.1 Sol". A CLI that names its models well keeps
 * its names; only bare ids and hyphen-joined labels change, and only when
 * they carry a version - "sonnet" or "big-pickle" is a name already.
 */
export function prettyName(id: string, label?: string) {
  // Claude's "Opus 4.5 (latest)" is the same model as its dated copy.
  label = label?.replace(/\s*\(latest\)$/i, '');
  if (label && (/\s/.test(label) || !/\d/.test(label))) return label;
  if (label) return label.replace(/-(?!\d)/g, ' ');
  if (!/\d/.test(id)) return id;
  const provider = providerOf(id);
  const words = id.slice(provider ? provider.length + 1 : 0).replace(/(\d)-(?=\d)/g, '$1.').split(/[-_]+/).filter(Boolean)
    .map((w) => UPPER.has(w.toLowerCase()) ? w.toUpperCase() : /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w);
  // "GPT 6.1" reads as the vendors write it: "GPT-6.1".
  return words.join(' ').replace(/^GPT (?=\d)/, 'GPT-');
}

/** A model's line and version: "Claude Opus 4.5" -> "claude opus #", [4, 5]. */
function lineOf(id: string, labels: Record<string, string>) {
  const provider = providerOf(id);
  let name = (labels[id] || id.slice(provider ? provider.length + 1 : 0).replace(/(\d)-(?=\d)/g, '$1.')).toLowerCase();
  // "(latest)", "(Antigravity)", "High Thinking" and "1M" (how much it
  // reads) say nothing about which line it is or how new.
  name = name.replace(/\s*\(([^)]*)\)/g, (m, word) =>
    word === 'latest' || TIER.test(word) || (provider && word.includes(provider)) ? '' : m)
    .replace(/[-.]?\d{8}\b/, '').replace(/\b\d+[mk]\b/g, '')
    .replace(/(^|[\s-])(no thinking|thinking|none|minimal|low|medium|high|xhigh|fast|priority|lightning)(?=$|[\s-])/g, '$1').trim();
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
 * A model shows when it is the newest of its line ("Claude Opus 4.8" loses
 * to 5.5) and of its brand's newest generation ("GPT-5.6 Terra" loses to
 * the GPT-6 lines), up to SHORT_MAX in the CLI's own order. A list from
 * many providers that is still too long shows only `keep` (the model in
 * use, the recent ones): it is for searching. `rest` puts what would have shown first, then
 * older models, then devin's fusion pairs, each under its own heading.
 * Two ids for one model ("claude-opus-4-5" and its dated copy) show once.
 */
export function shelve(ids: string[], labels: Record<string, string>, keep: string[]) {
  const lines = new Map(ids.map((id) => [id, lineOf(id, labels)]));
  const best = new Map<string, number[]>();
  const major = new Map<string, number>();
  for (const { key, version } of lines.values()) {
    const top = best.get(key);
    if (!top || newer(version, top)) best.set(key, version);
    const brand = key.split('#')[0];
    if (version.length) major.set(brand, Math.max(major.get(brand) ?? 0, version[0]));
  }
  const seen = new Map<string, string>();
  for (const id of ids) {
    const { key, version } = lines.get(id)!;
    const same = `${key}@${version.join('.')}`;
    const first = seen.get(same);
    if (!first || /-\d{8}$/.test(first) && !/-\d{8}$/.test(id)) seen.set(same, id);
  }
  const twin = (id: string) => { const { key, version } = lines.get(id)!; return seen.get(`${key}@${version.join('.')}`) !== id; };
  const shelf = new Map(ids.map((id) => {
    const { key, version } = lines.get(id)!;
    if (/^fusion\b/i.test(labels[id] ?? id)) return [id, 'fusion pairs'];
    const old = newer(best.get(key)!, version) || (version.length > 0 && version[0] < major.get(key.split('#')[0])!);
    return [id, old ? 'older' : 'newest'];
  }));
  let main = ids.filter((id) => shelf.get(id) === 'newest');
  if (main.length > SHORT_MAX) main = new Set(ids.map(providerOf)).size > 1 ? [] : main.slice(0, SHORT_MAX);
  for (const id of keep) if (id && ids.includes(id) && !main.includes(id)) main.push(id);
  main = ids.filter((id) => main.includes(id));
  const rest = ['newest', 'older', 'fusion pairs'].flatMap((name) => ids.filter((id) => shelf.get(id) === name && !main.includes(id) && !twin(id)));
  return { main, rest, shelf: (id: string) => shelf.get(id)! };
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
      // "Opus 5.5 High Fast" and "Fusion (... + SWE-2 Medium)" lose their tier.
      ? label.replace(/\s+(fast|priority|lightning)(\)?)$/i, '$2')
        .replace(/\s+(no|none|minimal|low|medium|high|xhigh|max)(\s+thinking)?(\)?)$/i, '$3').trim()
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
    // Asked for a speed: any level at it. Otherwise: this level at any speed.
    ?? list.find((v) => want.speed !== undefined ? v.speed === speed : v.effort === effort)
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
