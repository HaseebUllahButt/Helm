import { nativeFunction } from './log-index-native.js';

// Rust finds saved Codex and Claude records that a reader would ignore, so
// JavaScript decodes and parses only the rest. Without the native reader,
// every line goes to JavaScript as before.
const select = nativeFunction('transcriptLines');

// The codes match Rule in native/log-index/src/transcript.rs.
export const RULES = Object.freeze({
  codexMessages: 0, claudeMessages: 1, claudeSidechain: 2,
  codexState: 3, claudeUsage: 4, codexActivity: 5,
});
export const transcriptReader = select ? 'rust' : 'javascript';

/**
 * Start and end byte pairs of the lines in `bytes` that must be parsed, or
 * null when Rust is missing. `splitCr` also ends lines at "\r", as readline.
 */
export function transcriptLines(bytes, rule, splitCr = false) {
  return select?.(bytes, rule, splitCr) ?? null;
}
