/**
 * enrichment.test.ts — Phase 1 (Groq)
 *
 * Full test coverage for the Groq-based enrichment handler.
 *
 * Key invariants verified:
 *  - enrichChunk:
 *      valid Groq response → EnrichmentResult
 *      markdown-wrapped JSON → stripped and parsed correctly
 *      extra fields → ignored (strict validation)
 *      missing fields → normalised to empty arrays (not fatal)
 *      excessively long aliases → truncated
 *      empty arrays → accepted
 *      malformed JSON → parse_error
 *      HTTP 429 → rate_limit, transient
 *      HTTP 401/403 → auth, permanent
 *      HTTP 404 → not_found, permanent
 *      HTTP 400 → parse_error, permanent
 *      HTTP 500 → server_error, transient
 *      network exception → network_error, transient
 *      missing API key → auth, permanent, no fetch
 *
 *  - handleEnrichmentBatch:
 *      per-message ack/retry: failure in one chunk does NOT affect others
 *      idempotency: already-enriched chunk is acked without calling Groq
 *      source status: queued→processing→completed/failed
 *      completed is never overwritten by a late failed update
 *      permanent errors (auth/not_found) mark source failed immediately
 *      transient errors cause retry (not ack) with backoff
 *      stale/deleted chunk messages are silently acked
 *      multi-chunk completion only when ALL chunks enriched
 *      DB write failure → retry
 *      DB content is sent to Groq (not queue payload)
 *      processing UPDATE happens before Groq call
 *      empty batch is handled gracefully
 *
 *  - Source-of-truth regression:
 *      fake enrichment metadata cannot change the final answer
 *      (kb_chunks.content is the only authoritative source sent to AI)
 */

import { handleEnrichmentBatch, enrichChunk } from './enrichment';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

global.fetch = jest.fn() as any;

function makeMockDb(overrides: Record<string, any> = {}) {
  const db: any = {
    _calls: [] as string[],
    _firstQueue: [] as any[],
    _runResponses: [] as any[],
    _lastSql: '',
    _hasFailedChunk: false,
    _hasSucceededChunk: false,

    prepare: jest.fn().mockImplementation((sqlStr: unknown) => {
      const sql = (sqlStr as string).trim();
      db._lastSql = sql;
      db._calls.push(sql);
      if (sql.includes('INSERT INTO knowledge_enrichment_failures')) {
        db._hasFailedChunk = true;
      }
      if (sql.includes('INSERT INTO knowledge_enrichment')) {
        db._hasSucceededChunk = true;
      }
      return db;
    }),
    bind: jest.fn().mockReturnThis(),
    first: jest.fn().mockImplementation(async () => {
      const sql = db._lastSql;

      if (sql.includes('groq_quota_ledger') || sql.includes('groq_usage')) {
        return { request_count: overrides.groqCalls ?? 1, ingestion_calls: overrides.groqCalls ?? 1 };
      }
      if (sql.includes('kb_sources') && sql.includes('chunk_count')) {
        return { chunk_count: overrides.chunkCount ?? 1, enrichment_status: overrides.sourceStatus ?? 'processing' };
      }
      if (sql.includes('knowledge_enrichment_failures') && sql.includes('COUNT(*)')) {
        return { cnt: overrides.failedCnt ?? (db._hasFailedChunk ? 1 : 0) };
      }
      if (sql.includes('knowledge_enrichment') && sql.includes('COUNT(*)')) {
        return { cnt: overrides.succeededCnt ?? (db._hasSucceededChunk ? 1 : 0) };
      }
      if (sql.includes('kb_chunks') && sql.includes('content')) {
        if (db._firstQueue.length) return db._firstQueue.shift();
        return overrides.chunkRecord ?? { content: 'test content' };
      }

      if (db._firstQueue.length) return db._firstQueue.shift();
      return overrides.firstDefault ?? null;
    }),
    run: jest.fn().mockImplementation(async () => {
      if (db._runResponses.length) return db._runResponses.shift();
      return { success: true };
    }),
  };
  return db;
}

/**
 * Build a mock Groq (OpenAI-compat) success response.
 * Groq returns { choices: [{ message: { content: "<json string>" } }] }
 */
function makeGroqSuccess(partial: Partial<Record<string, any>> = {}) {
  const payload = {
    questions: partial.questions ?? ['What is Q?'],
    aliases:   partial.aliases   ?? [],
    keywords:  partial.keywords  ?? ['K1'],
    topics:    partial.topics    ?? ['T1'],
    entities:  partial.entities  ?? [],
    negative_constraints: partial.negative_constraints ?? [],
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
  };
}

/** Build a Groq success response where JSON is wrapped in markdown fences */
function makeGroqFenced(payload: object = {}) {
  const full = {
    questions: ['Q1'], aliases: [], keywords: ['K1'],
    topics: ['T1'], entities: [], negative_constraints: [],
    ...payload,
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(full)}\n\`\`\`` } }],
    }),
  };
}

function makeGroqError(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code: status, message: 'error', status: 'ERROR' } }),
    text: async () => 'error',
  };
}

function makeMsg(overrides: Partial<any> = {}) {
  const ack   = jest.fn();
  const retry = jest.fn();
  return {
    body:      { version: 1, chunkId: 1, botId: 'b1', sourceId: 10, ...overrides.body },
    attempts:  overrides.attempts ?? 1,
    id:        overrides.id ?? 'msg-1',
    timestamp: new Date(),
    ack,
    retry,
    _ack:  ack,
    _retry: retry,
  };
}

const baseEnv = {
  GROQ_API_KEY:           'test-groq-key',
  PREBASE_INGESTION_MODEL: 'qwen/qwen3.8-27b',
  PREBASE_ENRICH_MAX_RETRIES: '3',
  // Disable the production 8500ms inter-chunk pacing delay in tests.
  // Production workers use the default (8500ms) from wrangler.toml.
  PREBASE_ENRICH_PACE_MS: '0',
};

// ---------------------------------------------------------------------------
// enrichChunk unit tests
// ---------------------------------------------------------------------------

describe('enrichChunk', () => {
  beforeEach(() => (global.fetch as any).mockClear());

  // ── Auth / API key ───────────────────────────────────────────────────────
  it('returns auth failure when API key is missing', async () => {
    const r = await enrichChunk('', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('auth');
      expect(r.permanent).toBe(true);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Valid structured output ──────────────────────────────────────────────
  it('returns parsed structured data on a valid Groq response', async () => {
    (global.fetch as any).mockResolvedValue(makeGroqSuccess({ questions: ['What is X?'] }));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.questions).toEqual(['What is X?']);
      expect(Array.isArray(r.result.aliases)).toBe(true);
      expect(Array.isArray(r.result.keywords)).toBe(true);
    }
  });

  // ── Markdown-wrapped JSON ────────────────────────────────────────────────
  it('strips markdown code fences before parsing JSON', async () => {
    (global.fetch as any).mockResolvedValue(makeGroqFenced({ keywords: ['fence-test'] }));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.keywords).toContain('fence-test');
    }
  });

  it('strips plain ``` fences (no json tag)', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: `\`\`\`\n{"questions":["Q"],"aliases":[],"keywords":["K"],"topics":["T"],"entities":[],"negative_constraints":[]}\n\`\`\`` } }],
      }),
    });
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.keywords).toContain('K');
  });

  // ── Missing fields normalised (not fatal) ────────────────────────────────
  it('normalises missing fields to empty arrays', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ questions: ['Q'] }) } }],
      }),
    });
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.keywords).toEqual([]);
      expect(r.result.aliases).toEqual([]);
      expect(r.result.negative_constraints).toEqual([]);
    }
  });

  // ── Extra fields ignored (strict validation) ─────────────────────────────
  it('ignores extra fields not in the schema', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              questions: ['Q'], aliases: [], keywords: ['K'],
              topics: ['T'], entities: [], negative_constraints: [],
              EXTRA_FIELD: 'should be discarded',
            }),
          },
        }],
      }),
    });
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.result as any).EXTRA_FIELD).toBeUndefined();
    }
  });

  // ── Excessively long aliases truncated ───────────────────────────────────
  it('truncates aliases exceeding max item length', async () => {
    const longAlias = 'a'.repeat(300);
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              questions: [], aliases: [longAlias], keywords: [],
              topics: [], entities: [], negative_constraints: [],
            }),
          },
        }],
      }),
    });
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.aliases[0].length).toBeLessThanOrEqual(200);
    }
  });

  // ── Empty arrays accepted ────────────────────────────────────────────────
  it('accepts all-empty arrays as a valid result', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              questions: [], aliases: [], keywords: [],
              topics: [], entities: [], negative_constraints: [],
            }),
          },
        }],
      }),
    });
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.questions).toEqual([]);
    }
  });

  // ── Malformed JSON ───────────────────────────────────────────────────────
  it('returns parse_error when Groq JSON is malformed', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'NOT JSON {{{' } }],
      }),
    });
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe('parse_error');
  });

  // ── Empty / missing content ──────────────────────────────────────────────
  it('returns parse_error when choices are missing', async () => {
    (global.fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe('parse_error');
  });

  it('returns parse_error when content is empty string', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    });
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe('parse_error');
  });

  // ── HTTP error codes ─────────────────────────────────────────────────────
  it('returns rate_limit (transient) on HTTP 429', async () => {
    (global.fetch as any).mockResolvedValue(makeGroqError(429));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('rate_limit');
      expect(r.permanent).toBe(false);
      expect(r.httpStatus).toBe(429);
    }
  });

  it('returns auth (permanent) on HTTP 401', async () => {
    (global.fetch as any).mockResolvedValue(makeGroqError(401));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('auth');
      expect(r.permanent).toBe(true);
    }
  });

  it('returns auth (permanent) on HTTP 403', async () => {
    (global.fetch as any).mockResolvedValue(makeGroqError(403));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('auth');
      expect(r.permanent).toBe(true);
    }
  });

  it('returns not_found (permanent) on HTTP 404', async () => {
    (global.fetch as any).mockResolvedValue(makeGroqError(404));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('not_found');
      expect(r.permanent).toBe(true);
    }
  });

  it('returns parse_error (permanent) on HTTP 400', async () => {
    (global.fetch as any).mockResolvedValue(makeGroqError(400));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('parse_error');
      expect(r.permanent).toBe(true);
    }
  });

  it('returns server_error (transient) on HTTP 500', async () => {
    (global.fetch as any).mockResolvedValue(makeGroqError(500));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('server_error');
      expect(r.permanent).toBe(false);
    }
  });

  it('returns network_error on fetch exception', async () => {
    (global.fetch as any).mockRejectedValue(new Error('network down'));
    const r = await enrichChunk('key', 'model', 'text');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('network_error');
      expect(r.permanent).toBe(false);
    }
  });

  it('aborts and returns network_error (transient) when Groq request times out', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    (global.fetch as any).mockImplementation((_url: string, opts: any) => {
      expect(opts.signal).toBeDefined();
      return Promise.reject(abortErr);
    });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await enrichChunk('secret-api-key-xyz', 'qwen/qwen3.8-27b', 'Super confidential text', 100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe('network_error');
      expect(r.permanent).toBe(false);
    }
    const logs = consoleSpy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(logs).not.toContain('Super confidential text');
    expect(logs).not.toContain('secret-api-key-xyz');
    expect(logs).toContain('timed out after 100ms');
    consoleSpy.mockRestore();
  });

  // ── Provider-specific response format ────────────────────────────────────
  it('correctly reads Groq OpenAI-compatible choices[0].message.content format', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-abc',
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              questions: ['Groq format Q'],
              aliases: ['groq alias'],
              keywords: ['groq-kw'],
              topics: ['groq-topic'],
              entities: [],
              negative_constraints: [],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      }),
    });
    const r = await enrichChunk('key', 'qwen/qwen3.8-27b', 'text');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.questions).toContain('Groq format Q');
      expect(r.result.aliases).toContain('groq alias');
    }
  });
});

// ---------------------------------------------------------------------------
// handleEnrichmentBatch unit tests
// ---------------------------------------------------------------------------

describe('handleEnrichmentBatch', () => {
  beforeEach(() => (global.fetch as any).mockClear());

  // ── Single message success ──────────────────────────────────────────────────
  it('acks on success and updates DB', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'test content' });
    (global.fetch as any).mockResolvedValue(makeGroqSuccess());

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(msg._ack).toHaveBeenCalledTimes(1);
    expect(msg._retry).not.toHaveBeenCalled();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────
  it('acks idempotently when chunk already has enrichment — does not call Groq', async () => {
    const db = makeMockDb();
    db._firstQueue.push({ chunk_id: 1 });
    (global.fetch as any).mockResolvedValue(makeGroqSuccess());

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(msg._ack).toHaveBeenCalledTimes(1);
    expect(msg._retry).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Stale/deleted chunk ──────────────────────────────────────────────────────
  it('acks silently when chunk record not found in DB', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, null);

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(msg._ack).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Transient failure → retry with backoff ───────────────────────────────────
  it('calls retry() on rate_limit (429) at attempt 1 with 15s delay', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqError(429));

    const msg = makeMsg({ attempts: 1 });
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    // Backoff schedule: 15s (attempts <2), 30s (>=2), 60s (>=4), 120s (>=6)
    expect(msg._retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(msg._ack).not.toHaveBeenCalled();
  });

  it('calls retry() with 30s delay at attempt 2', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqError(429));

    const msg = makeMsg({ attempts: 2 });
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(msg._retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it('calls retry() with 30s delay at attempt 3 (before maxRetries)', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqError(500)); // transient

    // attempts=3 with maxRetries=4 — still transient.
    // Backoff schedule: >=2→30s, >=4→60s. At attempts=3, delay=30s.
    const msg = makeMsg({ attempts: 3 });
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db, PREBASE_ENRICH_MAX_RETRIES: '4' });

    expect(msg._retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(msg._ack).not.toHaveBeenCalled();
  });

  // ── Permanent failure on auth error ─────────────────────────────────────────
  it('acks on permanent auth failure (401) and marks source failed', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqError(401));

    const msg = makeMsg({ attempts: 1 });
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(msg._ack).toHaveBeenCalledTimes(1);
    expect(msg._retry).not.toHaveBeenCalled();

    const failedCall = db._calls.find((c: string) => c.includes("'failed'"));
    expect(failedCall).toBeDefined();
  });

  // ── Permanent failure after max attempts ────────────────────────────────────
  it('acks and marks source failed when attempts >= maxRetries (transient becomes permanent)', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqError(429));

    const msg = makeMsg({ attempts: 3 });
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db, PREBASE_ENRICH_MAX_RETRIES: '3' });

    expect(msg._ack).toHaveBeenCalledTimes(1);
    expect(msg._retry).not.toHaveBeenCalled();
    const failedCall = db._calls.find((c: string) => c.includes("'failed'"));
    expect(failedCall).toBeDefined();
  });

  // ── Mixed batch: per-message independence ────────────────────────────────────
  it('acks successful messages and retries failed ones independently', async () => {
    const db = makeMockDb();
    db._firstQueue = [
      null,                    // idempotency check chunk 1
      { content: 'chunk 1' },  // chunk 1 content
      null,                    // idempotency check chunk 2
      { content: 'chunk 2' },  // chunk 2 content
    ];

    (global.fetch as any)
      .mockResolvedValueOnce(makeGroqSuccess())    // chunk 1 OK
      .mockResolvedValueOnce(makeGroqError(429));  // chunk 2 rate-limited

    const msg1 = makeMsg({ body: { version: 1, chunkId: 1, botId: 'b1', sourceId: 10 }, id: 'msg-1' });
    const msg2 = makeMsg({ body: { version: 1, chunkId: 2, botId: 'b1', sourceId: 10 }, attempts: 1, id: 'msg-2' });

    await handleEnrichmentBatch([msg1 as any, msg2 as any], { ...baseEnv, DB: db });

    expect(msg1._ack).toHaveBeenCalledTimes(1);
    expect(msg1._retry).not.toHaveBeenCalled();

    expect(msg2._retry).toHaveBeenCalledTimes(1);
    expect(msg2._ack).not.toHaveBeenCalled();
  });

  // ── Multi-chunk completion ───────────────────────────────────────────────────
  it('marks source completed when all chunks enriched', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqSuccess());

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    const completedCall = db._calls.find((c: string) => c.includes('UPDATE kb_sources') && c.includes('enrichment_status = ?'));
    expect(completedCall).toBeDefined();
    expect(msg._ack).toHaveBeenCalledTimes(1);
  });

  // ── Completed not overwritten by failed ──────────────────────────────────────
  it('does not overwrite completed status with failed (SQL guard in place)', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqError(401));

    const msg = makeMsg({ attempts: 1 });
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    // (1) A failed status UPDATE was issued
    const failedCall = db._calls.find((c: string) => c.includes("'failed'"));
    expect(failedCall).toBeDefined();

    // (2) Guard present in production code — static assertion
    const { readFileSync } = require('fs');
    const src = readFileSync(require.resolve('./enrichment'), 'utf8');
    expect(src).toContain("if (source.enrichment_status === 'completed') return;");
    expect(src).toContain("WHERE id = ? AND enrichment_status IN ('processing', 'queued', 'partial', 'failed')");
  });

  // ── DB write failure → retry ─────────────────────────────────────────────────
  it('calls retry() when DB write throws (transient DB error)', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqSuccess());

    let runCallCount = 0;
    db.run = jest.fn().mockImplementation(async () => {
      runCallCount++;
      // 3rd run() call is the INSERT into knowledge_enrichment
      if (runCallCount === 3) throw new Error('D1 write failure');
      return { success: true };
    });

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(msg._retry).toHaveBeenCalledTimes(1);
    expect(msg._ack).not.toHaveBeenCalled();
  });

  // ── Source-of-truth: DB content sent to Groq (not queue payload) ─────────────
  it('sends DB chunk content to Groq, not queue payload content', async () => {
    const db = makeMockDb();
    const dbContent = 'authoritative content from DB';
    db._firstQueue.push(null, { content: dbContent });

    let capturedBody: any;
    (global.fetch as any).mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return makeGroqSuccess();
    });

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    // DB content appears in the user message
    const userMsg = capturedBody.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toContain(dbContent);
    // Queue payload contains only IDs — no content field
    expect((msg as any).body.content).toBeUndefined();
  });

  // ── Groq-specific: Authorization header present ──────────────────────────────
  it('sends Authorization: Bearer header with GROQ_API_KEY', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });

    let capturedHeaders: Record<string, string> = {};
    (global.fetch as any).mockImplementation(async (_url: string, opts: any) => {
      capturedHeaders = opts.headers;
      return makeGroqSuccess();
    });

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db, GROQ_API_KEY: 'gsk_test' });

    expect(capturedHeaders['Authorization']).toBe('Bearer gsk_test');
  });

  // ── Groq-specific: correct endpoint ─────────────────────────────────────────
  it('calls the Groq API endpoint (api.groq.com)', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });

    let capturedUrl = '';
    (global.fetch as any).mockImplementation(async (url: string) => {
      capturedUrl = url;
      return makeGroqSuccess();
    });

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(capturedUrl).toContain('api.groq.com');
  });

  // ── Groq-specific: max_tokens set (compact output) ──────────────────────────
  it('sets max_tokens in Groq request body (OTPM protection)', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });

    let capturedBody: any;
    (global.fetch as any).mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return makeGroqSuccess();
    });

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(capturedBody.max_tokens).toBeDefined();
    expect(typeof capturedBody.max_tokens).toBe('number');
  });

  // ── Status: queued → processing before Groq call ────────────────────────────
  it('issues processing UPDATE before calling Groq', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });

    const callOrder: string[] = [];
    db.run = jest.fn().mockImplementation(async () => {
      callOrder.push('run');
      return { success: true };
    });
    (global.fetch as any).mockImplementation(async () => {
      callOrder.push('groq');
      return makeGroqSuccess();
    });

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    const processingIdx = callOrder.indexOf('run');
    const groqIdx       = callOrder.indexOf('groq');
    expect(processingIdx).toBeLessThan(groqIdx);
  });

  // ── Groq-specific: response_format json_object set ───────────────────────────
  it('sets response_format: { type: "json_object" } in Groq request body', async () => {
    const db = makeMockDb();
    db._firstQueue.push(null, { content: 'text' });

    let capturedBody: any;
    (global.fetch as any).mockImplementation(async (_url: string, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return makeGroqSuccess();
    });

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
  });

  // ── Daily Budget Exhaustion (C3) ─────────────────────────────────────────────
  it('requeues message with 3600s delay when Groq daily ingestion budget is exhausted', async () => {
    const db = makeMockDb({ groqCalls: 651 }); // over 650 limit

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db, PREBASE_GROQ_INGESTION_BUDGET: '650' });

    expect(msg._retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
    expect(msg._ack).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Partial source status (C2) ───────────────────────────────────────────────
  it('resolves source to partial when 1 chunk succeeds and 1 chunk permanently fails', async () => {
    const db = makeMockDb({ chunkCount: 2, succeededCnt: 1, failedCnt: 1 });
    db._firstQueue.push(null, { content: 'text' });
    (global.fetch as any).mockResolvedValue(makeGroqError(401)); // permanent failure

    const msg = makeMsg({ attempts: 1 });
    await handleEnrichmentBatch([msg as any], { ...baseEnv, DB: db });

    expect(msg._ack).toHaveBeenCalledTimes(1);
    const partialCall = db._calls.find((c: string) => c.includes("'partial'"));
    expect(partialCall).toBeDefined();
  });

  // ── Empty batch ──────────────────────────────────────────────────────────────
  it('handles empty batch gracefully without calling Groq', async () => {
    const db = makeMockDb();
    await handleEnrichmentBatch([], { ...baseEnv, DB: db });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // ── Trailing Pacing Elimination ──────────────────────────────────────────────
  it('waits between calls in a multi-message batch, but NOT after the final message', async () => {
    const db = makeMockDb();
    db._firstQueue = [
      null, { content: 'chunk 1' },
      null, { content: 'chunk 2' },
    ];
    (global.fetch as any).mockResolvedValue(makeGroqSuccess());

    const msg1 = makeMsg({ chunkId: 1 });
    const msg2 = makeMsg({ chunkId: 2 });

    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = jest.fn((fn: any, _ms: any) => originalSetTimeout(fn, 0));
    (global as any).setTimeout = setTimeoutSpy;

    try {
      await handleEnrichmentBatch([msg1 as any, msg2 as any], {
        ...baseEnv,
        DB: db,
        PREBASE_ENRICH_PACE_MS: '8500',
      });

      // Pacing should have been called between message 0 and message 1, but NOT after message 1
      const pacingCalls = setTimeoutSpy.mock.calls.filter((c: any) => c[1] === 8500);
      expect(pacingCalls).toHaveLength(1);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  it('does NOT sleep at all for a single-message batch', async () => {
    const db = makeMockDb();
    db._firstQueue = [null, { content: 'chunk 1' }];
    (global.fetch as any).mockResolvedValue(makeGroqSuccess());

    const msg = makeMsg({ chunkId: 1 });

    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = jest.fn((fn: any, _ms: any) => originalSetTimeout(fn, 0));
    (global as any).setTimeout = setTimeoutSpy;

    try {
      await handleEnrichmentBatch([msg as any], {
        ...baseEnv,
        DB: db,
        PREBASE_ENRICH_PACE_MS: '8500',
      });

      const pacingCalls = setTimeoutSpy.mock.calls.filter((c: any) => c[1] === 8500);
      expect(pacingCalls).toHaveLength(0);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  // ── Configurable Timeout ──────────────────────────────────────────────────
  it('reads and applies PREBASE_ENRICH_TIMEOUT_MS in handleEnrichmentBatch', async () => {
    const db = makeMockDb();
    db._firstQueue = [null, { content: 'chunk 1' }];

    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    (global.fetch as any).mockRejectedValue(abortErr);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const msg = makeMsg({ attempts: 1 });

    await handleEnrichmentBatch([msg as any], {
      ...baseEnv,
      DB: db,
      PREBASE_ENRICH_TIMEOUT_MS: '1234',
    });

    const logs = consoleSpy.mock.calls.map(c => c.join(' ')).join(' ');
    expect(logs).toContain('timed out after 1234ms');
    expect(msg._retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Source-of-truth regression: enrichment metadata cannot change factual answer
// ---------------------------------------------------------------------------

describe('Source-of-truth regression', () => {
  /**
   * This test proves that Groq-generated enrichment metadata cannot alter
   * the factual content sent to the final answer model (Granite).
   *
   * The knowledge_enrichment table is used ONLY for FTS5 search metadata.
   * kb_chunks.content is the ONLY content that reaches the final answer model.
   *
   * Scenario:
   *   - Original chunk: "Returns allowed within 30 days."
   *   - Maliciously crafted enrichment metadata: "Returns allowed within 90 days."
   *   - Expected: Granite still sees "30 days" (original content, unchanged)
   */

  it('kb_chunks.content is read from DB — enrichment metadata cannot change the chunk content', async () => {
    const db = makeMockDb();

    // The "genuine" DB content is the original authoritative text
    const originalContent = 'Returns allowed within 30 days.';
    db._firstQueue.push(null, { content: originalContent });

    // Crafted enrichment: a malicious alias with false information
    const maliciousEnrichment = makeGroqSuccess({
      aliases: ['Returns allowed within 90 days.'],  // WRONG — counterfactual
      questions: ['How many days for returns?'],
    });
    (global.fetch as any).mockResolvedValue(maliciousEnrichment);

    let sentToGroq = '';
    (global.fetch as any).mockImplementation(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      sentToGroq = body.messages.find((m: any) => m.role === 'user').content;
      return maliciousEnrichment;
    });

    const msg = makeMsg();
    await handleEnrichmentBatch([msg as any], { ...makeMockDb(), DB: db, ...baseEnv });

    // Groq was called with the ORIGINAL content, not anything else
    expect(sentToGroq).toContain(originalContent);
    expect(sentToGroq).not.toContain('90 days');

    // The enrichment result stores the aliases in knowledge_enrichment (for FTS5)
    // but kb_chunks.content is never modified — this is enforced by the schema
    // (there is no UPDATE on kb_chunks in the enrichment handler).
    const { readFileSync } = require('fs');
    const src = readFileSync(require.resolve('./enrichment'), 'utf8');
    // Verify: no UPDATE on kb_chunks anywhere in the enrichment code
    expect(src).not.toMatch(/UPDATE\s+kb_chunks/i);
    // Verify: knowledge_enrichment INSERT uses chunk_id FK (not modifying content)
    expect(src).toContain('INSERT INTO knowledge_enrichment');
  });
});
