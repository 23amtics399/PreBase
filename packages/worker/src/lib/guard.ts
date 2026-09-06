import type { RetrievalResult } from './retrieval';

/**
 * Relevance guard for FTS5 BM25 results.
 *
 * BM25 scores returned by SQLite FTS5 are negative floats where:
 *   - More negative  = stronger match  (e.g., -3.5 is a very good hit)
 *   - Less negative  = weaker match    (e.g., -0.1 is barely relevant)
 *   - Zero / positive = should not occur in practice
 *
 * We reject chunks whose score is above (less negative than) the configured
 * threshold. For example, with minScore = -0.5:
 *   - score = -2.0 → passes  (-2.0 <= -0.5)
 *   - score = -0.1 → rejected (-0.1 > -0.5)
 *
 * The threshold value (-0.5) is an empirically chosen starting point based
 * on benchmark observations. It is intentionally configurable via
 * PREBASE_MIN_BM25_SCORE so it can be tuned without code changes.
 *
 * If all returned chunks are below the threshold, the caller must serve
 * the deterministic no-context fallback WITHOUT calling the AI.
 */
export function filterByRelevance(
  chunks: RetrievalResult[],
  minScore: number
): RetrievalResult[] {
  // More-negative scores are stronger. We keep chunks where score <= minScore,
  // meaning they are at least as strong as the threshold.
  return chunks.filter(c => c.score <= minScore);
}
