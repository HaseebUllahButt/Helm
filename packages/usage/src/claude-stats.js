import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bucketKey, splitKey } from './scan-cache.js';

/**
 * Usage for days whose Claude transcripts are gone.
 *
 * Claude Code deletes transcripts after 30 days, but keeps its own daily
 * totals in `stats-cache.json` back to the first session. Those totals add
 * every transcript line's usage, and a message spans several lines, so they
 * run about twice what the transcripts really cost. Days that still have
 * transcripts give the true scale per model; the deleted days are the daily
 * total times that scale, split into token kinds by the model's lifetime mix.
 *
 * The estimates sit in their own folder so the screen can say what they are.
 * Each carries Claude's own figure for that day (`claudeDaily`): a Claude
 * folder copied to another machine brings the same file, and the app counts
 * a day with the same model and figure once across machines.
 */
export const ESTIMATED_FOLDER = 'Estimated from Claude Code daily totals';

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const modelId = (raw) => String(raw).replace(/-\d{8}$/, '');

/**
 * Claude's daily totals per account home, kept in the usage index. A day's
 * total only grows, so the larger figure wins: a stats file that Claude
 * rebuilds from what transcripts are left must not shrink what was read.
 */
export class ClaudeStatsMemory {
  constructor() {
    this.id = 'claude-stats';
    /** home -> { days: { day: { model: tokens } }, mix: { model: { input, output, cacheRead, cacheWrite } } } */
    this.homes = new Map();
  }

  async read(home) {
    let data;
    try { data = JSON.parse(await readFile(join(home, 'stats-cache.json'), 'utf8')); } catch { return this.homes.get(home) ?? null; }
    const kept = this.homes.get(home) ?? { days: {}, mix: {} };
    for (const entry of Array.isArray(data?.dailyModelTokens) ? data.dailyModelTokens : []) {
      if (typeof entry?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
      const fresh = {};
      for (const [raw, n] of Object.entries(entry.tokensByModel ?? {})) {
        if (Number(n) > 0) fresh[modelId(raw)] = (fresh[modelId(raw)] ?? 0) + Number(n);
      }
      const day = kept.days[entry.date] ??= {};
      for (const [model, n] of Object.entries(fresh)) day[model] = Math.max(day[model] ?? 0, n);
    }
    for (const [raw, u] of Object.entries(data?.modelUsage ?? {})) {
      const mix = {
        input: Number(u?.inputTokens) || 0, output: Number(u?.outputTokens) || 0,
        cacheRead: Number(u?.cacheReadInputTokens) || 0, cacheWrite: Number(u?.cacheCreationInputTokens) || 0,
      };
      const sum = (m) => KINDS.reduce((n, k) => n + (m?.[k] || 0), 0);
      if (sum(mix) > sum(kept.mix[modelId(raw)])) kept.mix[modelId(raw)] = mix;
    }
    this.homes.set(home, kept);
    return kept;
  }

  toJSON() {
    return { id: this.id, entries: Object.fromEntries(this.homes) };
  }

  loadJSON(data) {
    if (!data || data.id !== this.id || !data.entries) return false;
    this.homes.clear();
    for (const [home, v] of Object.entries(data.entries)) {
      if (v && typeof v.days === 'object' && typeof v.mix === 'object') this.homes.set(home, v);
    }
    return true;
  }
}

/**
 * Buckets for the days the transcripts no longer cover.
 *
 * A day is filled only when the transcripts hold less than half its scaled
 * total: day edges and day-to-day noise must not add a little to every day
 * that is already whole. A part-deleted day gets only its missing share.
 */
export function estimateMissing(buckets, stats) {
  const out = new Map();
  if (!stats) return out;
  const have = new Map();
  let turns = 0;
  let tokens = 0;
  for (const [key, b] of buckets) {
    const { date, model } = splitKey(key);
    const k = `${date.slice(0, 10)}|${model}`;
    have.set(k, (have.get(k) ?? 0) + (b.total || 0));
    turns += b.turns || 0;
    tokens += b.total || 0;
  }

  // The scale: what the transcripts hold over what Claude added up, on days
  // both cover in full. A ratio far outside the usual ~0.4-0.55 is a partial
  // day or a moved file, not a measurement.
  const perModel = new Map();
  let allHave = 0;
  let allStats = 0;
  for (const [day, models] of Object.entries(stats.days)) {
    for (const [model, s] of Object.entries(models)) {
      const h = have.get(`${day}|${model}`) ?? 0;
      if (!s || h / s < 0.3 || h / s > 1) continue;
      const x = perModel.get(model) ?? { h: 0, s: 0, days: 0 };
      x.h += h; x.s += s; x.days++;
      perModel.set(model, x);
      allHave += h; allStats += s;
    }
  }
  // No day in common means no scale, and no proof the file is this
  // machine's: a folder copied from another machine has history from before
  // this one ran Claude at all.
  if (!allStats) return out;
  const overall = allHave / allStats;
  const scaleOf = (model) => {
    const x = perModel.get(model);
    return x && x.days >= 3 ? x.h / x.s : overall;
  };

  const allMix = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const mix of Object.values(stats.mix)) for (const k of KINDS) allMix[k] += mix[k] || 0;
  const turnRate = tokens ? turns / tokens : 0;

  for (const [day, models] of Object.entries(stats.days)) {
    for (const [model, s] of Object.entries(models)) {
      const expected = s * scaleOf(model);
      const h = have.get(`${day}|${model}`) ?? 0;
      if (h >= expected / 2) continue;
      const missing = expected - h;
      const mix = stats.mix[model] && KINDS.some((k) => stats.mix[model][k]) ? stats.mix[model] : allMix;
      const mixSum = KINDS.reduce((n, k) => n + (mix[k] || 0), 0);
      if (!mixSum) continue;
      const b = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, turns: 0 };
      for (const k of KINDS) b[k] = Math.round((missing * (mix[k] || 0)) / mixSum);
      b.total = KINDS.reduce((n, k) => n + b[k], 0);
      b.turns = Math.round(missing * turnRate);
      b.claudeDaily = s;
      if (b.total) out.set(bucketKey({ date: day, model, project: ESTIMATED_FOLDER }), b);
    }
  }
  return out;
}
