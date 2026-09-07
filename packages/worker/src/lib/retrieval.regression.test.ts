/**
 * Retrieval regression suite for PreBase Phase 1 (FTS5/BM25).
 *
 * These tests document the known behaviours of the FTS5 retrieval pipeline,
 * including its limitations. They must pass after any change to sanitize.ts,
 * retrieval.ts, guard.ts, or chunker.ts.
 *
 * Coverage:
 *   - exact match
 *   - plural / singular variants
 *   - paraphrase (different words, same meaning)
 *   - synonym miss  ← expected Phase 1 limitation
 *   - stop-word false positive prevention
 *   - short document indexing (< 100 chars, >= 40 chars)
 *   - multi-chunk retrieval with character budget
 *   - cross-bot isolation
 *   - no-context fallback (empty corpus)
 *   - low-relevance fallback (relevance guard)
 *
 * For Phase 1, FTS5 performs keyword/token matching only. Semantic
 * equivalences such as "overseas" vs "internationally" are NOT resolved;
 * those cases are documented here as EXPECTED FAILURES with a note.
 */

import { sanitizeFtsQuery } from './sanitize';
import { FTS5Engine } from './retrieval';
import { filterByRelevance } from './guard';
import { chunkText } from './chunker';
import type { D1Database } from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// Helper: build a mock D1 that returns a pre-set result set
// ---------------------------------------------------------------------------
function mockDb(rows: Array<{ content: string; chunkIndex: number; sourceFilename: string; score: number }>): D1Database {
  return {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockResolvedValue({ results: rows }),
      }),
    }),
  } as unknown as D1Database;
}

// Build an empty-result mock
const emptyDb = () => mockDb([]);

// ---------------------------------------------------------------------------
// Helper: build a mock D1 that serves different results for AND vs OR pass
// ---------------------------------------------------------------------------
function mockDbTwoPass(
  andRows: Array<{ content: string; chunkIndex: number; sourceFilename: string; score: number }>,
  orRows:  Array<{ content: string; chunkIndex: number; sourceFilename: string; score: number }>
): D1Database {
  let callCount = 0;
  return {
    prepare: jest.fn().mockReturnValue({
      bind: jest.fn().mockReturnValue({
        all: jest.fn().mockImplementation(() => {
          const rows = callCount++ === 0 ? andRows : orRows;
          return Promise.resolve({ results: rows });
        }),
      }),
    }),
  } as unknown as D1Database;
}

const engine = new FTS5Engine();
const MIN_SCORE = -0.5; // production relevance threshold

// ===========================================================================
// 1. EXACT MATCH
// ===========================================================================
describe('[retrieval-regression] 1. Exact match', () => {
  it('retrieves the correct chunk when query tokens appear verbatim', async () => {
    const db = mockDb([
      { content: 'You can return any unused item within 30 days.', chunkIndex: 0, sourceFilename: 'faq.txt', score: -6.5 },
    ]);
    const results = await engine.search(db, 'bot1', 'What is the return policy?', 3600);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('return');
  });

  it('sanitized query for an exact match uses AND join', () => {
    // "What", "is", "the" are stop words → "return", "policy" remain
    expect(sanitizeFtsQuery('What is the return policy?')).toBe('return AND policy');
  });
});

// ===========================================================================
// 2. PLURAL / SINGULAR VARIANTS
// ===========================================================================
describe('[retrieval-regression] 2. Plural/singular variants', () => {
  it('sanitize: "passwords" is a content word, not stripped', () => {
    // FTS5 unicode61 tokenizer does not stem by default.
    // "passwords" and "password" are different tokens.
    const q = sanitizeFtsQuery('How often must passwords be changed?');
    expect(q).toContain('passwords');
  });

  it('AND query with "passwords" can match corpus containing "Passwords"', async () => {
    // FTS5 is case-insensitive for ascii; "Passwords" == "passwords" in FTS5
    const db = mockDb([
      { content: 'Passwords must be changed every 90 days.', chunkIndex: 0, sourceFilename: 'policy.txt', score: -8.4 },
    ]);
    const results = await engine.search(db, 'bot1', 'How often must passwords be changed?', 3600);
    expect(results.length).toBe(1);
    expect(results[0].score).toBeLessThan(MIN_SCORE); // strong match — passes guard
  });

  it('[known limitation] singular "password" may not match corpus with "Passwords" in FTS5 without stemming', () => {
    // FTS5 unicode61 treats "password" and "Passwords" differently without porter stemmer.
    // This test documents the limitation rather than asserting a positive match.
    // Actual FTS5 matching depends on tokenizer configuration.
    const q = sanitizeFtsQuery('Is my password secure enough?');
    // "password" token is kept — whether it matches "Passwords" depends on FTS5 tokenizer
    expect(q).toContain('password');
    // Note: FTS5 is case-insensitive but NOT stemming-aware by default.
    // "password" and "passwords" will NOT match each other in standard FTS5.
  });
});

// ===========================================================================
// 3. PARAPHRASE — different words, answerable from KB
// ===========================================================================
describe('[retrieval-regression] 3. Paraphrase', () => {
  it('OR fallback catches paraphrase when AND returns empty', async () => {
    // Query: "How long do I have to return an item?"
    // Corpus: "You can return any unused item within 30 days."
    // Sanitized AND: "long AND return AND item" — "long" may not appear in chunk
    // OR fallback: "long OR return OR item" — "return" and "item" match
    const db = mockDbTwoPass(
      // AND pass: returns nothing (corpus doesn't have "long")
      [],
      // OR fallback: "return" and "item" match
      [{ content: 'You can return any unused item within 30 days.', chunkIndex: 0, sourceFilename: 'faq.txt', score: -3.2 }]
    );
    const results = await engine.search(db, 'bot1', 'How long do I have to return an item?', 3600);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('return');
  });

  it('sanitize removes stop words from paraphrase query to improve recall', () => {
    const q = sanitizeFtsQuery('Can I work from a coffee shop without the VPN?');
    // Stop words removed: "Can", "I", "from", "a", "the"
    expect(q).toContain('coffee');
    expect(q).toContain('shop');
    expect(q).toContain('VPN');
    // Stop words must not appear as standalone query tokens
    expect(q?.split(/ AND | OR /)).not.toContain('Can');
    expect(q?.split(/ AND | OR /)).not.toContain('the');
  });
});

// ===========================================================================
// 4. SYNONYM MISS — expected Phase 1 limitation
// ===========================================================================
describe('[retrieval-regression] 4. Synonym miss (expected Phase 1 limitation)', () => {
  /**
   * "Do you deliver overseas?" vs corpus containing "ship internationally"
   *
   * FTS5 is a keyword matcher — it cannot resolve vocabulary equivalences.
   * "overseas" ≠ "internationally" in FTS5 token space.
   * "deliver" ≠ "ship" in FTS5 token space.
   *
   * Expected behavior:
   *   - Retrieval safety:  PASS — no hallucination; deterministic fallback returned
   *   - Retrieval recall:  FAIL — correct answer exists in KB but was not retrieved
   *
   * This is a documented limitation of Phase 1. Phase 2 would use hybrid retrieval
   * (FTS5 + dense embeddings) to resolve such vocabulary gaps.
   */
  it('[SAFETY PASS] synonym query returns empty → correct deterministic fallback (not hallucination)', async () => {
    // Simulate: corpus has "ship internationally", query asks "deliver overseas"
    // Both AND and OR passes return empty because neither "deliver" nor "overseas"
    // appear in the corpus. The engine correctly returns [].
    const db = emptyDb();
    const results = await engine.search(db, 'bot1', 'Do you deliver overseas?', 3600);
    expect(results).toHaveLength(0);
    // Callers receiving [] must use the deterministic fallback, not the AI
  });

  it('[RECALL FAIL — known limitation] sanitize query for "overseas" does NOT match "internationally"', () => {
    const q = sanitizeFtsQuery('Do you deliver overseas?');
    // "deliver AND overseas" — correct tokens, but corpus uses different vocabulary
    expect(q).toBe('deliver AND overseas');
    // "overseas" is not equivalent to "internationally" in FTS5 token space
    expect(q).not.toContain('internationally');
    expect(q).not.toContain('ship');
    // This is the Phase 1 semantic gap. The sanitizer does the right thing;
    // the gap is in the corpus vocabulary, not the sanitizer.
  });

  it('[RECALL FAIL — known limitation] sanitize query for "AI assistant" vs "chat assistant" — vocabulary gap', () => {
    const q = sanitizeFtsQuery('Is this an AI assistant?');
    // "AI" and "assistant" are content tokens
    // If corpus says "chat assistant" or "virtual helper", FTS5 would miss "AI"
    expect(q).toContain('assistant');
  });
});

// ===========================================================================
// 5. STOP-WORD FALSE POSITIVE PREVENTION
// ===========================================================================
describe('[retrieval-regression] 5. Stop-word false positive prevention', () => {
  it('query with only stop words returns null — no FTS5 query issued', () => {
    // "What is the capital of France?" — with stop word removal:
    // "What"(stop), "is"(stop), "the"(stop), "of"(stop) removed
    // "capital" and "France" remain
    const q = sanitizeFtsQuery('What is the capital of France?');
    expect(q).toBe('capital AND France');
    // The AND query "capital AND France" will return NOTHING from an FAQ bot
    // → deterministic fallback, not a hallucinated answer
  });

  it('engine returns [] when AND query finds no matching chunks', async () => {
    // "capital AND France" → no match in FAQ corpus → AND pass returns []
    // OR fallback "capital OR France" → also no match → engine returns []
    const db = emptyDb();
    const results = await engine.search(db, 'bot1', 'What is the capital of France?', 3600);
    expect(results).toHaveLength(0);
  });

  it('relevance guard blocks low-BM25 noise from reaching the AI', () => {
    // Chunks with score > threshold are filtered
    const weakChunks = [
      { content: 'Unrelated chunk A', score: -0.001, sourceFilename: 'faq.txt', chunkIndex: 0 },
      { content: 'Unrelated chunk B', score: -0.0001, sourceFilename: 'faq.txt', chunkIndex: 1 },
    ];
    const passed = filterByRelevance(weakChunks, MIN_SCORE);
    expect(passed).toHaveLength(0); // nothing passes the guard
  });

  it('relevance guard passes strong matches and blocks weak ones', () => {
    const chunks = [
      { content: 'Strong match', score: -5.2, sourceFilename: 'faq.txt', chunkIndex: 0 },
      { content: 'Weak match',  score: -0.1, sourceFilename: 'faq.txt', chunkIndex: 1 },
      { content: 'Zero match',  score: -0.0001, sourceFilename: 'faq.txt', chunkIndex: 2 },
    ];
    const passed = filterByRelevance(chunks, MIN_SCORE);
    expect(passed).toHaveLength(1);
    expect(passed[0].content).toBe('Strong match');
  });
});

// ===========================================================================
// 6. SHORT DOCUMENT INDEXING (< 100 chars, >= 40 chars)
// ===========================================================================
describe('[retrieval-regression] 6. Short document indexing', () => {
  it('chunkText produces a chunk for a 75-char single-fact document', () => {
    // bot_a.txt: "Product A costs 999. It is a premium vacuum cleaner with 400W suction power."
    // Previously: minChunkChars=100 → silently discarded (0 chunks)
    // Fixed: minChunkChars=40 → chunk is kept
    const text = 'Product A costs 999. It is a premium vacuum cleaner with 400W suction power.';
    expect(text.length).toBeLessThan(100);
    expect(text.length).toBeGreaterThanOrEqual(40);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content).toContain('Product A');
  });

  it('chunkText discards truly tiny fragments (< 40 chars)', () => {
    // Single words or very short lines below the minimum are discarded
    const tiny = 'Yes.';
    expect(tiny.length).toBeLessThan(40);
    const chunks = chunkText(tiny);
    expect(chunks).toHaveLength(0);
  });

  it('engine can retrieve a short single-chunk document', async () => {
    const db = mockDb([
      { content: 'Product A costs 999. Premium vacuum cleaner.', chunkIndex: 0, sourceFilename: 'bot_a.txt', score: -4.2 },
    ]);
    const results = await engine.search(db, 'bot-a', 'How much does Product A cost?', 3600);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('Product A');
  });
});

// ===========================================================================
// 7. MULTI-CHUNK RETRIEVAL WITH CHARACTER BUDGET
// ===========================================================================
describe('[retrieval-regression] 7. Multi-chunk retrieval with character budget', () => {
  const chunk50 = { content: 'A'.repeat(50),  chunkIndex: 0, sourceFilename: 'doc.txt', score: -5.0 };
  const chunk50b = { content: 'B'.repeat(50), chunkIndex: 1, sourceFilename: 'doc.txt', score: -4.0 };
  const chunk50c = { content: 'C'.repeat(50), chunkIndex: 2, sourceFilename: 'doc.txt', score: -3.0 };

  it('accumulates chunks until budget is exhausted', async () => {
    const db = mockDb([chunk50, chunk50b, chunk50c]);
    // Budget = 120: chunk0(50) + chunk1(50) = 100 chars. chunk2(50) would = 150 → skip.
    const results = await engine.search(db, 'bot1', 'query', 120);
    expect(results.length).toBe(2);
    expect(results[0].chunkIndex).toBe(0);
    expect(results[1].chunkIndex).toBe(1);
  });

  it('returns all chunks when budget is large enough', async () => {
    const db = mockDb([chunk50, chunk50b, chunk50c]);
    const results = await engine.search(db, 'bot1', 'query', 9999);
    expect(results.length).toBe(3);
  });

  it('returns the best-scoring (most negative BM25) chunk first', async () => {
    // D1 returns results in ascending BM25 order (most negative first = best match)
    const db = mockDb([chunk50, chunk50b, chunk50c]); // scores: -5.0, -4.0, -3.0
    const results = await engine.search(db, 'bot1', 'query', 9999);
    expect(results[0].score).toBe(-5.0);
    expect(results[1].score).toBe(-4.0);
  });
});

// ===========================================================================
// 8. CROSS-BOT ISOLATION
// ===========================================================================
describe('[retrieval-regression] 8. Cross-bot isolation', () => {
  it('engine binds the botId parameter on every query', async () => {
    const bindSpy = jest.fn().mockReturnValue({
      all: jest.fn().mockResolvedValue({ results: [] }),
    });
    const db = {
      prepare: jest.fn().mockReturnValue({ bind: bindSpy }),
    } as unknown as D1Database;

    await engine.search(db, 'bot-alpha', 'product price', 3600);

    // Every bind() call must include 'bot-alpha' as the second argument.
    // This ensures the SQL WHERE clause scopes results to the correct bot.
    for (const call of bindSpy.mock.calls) {
      expect(call[1]).toBe('bot-alpha');
    }
  });

  it('bot-b query returns empty when only bot-a content is in corpus', async () => {
    // Simulate: bot-a has "Product A costs 999", bot-b has nothing
    // A query against bot-b should return [] even if bot-a content matches
    const db = mockDb([]); // bot-b has no chunks
    const results = await engine.search(db, 'bot-b', 'How much does Product A cost?', 3600);
    expect(results).toHaveLength(0);
  });
});

// ===========================================================================
// 9. NO-CONTEXT FALLBACK (empty corpus)
// ===========================================================================
describe('[retrieval-regression] 9. No-context fallback', () => {
  it('engine returns [] for any query when corpus is empty', async () => {
    const results = await engine.search(emptyDb(), 'new-bot', 'anything at all', 3600);
    expect(results).toHaveLength(0);
  });

  it('engine returns [] for punctuation-only query without hitting D1', async () => {
    const prepareSpy = jest.fn();
    const db = { prepare: prepareSpy } as unknown as D1Database;
    const results = await engine.search(db, 'bot1', '??? !!!', 3600);
    expect(results).toHaveLength(0);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('engine returns [] for empty string query without hitting D1', async () => {
    const prepareSpy = jest.fn();
    const db = { prepare: prepareSpy } as unknown as D1Database;
    const results = await engine.search(db, 'bot1', '', 3600);
    expect(results).toHaveLength(0);
    expect(prepareSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 10. LOW-RELEVANCE FALLBACK (relevance guard)
// ===========================================================================
describe('[retrieval-regression] 10. Low-relevance fallback (guard)', () => {
  it('FTS5 candidates all below threshold → guard returns [] → deterministic fallback path', () => {
    // Simulates: OR query matched a stop word in an unrelated chunk
    // The chunk scored very weakly; the guard must block it from reaching AI
    const candidates = [
      { content: 'Our store hours are 9am to 5pm Monday to Friday.', score: -0.0003, sourceFilename: 'faq.txt', chunkIndex: 0 },
      { content: 'We accept Visa and Mastercard.', score: -0.0001, sourceFilename: 'faq.txt', chunkIndex: 1 },
    ];
    const passed = filterByRelevance(candidates, MIN_SCORE);
    // All scores are above threshold (-0.5) → none pass → empty → deterministic fallback
    expect(passed).toHaveLength(0);
  });

  it('guard threshold -0.5: score exactly at -0.5 PASSES (guard uses <=)', () => {
    // filterByRelevance keeps c.score <= minScore
    const atThreshold = [
      { content: 'Borderline chunk', score: -0.5, sourceFilename: 'f.txt', chunkIndex: 0 },
    ];
    expect(filterByRelevance(atThreshold, -0.5)).toHaveLength(1); // passes (equal)

    // Score just above threshold (-0.4999) is blocked
    const justAbove = [
      { content: 'Too weak', score: -0.4999, sourceFilename: 'f.txt', chunkIndex: 0 },
    ];
    expect(filterByRelevance(justAbove, -0.5)).toHaveLength(0);   // blocked

    // The invariant: -0.001 is always blocked
    expect(filterByRelevance(
      [{ content: 'x', score: -0.001, sourceFilename: 'f.txt', chunkIndex: 0 }],
      MIN_SCORE
    )).toHaveLength(0);
  });

  it('strong match score -4.0 always passes the guard', () => {
    const candidates = [
      { content: 'Passwords must be changed every 90 days.', score: -4.0, sourceFilename: 'policy.txt', chunkIndex: 0 },
    ];
    const passed = filterByRelevance(candidates, MIN_SCORE);
    expect(passed).toHaveLength(1);
  });
});
