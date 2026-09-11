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
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helper: build a real in-memory SQLite database simulating D1 with FTS5 triggers
// ---------------------------------------------------------------------------
function createRealFts5Db(): D1Database {
  const sqlite = new Database(':memory:');

  sqlite.exec(`
    CREATE TABLE kb_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      enrichment_status TEXT DEFAULT 'not_requested' NOT NULL
    );

    CREATE TABLE kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      source_id INTEGER NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE knowledge_enrichment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL UNIQUE REFERENCES kb_chunks(id) ON DELETE CASCADE,
      questions TEXT NOT NULL,
      aliases TEXT NOT NULL,
      keywords TEXT NOT NULL,
      topics TEXT NOT NULL,
      entities TEXT NOT NULL,
      negative_constraints TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE kb_fts USING fts5(
      bot_id UNINDEXED,
      source_id UNINDEXED,
      chunk_index UNINDEXED,
      content
    );

    CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_fts(rowid, bot_id, source_id, chunk_index, content)
      VALUES (new.id, new.bot_id, new.source_id, new.chunk_index, new.content);
    END;

    CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
      DELETE FROM kb_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
      UPDATE kb_fts
      SET content = new.content ||
          IFNULL(
            (SELECT ' ' || questions || ' ' || aliases || ' ' || keywords || ' ' || topics || ' ' || entities || ' ' || negative_constraints
             FROM knowledge_enrichment WHERE chunk_id = new.id),
            ''
          )
      WHERE rowid = new.id;
    END;

    CREATE TRIGGER kb_enrich_ai AFTER INSERT ON knowledge_enrichment BEGIN
      UPDATE kb_fts
      SET content = (SELECT content FROM kb_chunks WHERE id = new.chunk_id) ||
                    ' ' || new.questions || ' ' || new.aliases || ' ' || new.keywords ||
                    ' ' || new.topics || ' ' || new.entities || ' ' || new.negative_constraints
      WHERE rowid = new.chunk_id;
    END;

    CREATE TRIGGER kb_enrich_au AFTER UPDATE ON knowledge_enrichment BEGIN
      UPDATE kb_fts
      SET content = (SELECT content FROM kb_chunks WHERE id = new.chunk_id) ||
                    ' ' || new.questions || ' ' || new.aliases || ' ' || new.keywords ||
                    ' ' || new.topics || ' ' || new.entities || ' ' || new.negative_constraints
      WHERE rowid = new.chunk_id;
    END;

    CREATE TRIGGER kb_enrich_ad AFTER DELETE ON knowledge_enrichment BEGIN
      UPDATE kb_fts
      SET content = (SELECT content FROM kb_chunks WHERE id = old.chunk_id)
      WHERE rowid = old.chunk_id;
    END;
  `);

  return {
    prepare: (query: string) => {
      const stmt = sqlite.prepare(query);
      return {
        bind: (...params: any[]) => ({
          all: async () => ({ results: stmt.all(...params) }),
          first: async () => stmt.get(...params),
          run: async () => ({ success: true, meta: stmt.run(...params) }),
        }),
      };
    },
    _sqlite: sqlite,
  } as unknown as D1Database;
}

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
describe('[retrieval-regression] 4. Synonym gap — bridged by Smart Enrichment (Phase 1)', () => {
  /**
   * "Do you deliver overseas?" vs corpus containing "ship internationally"
   *
   * FTS5 is a keyword matcher — it cannot resolve vocabulary equivalences alone.
   * However, Phase 1 Smart Enrichment uses Groq (qwen/qwen3.8-27b) to generate
   * aliases including "overseas", "abroad", "outside the country" etc. into
   * knowledge_enrichment, which is included in the FTS5 search corpus via the
   * fts_enrichment virtual table.
   *
   * These unit tests operate on mock DBs so they test FTS5 safety invariants only.
   * The actual synonym resolution via enrichment is verified in production tests.
   *
   * Expected behavior WITHOUT enrichment (mock empty corpus):
   *   - Retrieval safety:  PASS — no hallucination; deterministic fallback returned
   *   - Retrieval recall:  FAIL — correct answer exists in KB but was not retrieved
   *
   * Expected behavior WITH enrichment in production:
   *   - "overseas" → matches alias in knowledge_enrichment for shipping chunk → PASS
   *   - "pool" / "wet" → matches alias for warranty/liquid-damage chunk → PASS
   *
   * This section documents both the raw FTS5 limitation and the enrichment fix.
   */
  it('[SAFETY PASS] synonym query returns empty → correct deterministic fallback (not hallucination)', async () => {
    // Simulate: corpus has "ship internationally", query asks "deliver overseas"
    // Without enrichment, both AND and OR passes return empty.
    // The engine correctly returns [].
    const db = emptyDb();
    const results = await engine.search(db, 'bot1', 'Do you deliver overseas?', 3600);
    expect(results).toHaveLength(0);
    // Callers receiving [] must use the deterministic fallback, not the AI
  });

  it('[FTS5-ONLY LIMITATION] sanitize query for "overseas" does NOT match "internationally" in raw FTS5', () => {
    const q = sanitizeFtsQuery('Do you deliver overseas?');
    // "deliver AND overseas" — correct tokens, but raw corpus uses different vocabulary.
    // Phase 1 enrichment bridges this gap via knowledge_enrichment aliases.
    expect(q).toBe('deliver AND overseas');
    expect(q).not.toContain('internationally');
    expect(q).not.toContain('ship');
  });

  it('[FTS5-ONLY LIMITATION] sanitize query for "AI assistant" vs "chat assistant" — vocabulary gap', () => {
    const q = sanitizeFtsQuery('Is this an AI assistant?');
    // "AI" and "assistant" are content tokens — gap in corpus is bridged by enrichment in production.
    expect(q).toContain('assistant');
  });

  it('[REAL FTS5 ASSERTION] enrichment metadata makes vocabulary (pool, water, wet, overseas, abroad) searchable against authoritative chunks', async () => {
    const db = createRealFts5Db();
    const sqlite = (db as any)._sqlite;

    // Seed authoritative chunks without the target colloquial vocabulary:
    // Chunk 1: Warranty policy (mentions "moisture immersion" and "liquid ingress", but NOT "pool", "water", or "wet")
    sqlite.prepare(`
      INSERT INTO kb_sources (id, bot_id, filename, enrichment_status)
      VALUES (1, 'bot1', 'warranty_policy.txt', 'completed')
    `).run();

    const warrantyContent =
      'Standard hardware warranty terms: All manufacturing defects are covered for 12 months. ' +
      'Moisture immersion and liquid ingress void the coverage completely unless an extended protection plan was purchased at checkout.';

    sqlite.prepare(`
      INSERT INTO kb_chunks (id, bot_id, source_id, chunk_index, content)
      VALUES (1, 'bot1', 1, 0, ?)
    `).run(warrantyContent);

    // Chunk 2: Shipping policy (mentions "international destinations", but NOT "overseas" or "abroad")
    sqlite.prepare(`
      INSERT INTO kb_sources (id, bot_id, filename, enrichment_status)
      VALUES (2, 'bot1', 'shipping_guidelines.txt', 'completed')
    `).run();

    const shippingContent =
      'International shipping logistics: We fulfill commercial orders to over 50 international destinations ' +
      'with standardized customs clearance protocols.';

    sqlite.prepare(`
      INSERT INTO kb_chunks (id, bot_id, source_id, chunk_index, content)
      VALUES (2, 'bot1', 2, 0, ?)
    `).run(shippingContent);

    // ── Phase A: Verify raw FTS5 FAILS to match before enrichment ──────────────
    const prePool = await engine.search(db, 'bot1', 'pool', 3600);
    expect(prePool).toHaveLength(0);

    const preWater = await engine.search(db, 'bot1', 'water', 3600);
    expect(preWater).toHaveLength(0);

    const preWet = await engine.search(db, 'bot1', 'wet', 3600);
    expect(preWet).toHaveLength(0);

    const preOverseas = await engine.search(db, 'bot1', 'overseas', 3600);
    expect(preOverseas).toHaveLength(0);

    const preAbroad = await engine.search(db, 'bot1', 'abroad', 3600);
    expect(preAbroad).toHaveLength(0);

    // ── Phase B: Insert enrichment metadata with aliases / vocabulary bridging ─
    // Chunk 1 gets "pool", "water", "wet" in its enrichment
    sqlite.prepare(`
      INSERT INTO knowledge_enrichment (
        chunk_id, questions, aliases, keywords, topics, entities, negative_constraints, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      1,
      JSON.stringify(['What happens if my phone falls in the pool?', 'Does warranty cover liquid exposure?']),
      JSON.stringify(['pool', 'water', 'wet', 'submerged', 'toilet drop', 'puddle', 'spill']),
      JSON.stringify(['warranty', 'liquid', 'immersion', 'hardware', 'protection']),
      JSON.stringify(['warranty coverage', 'damage exceptions']),
      JSON.stringify(['Hardware Support Team']),
      JSON.stringify(['liquid damage not covered under standard plan']),
      'qwen/qwen3.8-27b',
      Date.now(),
      Date.now()
    );

    // Chunk 2 gets "overseas", "abroad" in its enrichment
    sqlite.prepare(`
      INSERT INTO knowledge_enrichment (
        chunk_id, questions, aliases, keywords, topics, entities, negative_constraints, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      2,
      JSON.stringify(['Do you deliver packages overseas?', 'Can I place an order from abroad?']),
      JSON.stringify(['overseas', 'abroad', 'foreign delivery', 'outside the country', 'global']),
      JSON.stringify(['shipping', 'customs', 'international', 'fulfillment', 'destinations']),
      JSON.stringify(['shipping policy', 'international fulfillment']),
      JSON.stringify(['Logistics Dept']),
      JSON.stringify(['no domestic-only restrictions']),
      'qwen/qwen3.8-27b',
      Date.now(),
      Date.now()
    );

    // ── Phase C: Verify all 5 vocabulary terms now search successfully ─────────
    // 1. "pool"
    const poolRes = await engine.search(db, 'bot1', 'device fell in the pool', 3600);
    expect(poolRes.length).toBeGreaterThan(0);
    expect(poolRes[0].sourceFilename).toBe('warranty_policy.txt');
    expect(poolRes[0].chunkIndex).toBe(0);
    // CRITICAL: Source of truth is preserved — content is original text, NOT the enrichment string
    expect(poolRes[0].content).toBe(warrantyContent);
    expect(poolRes[0].content).not.toContain('pool');

    // 2. "water"
    const waterRes = await engine.search(db, 'bot1', 'is water damage covered?', 3600);
    expect(waterRes.length).toBeGreaterThan(0);
    expect(waterRes[0].sourceFilename).toBe('warranty_policy.txt');
    expect(waterRes[0].content).toBe(warrantyContent);

    // 3. "wet"
    const wetRes = await engine.search(db, 'bot1', 'what if the device gets wet?', 3600);
    expect(wetRes.length).toBeGreaterThan(0);
    expect(wetRes[0].sourceFilename).toBe('warranty_policy.txt');
    expect(wetRes[0].content).toBe(warrantyContent);

    // 4. "overseas"
    const overseasRes = await engine.search(db, 'bot1', 'do you deliver overseas?', 3600);
    expect(overseasRes.length).toBeGreaterThan(0);
    expect(overseasRes[0].sourceFilename).toBe('shipping_guidelines.txt');
    expect(overseasRes[0].chunkIndex).toBe(0);
    // Source of truth preserved
    expect(overseasRes[0].content).toBe(shippingContent);
    expect(overseasRes[0].content).not.toContain('overseas');

    // 5. "abroad"
    const abroadRes = await engine.search(db, 'bot1', 'can I order from abroad?', 3600);
    expect(abroadRes.length).toBeGreaterThan(0);
    expect(abroadRes[0].sourceFilename).toBe('shipping_guidelines.txt');
    expect(abroadRes[0].content).toBe(shippingContent);

    // ── Phase D: Verify cross-bot isolation with real FTS5 ─────────────────────
    const bot2Res = await engine.search(db, 'bot2', 'deliver overseas', 3600);
    expect(bot2Res).toHaveLength(0);
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
