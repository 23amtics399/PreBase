import type { D1Database } from '@cloudflare/workers-types';
import { sanitizeFtsQuery } from './sanitize';

export interface RetrievalResult {
  content: string;
  score: number;
  sourceFilename: string;
  chunkIndex: number;
}

export interface RetrievalEngine {
  search(
    db: D1Database,
    botId: string,
    query: string,
    charBudget: number
  ): Promise<RetrievalResult[]>;
}

/**
 * Executes a single FTS5 MATCH query and returns raw DB rows.
 * Scoped strictly to the given botId so knowledge never leaks cross-bot.
 */
async function runFts5Query(
  db: D1Database,
  ftsQuery: string,
  botId: string
): Promise<Array<{ content: string; chunkIndex: number; sourceFilename: string; score: number }>> {
  const { results } = await db
    .prepare(
      `SELECT
         kc.content,
         kc.chunk_index  AS chunkIndex,
         ks.filename     AS sourceFilename,
         bm25(kb_fts)    AS score
       FROM kb_fts
       JOIN kb_chunks  kc ON kc.id = kb_fts.rowid
       JOIN kb_sources ks ON ks.id = kc.source_id
       WHERE kb_fts MATCH ?
         AND kb_fts.bot_id = ?
       ORDER BY score ASC
       LIMIT 10`
    )
    .bind(ftsQuery, botId)
    .all<{ content: string; chunkIndex: number; sourceFilename: string; score: number }>();

  return results ?? [];
}

export class FTS5Engine implements RetrievalEngine {
  async search(
    db: D1Database,
    botId: string,
    query: string,
    charBudget: number
  ): Promise<RetrievalResult[]> {
    // Sanitize the raw query into a safe FTS5 MATCH expression.
    // sanitizeFtsQuery returns an AND-joined content-word query by default,
    // falling back to OR-joined if stop-word removal leaves nothing.
    // Returns null if no meaningful terms remain.
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }

    // --- Primary pass: use the sanitized query as-is (AND-joined preferred) ---
    let rows = await runFts5Query(db, ftsQuery, botId);

    // --- Fallback pass: if AND returned nothing, try OR on the same tokens ---
    // This handles cases where the document uses only some of the query words.
    // Example: "often AND passwords AND changed" may fail if the chunk reads
    // "Passwords must be changed every 90 days" (missing "often").
    if (rows.length === 0 && ftsQuery.includes(' AND ')) {
      const orFallback = ftsQuery.replace(/ AND /g, ' OR ');
      rows = await runFts5Query(db, orFallback, botId);
    }

    if (rows.length === 0) {
      return [];
    }

    // Apply character budget: accumulate top-scoring chunks until exhausted.
    let usedChars = 0;
    const selected: RetrievalResult[] = [];

    for (const row of rows) {
      if (usedChars + row.content.length > charBudget) {
        break;
      }
      selected.push({
        content: row.content,
        score: row.score,
        sourceFilename: row.sourceFilename,
        chunkIndex: row.chunkIndex,
      });
      usedChars += row.content.length;
    }

    return selected;
  }
}
