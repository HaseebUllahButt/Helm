/**
 * What a token costs, per model, on the day it was spent.
 *
 * Rates are published per million tokens and change - Sonnet 5 had
 * introductory pricing until 2026-09-01, Codex re-cut its card on 2026-07-30 -
 * so every lookup takes the date the tokens were actually spent rather than
 * today's. That is the whole reason the scanners cache raw token counts and
 * price them at read time: a rate corrected here reaches history that will
 * never be touched again.
 *
 * A model with no entry is reported `unpriced` rather than costed at zero. A
 * missing rate should look missing.
 *
 * Extracted from BroMyLimits (the cc-usage-dashboard), which is where these
 * tables are maintained and checked against the published cards.
 */

// (checked 2026-09-24), $ per million tokens. cacheWrite is the 5-minute
// rate (1.25x input); a 1-hour write bills at 2x input, and the transcripts
// say which it was (`cacheWrite1h`), so claudeModelCost prices the two apart.
export const CLAUDE_PRICING = {
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  // Fable 5.1 re-cut cache reads to $0.25. Whether Mythos 5.1 shares it was
  // left open at launch, so it keeps the tier's standard 0.1x until it says.
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-mythos-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  // Sonnet 5 has time-boxed introductory pricing (through 2026-08-31), resolved in claudeRatesFor().
};

export const SONNET_5_INTRO_ENDS_UTC = '2026-09-01T00:00:00Z';
export const SONNET_5_INTRO = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
export const SONNET_5_STANDARD = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

// Model names in ccusage's JSON sometimes carry a dated suffix
// (claude-haiku-4-5-20251001) — strip it to match the rate table above.
const isClaudeModel = (m) => /^claude-/.test(String(m || '')) && !!claudeRatesFor(String(m), new Date().toISOString());

export function normalizeClaudeModel(modelName) {
  return modelName.replace(/-\d{8}$/, '');
}

export function claudeRatesFor(modelName, asOfDate) {
  const base = normalizeClaudeModel(modelName);
  if (base === 'claude-sonnet-5') {
    return new Date(asOfDate) < new Date(SONNET_5_INTRO_ENDS_UTC) ? SONNET_5_INTRO : SONNET_5_STANDARD;
  }
  return CLAUDE_PRICING[base] || null;
}

export function claudeModelCost(modelName, tokens, asOfDate) {
  const rates = claudeRatesFor(modelName, asOfDate);
  const { inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheCreation1hTokens = 0, cacheReadTokens = 0 } = tokens;
  if (!rates) return null;
  const hour = Math.min(cacheCreation1hTokens, cacheCreationTokens);
  return {
    input: (inputTokens * rates.input) / 1_000_000,
    output: (outputTokens * rates.output) / 1_000_000,
    cacheWrite: ((cacheCreationTokens - hour) * rates.cacheWrite + hour * rates.input * 2) / 1_000_000,
    cacheRead: (cacheReadTokens * rates.cacheRead) / 1_000_000,
  };
}

export const CODEX_PRICING = {
  // input / cachedInput / output, $ per million tokens (standard, short context)
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5-pro': { input: 30, cachedInput: 30, output: 180 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': { input: 30, cachedInput: 30, output: 180 },
};

export const CODEX_CUTOVER_MS = Date.parse('2026-07-30T00:00:00Z');
export const CODEX_PRICING_PRE_CUT = {
  'gpt-5.6-luna': { input: 1.0, cachedInput: 0.1, output: 6 },
  'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, output: 15 },
};

export const ANTIGRAVITY_PRICING = {
  'gemini-3.7-flash': { input: 0.75, cachedInput: 0.1875, output: 3.75 },
  'gemini-3.6-flash': { input: 0.5, cachedInput: 0.125, output: 3.0 },
  'gemini-3.5-flash': { input: 0.5, cachedInput: 0.125, output: 3.0 },
  'gemini-3.1-pro': { input: 1.25, cachedInput: 0.3125, output: 5.0 },
  'claude-opus-4-6': { input: 15.0, cachedInput: 1.875, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, cachedInput: 0.375, output: 15.0 },
  'gpt-oss-120b': { input: 1.0, cachedInput: 0.1, output: 6.0 },
};

export function normalizeAntigravityModelName(modelName) {
  const name = String(modelName || 'unknown').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (/^gemini-3\.7-flash(?:-exp)?(?:-agent)?(?:-a)?$/.test(name)) return 'gemini-3.7-flash';
  if (/^gemini-3\.6-flash(?:-tiered)?$/.test(name)) return 'gemini-3.6-flash';
  if (/^gemini-3\.5-flash(?:-extra-low|-low)?$/.test(name)) return 'gemini-3.5-flash';
  if (/^gemini-3\.1-pro(?:-low)?$/.test(name)) return 'gemini-3.1-pro';
  if (/^claude-(?:opus|sonnet)-4-6-thinking$/.test(name)) return name.replace(/-thinking$/, '');
  if (name === 'gpt-oss-120b-medium') return 'gpt-oss-120b';
  return name;
}

export function antigravityModelCost(modelName, u) {
  const base = normalizeAntigravityModelName(modelName);
  const r = ANTIGRAVITY_PRICING[base] || { input: 0.75, cachedInput: 0.1875, output: 3.75 };
  return {
    input: ((u.input || 0) * r.input) / 1_000_000,
    output: ((u.output || 0) * r.output) / 1_000_000,
    cacheWrite: 0,
    cacheRead: ((u.cacheRead || 0) * r.cachedInput) / 1_000_000,
  };
}

// Antigravity CLI stores response usage in protobuf blobs inside one SQLite
// database per conversation. These helpers decode only the documented fields
// needed for usage; message content is never loaded or exposed.

export function providerOf(modelName) {
  if (/^claude-/.test(modelName)) return 'Anthropic';
  if (/^gpt-/.test(modelName)) return 'OpenAI';
  if (/^grok-/.test(modelName)) return 'xAI';
  if (/^gemini-/.test(modelName)) return 'Google';
  return 'Google';
}

export function blankBreakdown(modelName, provider) {
  return {
    modelName,
    provider,
    unpriced: false,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
  };
}

// Granular breakdown: real tokens x real published per-category rate for
// every model, not just a lump total. Computed entirely from our own rate
// tables rather than ccusage's own cost field, so every model missing a
// rate is flagged instead of silently reading $0.

/**
 * Per-million rates as {input, cacheRead, cacheWrite} for one model, or null.
 *
 * One resolver over every provider's table, so the prompt-cache arithmetic is
 * written once. OpenCode reports a billed total rather than per-channel rates
 * and Grok reports only a tick cost, so both are left null: their tokens count
 * and their saving is not claimed.
 */
export function cacheRatesFor(modelName, engine, asOfDate) {
  const flat = (r) => (r ? { input: r.input, cacheRead: r.cachedInput, cacheWrite: r.input } : null);
  switch (isClaudeModel(modelName) ? 'claude' : engine) {
    case 'claude': {
      const r = claudeRatesFor(modelName, asOfDate ?? new Date().toISOString().slice(0, 10));
      return r ? { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite } : null;
    }
    case 'codex': {
      // The cutover is not decoration: Codex re-cut its card on 2026-07-30,
      // and this used to answer with today's rate whatever date it was given.
      // priceBucket honoured it and this did not, so cache savings on tokens
      // spent before the cut were understated fivefold on gpt-5.6-luna.
      const key = String(modelName || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
      const ms = asOfDate ? Date.parse(asOfDate) : NaN;
      const pre = Number.isFinite(ms) && ms < CODEX_CUTOVER_MS && CODEX_PRICING_PRE_CUT[key];
      return flat(pre || CODEX_PRICING[key]);
    }
    case 'antigravity':
      return flat(ANTIGRAVITY_PRICING[normalizeAntigravityModelName(modelName)]);
    default:
      return null;
  }
}

/** Cost of one (date, model) bucket of raw token counts, or null if unpriced. */
export function priceBucket(engine, modelName, tokens, date) {
  // A Claude model is priced as one whichever CLI ran it: Devin and OpenCode
  // can drive Claude too, and the OpenAI-shaped table below has no entry for
  // it - those buckets used to come out unpriced.
  if (engine === 'claude' || isClaudeModel(modelName)) {
    const c = claudeModelCost(modelName, {
      inputTokens: tokens.input || 0,
      outputTokens: tokens.output || 0,
      cacheCreationTokens: tokens.cacheWrite || 0,
      cacheCreation1hTokens: tokens.cacheWrite1h || 0,
      cacheReadTokens: tokens.cacheRead || 0,
    }, date);
    return c ? { ...c, total: c.input + c.output + c.cacheWrite + c.cacheRead } : null;
  }
  // Codex and the OpenAI-rate engines: the bucket already holds fresh input
  // separately from cached, so this prices it directly.
  const key = String(modelName || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const ms = date ? Date.parse(date) : NaN;
  const rates = (Number.isFinite(ms) && ms < CODEX_CUTOVER_MS && CODEX_PRICING_PRE_CUT[key])
    ? CODEX_PRICING_PRE_CUT[key]
    : CODEX_PRICING[key];
  if (!rates) return null;
  const input = ((tokens.input || 0) * rates.input) / 1e6;
  const cacheRead = ((tokens.cacheRead || 0) * rates.cachedInput) / 1e6;
  const output = ((tokens.output || 0) * rates.output) / 1e6;
  return { input, output, cacheWrite: 0, cacheRead, total: input + output + cacheRead };
}
