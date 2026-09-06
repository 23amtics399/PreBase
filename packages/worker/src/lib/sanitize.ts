/**
 * FTS5 query sanitizer.
 *
 * Converts a raw user message string into a safe FTS5 MATCH expression,
 * or returns null if no meaningful search terms can be extracted.
 *
 * The raw string must NEVER be used directly as an FTS5 MATCH expression.
 * FTS5 treats unquoted keywords like OR, AND, NOT, NEAR as operators; user
 * input containing these (or quotes, parens, *) would cause a syntax error
 * or unintended query semantics.
 *
 * Strategy:
 *   1. Strip everything that is not a word character (\w) or whitespace.
 *   2. Split into tokens on whitespace.
 *   3. Discard tokens shorter than MIN_TOKEN_LEN (reduces noise).
 *   4. Discard FTS5 boolean operator keywords.
 *   5. Join with " OR " so partial matches are broadened across chunks.
 *   6. Return null if no usable tokens remain (caller must use fallback).
 */

/** Minimum token length kept after stripping. Filters single-char noise. */
const MIN_TOKEN_LEN = 2;

/** FTS5 reserved operator keywords — must not appear as literal search terms. */
const FTS5_OPERATORS = new Set(['OR', 'AND', 'NOT', 'NEAR']);

/**
 * Sanitizes a raw query string for safe use in an FTS5 MATCH expression.
 *
 * @returns A safe " OR "-joined token string, or null if nothing remains.
 *
 * @example
 * sanitizeFtsQuery("What is your return policy?") // "What OR is OR your OR return OR policy"
 * sanitizeFtsQuery("OR AND NOT")                   // null
 * sanitizeFtsQuery("")                              // null
 * sanitizeFtsQuery("!@#$")                          // null
 * sanitizeFtsQuery("hello! (world)")               // "hello OR world"
 */
export function sanitizeFtsQuery(raw: string): string | null {
  if (typeof raw !== 'string') return null;

  // Step 1: replace non-word, non-space characters with a space
  // This strips: punctuation, quotes ('"'), apostrophes, parens, *, @, #, etc.
  const cleaned = raw.replace(/[^\w\s]/g, ' ');

  // Step 2: split on whitespace, filter short tokens and FTS5 operators
  const tokens = cleaned
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= MIN_TOKEN_LEN)
    .filter(t => !FTS5_OPERATORS.has(t.toUpperCase()))
    // Must contain at least one letter or digit (rejects lone underscores)
    .filter(t => /[a-zA-Z0-9]/.test(t));

  if (tokens.length === 0) return null;

  return tokens.join(' OR ');
}
