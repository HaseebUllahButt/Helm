/**
 * How helm says numbers. Money and duration appear per turn, per thread and
 * in the session list, and they have to agree everywhere: a turn that reads
 * `$0.02` must not roll up into a thread that reads `0.0243`.
 */

export const seconds = (ms?: number) =>
  (ms == null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

/** Sub-cent work is real work; it just is not a number worth printing. */
export const money = (usd?: number | null) =>
  (usd == null || usd <= 0 ? '' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** A file size for a person, e.g. media listings. */
export const bytes = (n?: number | null) =>
  (n == null ? ''
    : n < 1024 ? `${n} B`
    : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB`
    : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB`
    : `${(n / 1024 ** 3).toFixed(1)} GB`);
