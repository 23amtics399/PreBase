import {
  checkIpGlobalLimit,
  checkBotIpLimit,
  checkBotGlobalLimit,
  readGlobalAiUsage,
  incrementGlobalAiUsage,
  atomicReserveGroqQuota,
  readGroqQuotaLedger,
} from './ratelimit';
import type { D1Database } from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// Helpers to build mock D1 stmts with controllable RETURNING values
// ---------------------------------------------------------------------------

function makeMockDb(returnedCount: number): { db: D1Database; decrementRun: jest.Mock } {
  const decrementRun = jest.fn().mockResolvedValue({ success: true });

  // The RETURNING stmt returns { msg_count: returnedCount, request_count: returnedCount }
  const insertStmt = {
    bind: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue({ msg_count: returnedCount, request_count: returnedCount }),
    run:  jest.fn().mockResolvedValue({ success: true }),
  };

  // The UPDATE (decrement) stmt — no RETURNING
  const updateStmt = {
    bind:  jest.fn().mockReturnThis(),
    run:   decrementRun,
    first: jest.fn().mockResolvedValue(null),
  };

  let callCount = 0;
  const db = {
    prepare: jest.fn().mockImplementation(() => {
      // First call = insert/upsert; second call = optional decrement
      callCount++;
      return callCount === 1 ? insertStmt : updateStmt;
    }),
  } as unknown as D1Database;

  return { db, decrementRun };
}

// ---------------------------------------------------------------------------
// checkIpGlobalLimit
// ---------------------------------------------------------------------------

describe('checkIpGlobalLimit', () => {
  it('allows request when count is within limit', async () => {
    const { db } = makeMockDb(5);
    const result = await checkIpGlobalLimit(db, '2026-09-05', 'abc123', 100);
    expect(result.allowed).toBe(true);
  });

  it('allows request when count equals the limit exactly', async () => {
    const { db } = makeMockDb(100);
    const result = await checkIpGlobalLimit(db, '2026-09-05', 'abc123', 100);
    expect(result.allowed).toBe(true);
  });

  it('blocks request and rolls back when count exceeds limit', async () => {
    const { db, decrementRun } = makeMockDb(101);
    const result = await checkIpGlobalLimit(db, '2026-09-05', 'abc123', 100);
    expect(result.allowed).toBe(false);
    expect((result as { allowed: false; reason: string }).reason).toBe('ip_global');
    // Verify decrement was called to roll back the over-limit increment
    expect(decrementRun).toHaveBeenCalledTimes(1);
  });

  it('blocks on the first request over limit (count = limit + 1)', async () => {
    const { db } = makeMockDb(6);
    const result = await checkIpGlobalLimit(db, '2026-09-05', 'abc123', 5);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkBotIpLimit
// ---------------------------------------------------------------------------

describe('checkBotIpLimit', () => {
  it('allows request within limit', async () => {
    const { db } = makeMockDb(10);
    const result = await checkBotIpLimit(db, 'bot_456', '2026-09-05', 'abc123', 20);
    expect(result.allowed).toBe(true);
  });

  it('blocks and rolls back when over limit', async () => {
    const { db, decrementRun } = makeMockDb(21);
    const result = await checkBotIpLimit(db, 'bot_456', '2026-09-05', 'abc123', 20);
    expect(result.allowed).toBe(false);
    expect((result as { allowed: false; reason: string }).reason).toBe('bot_ip');
    expect(decrementRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// checkBotGlobalLimit
// ---------------------------------------------------------------------------

describe('checkBotGlobalLimit', () => {
  it('allows request within limit', async () => {
    const { db } = makeMockDb(100);
    const result = await checkBotGlobalLimit(db, 'bot_456', '2026-09-05', 500);
    expect(result.allowed).toBe(true);
  });

  it('blocks and rolls back when over limit', async () => {
    const { db, decrementRun } = makeMockDb(501);
    const result = await checkBotGlobalLimit(db, 'bot_456', '2026-09-05', 500);
    expect(result.allowed).toBe(false);
    expect((result as { allowed: false; reason: string }).reason).toBe('bot_global');
    expect(decrementRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Groq Quota Ledger & atomicReserveGroqQuota
// ---------------------------------------------------------------------------

describe('Groq Quota Ledger (atomicReserveGroqQuota)', () => {
  it('readGroqQuotaLedger reads row from groq_quota_ledger table', async () => {
    const firstStmt = {
      bind: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        request_count: 42,
        est_input_tokens: 100,
        est_output_tokens: 200,
        act_input_tokens: 95,
        act_output_tokens: 190,
      }),
    };
    const db = { prepare: jest.fn().mockReturnValue(firstStmt) } as unknown as D1Database;

    const row = await readGroqQuotaLedger(db, '2026-09-10', 'qwen/qwen3.8-27b', 'ingestion');
    expect(row).toEqual({
      request_count: 42,
      est_input_tokens: 100,
      est_output_tokens: 200,
      act_input_tokens: 95,
      act_output_tokens: 190,
    });
  });

  it('readGroqQuotaLedger returns null when no row exists', async () => {
    const firstStmt = { bind: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
    const db = { prepare: jest.fn().mockReturnValue(firstStmt) } as unknown as D1Database;

    const row = await readGroqQuotaLedger(db, '2026-09-10', 'qwen/qwen3.8-27b', 'ingestion');
    expect(row).toBeNull();
  });

  it('atomicReserveGroqQuota allows when count is within budget limit', async () => {
    const { db } = makeMockDb(100);
    const res = await atomicReserveGroqQuota(db, '2026-09-10', 'qwen/qwen3.8-27b', 'ingestion', 650);
    expect(res.allowed).toBe(true);
    expect(res.count).toBe(100);
  });

  it('atomicReserveGroqQuota rejects and rolls back when use_case budget exceeded', async () => {
    const { db, decrementRun } = makeMockDb(651);
    const res = await atomicReserveGroqQuota(db, '2026-09-10', 'qwen/qwen3.8-27b', 'ingestion', 650);
    expect(res.allowed).toBe(false);
    expect(res.count).toBe(651);
    expect(res.reason).toBe('uc_budget');
    expect(decrementRun).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Global AI quota
// ---------------------------------------------------------------------------

describe('readGlobalAiUsage', () => {
  it('returns 0 when no row exists for the day', async () => {
    const stmt = {
      bind:  jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    const db = { prepare: jest.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const count = await readGlobalAiUsage(db, '2026-09-05');
    expect(count).toBe(0);
  });

  it('returns the stored ai_calls value', async () => {
    const stmt = {
      bind:  jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ ai_calls: 1234 }),
    };
    const db = { prepare: jest.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const count = await readGlobalAiUsage(db, '2026-09-05');
    expect(count).toBe(1234);
  });
});

describe('incrementGlobalAiUsage', () => {
  it('calls the upsert statement with the correct day', async () => {
    const run = jest.fn().mockResolvedValue({ success: true });
    const stmt = { bind: jest.fn().mockReturnThis(), run };
    const db = { prepare: jest.fn().mockReturnValue(stmt) } as unknown as D1Database;
    await incrementGlobalAiUsage(db, '2026-09-05');
    expect(stmt.bind).toHaveBeenCalledWith('2026-09-05');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrent increment safety (documented property)
// ---------------------------------------------------------------------------

describe('concurrent increment safety', () => {
  /**
   * We cannot directly test SQLite write serialisation in Jest (it's a D1
   * server-side guarantee). However we can verify:
   *
   * 1. Each call to checkIpGlobalLimit issues exactly ONE INSERT ... ON CONFLICT
   *    statement (the atomic upsert) — not a SELECT followed by an UPDATE.
   * 2. When the returned count > limit, a rollback decrement is issued.
   *
   * The absence of a SELECT-before-UPDATE is the key correctness property.
   */
  it('issues a single upsert statement per call (no SELECT-then-UPDATE)', async () => {
    const insertStmt = {
      bind:  jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ msg_count: 1 }),
      run:   jest.fn(),
    };
    const prepareSpy = jest.fn().mockReturnValue(insertStmt);
    const db = { prepare: prepareSpy } as unknown as D1Database;

    await checkIpGlobalLimit(db, '2026-09-05', 'abc', 100);

    // prepare should have been called exactly once with the INSERT statement
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    const sql: string = prepareSpy.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO usage/i);
    expect(sql).toMatch(/ON CONFLICT/i);
    // Must NOT contain a bare SELECT at the start (would indicate read-then-write)
    expect(sql.trim().toUpperCase()).not.toMatch(/^SELECT/);
  });
});
