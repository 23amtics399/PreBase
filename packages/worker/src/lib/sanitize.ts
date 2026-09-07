/**
 * FTS5 query sanitizer — v2
 *
 * Converts a raw user message into a safe FTS5 MATCH expression,
 * or returns null if no meaningful search terms can be extracted.
 *
 * Strategy (improved over v1):
 *   1. Strip everything that is not a word character (\w) or whitespace.
 *   2. Split into tokens on whitespace.
 *   3. Discard tokens shorter than MIN_TOKEN_LEN (reduces noise).
 *   4. Discard FTS5 boolean operator keywords (OR, AND, NOT, NEAR).
 *   5. Remove English stop words that add noise without discriminating content.
 *   6. If content tokens remain, return AND-joined query (precise).
 *   7. If AND yields no content tokens, fall back to OR-joined query (broad).
 *   8. If no tokens remain at all, return null (caller must use fallback).
 *
 * Why AND-first?
 *   With a small corpus (typical per-bot KB has 5–30 chunks) BM25 inflates
 *   scores for any token hit. An OR query on "How OR often OR must OR
 *   passwords OR be OR changed" can return chunks that only matched "must"
 *   (a stop word), producing low BM25 scores that slip past the relevance
 *   guard. AND constrains all content words to appear together, raising BM25
 *   scores for genuine matches and returning nothing for non-matches, which
 *   is strictly better than a weak false positive.
 *
 * Why stop-word removal?
 *   FTS5's unicode61 tokenizer has no built-in stop list. Without removal,
 *   common words ("how", "is", "the", "do") dilute BM25 scores and can
 *   cause unrelated chunks to score above the relevance threshold just
 *   because they contain a frequently-occurring term.
 *
 * Exported API (unchanged from v1):
 *   sanitizeFtsQuery(raw) → string | null
 *     Returns the best FTS5 query string or null.
 *
 * The internal AND-vs-OR choice is an implementation detail invisible to
 * callers; the RetrievalEngine interface is unchanged.
 */

/** Minimum token length kept after stripping. Filters single-char noise. */
const MIN_TOKEN_LEN = 2;

/** FTS5 reserved operator keywords — must not appear as literal search terms. */
const FTS5_OPERATORS = new Set(['OR', 'AND', 'NOT', 'NEAR']);

/**
 * High-frequency English words that carry no discriminating power in a
 * keyword search over short knowledge-base chunks.
 *
 * Curated to avoid removing words that CAN be meaningful in a KB context,
 * e.g. "not" is an FTS5 operator anyway; "free" is kept (could be KB term).
 *
 * All lowercase — comparison is done case-insensitively.
 */
const STOP_WORDS = new Set([
  // articles & determiners
  'a', 'an', 'the',
  // conjunctions
  'and', 'but', 'or', 'nor', 'so', 'yet', 'for',
  // prepositions (short ones that rarely appear in KB headings/answers)
  'in', 'on', 'at', 'to', 'of', 'by', 'up', 'as',
  // pronouns
  'i', 'you', 'he', 'she', 'we', 'they', 'it', 'its',
  'my', 'your', 'our', 'their', 'me', 'him', 'her', 'us', 'them',
  'this', 'that', 'these', 'those',
  'who', 'which', 'what', 'where', 'when', 'why', 'how',
  // common auxiliary verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had',
  'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can', 'could',
  // common filler words
  'also', 'just', 'very', 'much', 'many', 'more', 'most', 'some', 'any',
  'each', 'other', 'such', 'than', 'then', 'there',
  'all', 'both', 'few', 'own', 'same', 'too', 'very',
  // contractions (after apostrophe is stripped: "it's" → "it" + "s")
  've', 're', 'll', 'd', 's',
  // short common verbs unlikely to appear as KB-specific terms
  'get', 'go', 'come', 'see', 'know', 'take', 'make', 'give', 'use',
  // question helpers (already covered by who/what/where/when/why/how above)
  // misc filler
  'if', 'else', 'like', 'about', 'into', 'from', 'with', 'out',
]);

/**
 * Sanitizes a raw query string for safe use as an FTS5 MATCH expression.
 *
 * Returns a safe FTS5 query string (AND-joined content words, or OR-joined
 * if stop-word removal leaves nothing), or null if no usable tokens remain.
 *
 * @example
 * sanitizeFtsQuery("How often must passwords be changed?")
 *   // → "often AND passwords AND changed"
 *   // (stop words "How", "must", "be" removed; AND-joined for precision)
 *
 * sanitizeFtsQuery("Do you deliver overseas?")
 *   // → "deliver AND overseas"
 *
 * sanitizeFtsQuery("What is your return policy?")
 *   // → "return AND policy"
 *
 * sanitizeFtsQuery("OR AND NOT")
 *   // → null
 *
 * sanitizeFtsQuery("")
 *   // → null
 */
export function sanitizeFtsQuery(raw: string): string | null {
  if (typeof raw !== 'string') return null;

  // Step 1: replace non-word, non-space characters with a space.
  // Strips: punctuation, quotes, apostrophes, parens, *, @, #, etc.
  const cleaned = raw.replace(/[^\w\s]/g, ' ');

  // Step 2: split on whitespace, apply basic filters
  const allTokens = cleaned
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= MIN_TOKEN_LEN)
    .filter(t => !FTS5_OPERATORS.has(t.toUpperCase()))
    .filter(t => /[a-zA-Z0-9]/.test(t)); // must have at least one alphanumeric char

  if (allTokens.length === 0) return null;

  // Step 3: remove stop words to get content-bearing tokens
  const contentTokens = allTokens.filter(t => !STOP_WORDS.has(t.toLowerCase()));

  if (contentTokens.length > 0) {
    // Preferred: AND-join content tokens → precise match, high BM25 for genuine hits
    return contentTokens.join(' AND ');
  }

  // Fallback: stop-word removal left nothing (e.g. pure stop-word query like
  // "how are you") — use OR on the original token set so we at least search.
  return allTokens.join(' OR ');
}
