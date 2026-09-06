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

export class FTS5Engine implements RetrievalEngine {
  async search(
    db: D1Database,
    botId: string,
    query: string,
    charBudget: number
  ): Promise<RetrievalResult[]> {
    // Sanitize the raw query into a safe FTS5 MATCH expression.
    // Returns null if no meaningful terms remain — do not query FTS5.
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }

    // FTS5 BM25 full-text search scoped strictly to the requested bot.
    // bm25() returns negative values; more negative = stronger match.
    // We retrieve the top 10 candidates; the caller applies the relevance guard.
    //
    // IMPORTANT: Every query includes `AND kb_fts.bot_id = ?` so that knowledge
    // from other bots is never accessible, even if retrieved globally.
    const stmt = db
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
      .bind(ftsQuery, botId);

    const { results } = await stmt.all<{
      content: string;
      chunkIndex: number;
      sourceFilename: string;
      score: number;
    }>();

    if (!results || results.length === 0) {
      return [];
    }

    // Apply character budget: accumulate chunks until the budget is exhausted.
    let usedChars = 0;
    const selected: RetrievalResult[] = [];

    for (const row of results) {
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
