import type { D1Database } from '@cloudflare/workers-types';

/**
 * Atomic rate-limit counters backed by D1 (SQLite).
 *
 * ATOMICITY GUARANTEE
 * All counters use the following SQLite pattern:
 *
 *   INSERT INTO t (k1, k2, k3, count) VALUES (?, ?, ?, 1)
 *   ON CONFLICT (k1, k2, k3)
 *   DO UPDATE SET count = count + 1
 *   RETURNING count;
 *
 * This is a single-statement atomic read-modify-write with no application-
 * level SELECT. SQLite (and D1) serialise all writes, so concurrent requests
 * cannot both read "count = 0" and increment to 1 simultaneously — each
 * increment goes through the SQLite write lock and the RETURNING clause
 * gives back the post-increment value.
 *
 * OVER-LIMIT ROLLBACK
 * When the returned count exceeds the limit, we decrement with:
 *
 *   UPDATE t SET count = MAX(0, count - 1) WHERE k1=? AND k2=? AND k3=?
 *
 * This ensures the counter stays accurate for callers who are within the
 * limit, while rejecting the request that pushed it over.
 *
 * RATE LIMIT SCOPES (three independent axes):
 *
 * 1. Per-IP global  — bot_id='__GLOBAL__', ip_hash=<ip>
 *    Prevents one IP from consuming the global AI budget across all bots.
 *
 * 2. Per-bot-per-IP — bot_id=<id>, ip_hash=<ip>
 *    Prevents one visitor from flooding a specific bot.
 *
 * 3. Per-bot global — bot_id=<id>, ip_hash='__ALL__'
 *    Prevents all visitors combined from exhausting a single bot's allowance.
 *
 * The AI global daily quota is tracked in a separate `global_usage` table
 * (see globalAi* functions below) using the same ON CONFLICT pattern.
 */

// Sentinel values that cannot collide with real UUIDs or HMAC hex strings
const SENTINEL_GLOBAL_BOT = '__GLOBAL__';
const SENTINEL_ALL_IPS    = '__ALL__';

/** Increments a counter and returns the new value. */
async function incrementCounter(
  db: D1Database,
  botId: string,
  day: string,
  ipHash: string
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO usage (bot_id, day, ip_hash, msg_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (bot_id, day, ip_hash)
       DO UPDATE SET msg_count = msg_count + 1
       RETURNING msg_count`
    )
    .bind(botId, day, ipHash)
    .first<{ msg_count: number }>();

  return row?.msg_count ?? 1;
}

/** Decrements a counter by 1 (minimum 0) to roll back an over-limit increment. */
async function decrementCounter(
  db: D1Database,
  botId: string,
  day: string,
  ipHash: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE usage
       SET msg_count = MAX(0, msg_count - 1)
       WHERE bot_id = ? AND day = ? AND ip_hash = ?`
    )
    .bind(botId, day, ipHash)
    .run();
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Scope 1: Per-IP global limit.
 * Counts all widget requests from this IP, regardless of which bot.
 * Key: (SENTINEL_GLOBAL_BOT, day, ipHash)
 */
export async function checkIpGlobalLimit(
  db: D1Database,
  day: string,
  ipHash: string,
  limit: number
): Promise<RateLimitResult> {
  const count = await incrementCounter(db, SENTINEL_GLOBAL_BOT, day, ipHash);
  if (count > limit) {
    await decrementCounter(db, SENTINEL_GLOBAL_BOT, day, ipHash);
    return { allowed: false, reason: 'ip_global' };
  }
  return { allowed: true };
}

/**
 * Scope 2: Per-bot-per-IP limit.
 * Counts requests from this IP to this specific bot.
 * Key: (botId, day, ipHash)
 */
export async function checkBotIpLimit(
  db: D1Database,
  botId: string,
  day: string,
  ipHash: string,
  limit: number
): Promise<RateLimitResult> {
  const count = await incrementCounter(db, botId, day, ipHash);
  if (count > limit) {
    await decrementCounter(db, botId, day, ipHash);
    return { allowed: false, reason: 'bot_ip' };
  }
  return { allowed: true };
}

/**
 * Scope 3: Per-bot global daily limit.
 * Counts all requests to this bot from all IPs combined.
 * Key: (botId, day, SENTINEL_ALL_IPS)
 */
export async function checkBotGlobalLimit(
  db: D1Database,
  botId: string,
  day: string,
  limit: number
): Promise<RateLimitResult> {
  const count = await incrementCounter(db, botId, day, SENTINEL_ALL_IPS);
  if (count > limit) {
    await decrementCounter(db, botId, day, SENTINEL_ALL_IPS);
    return { allowed: false, reason: 'bot_global' };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Global AI daily quota (separate table, tracks successful AI calls only)
// ---------------------------------------------------------------------------

/**
 * Reads the current global AI call count for a given day.
 * Used to pre-check before calling the AI (optimistic read).
 *
 * NOTE: There is a small race window between this read and the AI call.
 * A few concurrent requests may each read "under limit" and all proceed.
 * This can result in marginally exceeding the configured limit (by at most
 * the number of concurrent requests at the moment the limit is hit).
 * This is acceptable for MVP; the quota is a soft safety margin, not a hard cap.
 * The limit is already set at 70% of the theoretical maximum to absorb this.
 */
export async function readGlobalAiUsage(
  db: D1Database,
  day: string
): Promise<number> {
  const row = await db
    .prepare('SELECT ai_calls FROM global_usage WHERE day = ?')
    .bind(day)
    .first<{ ai_calls: number }>();
  return row?.ai_calls ?? 0;
}

/**
 * Atomically increments the global AI call counter.
 * Call this ONLY after a successful AI inference — never on failure.
 */
export async function incrementGlobalAiUsage(
  db: D1Database,
  day: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO global_usage (day, ai_calls)
       VALUES (?, 1)
       ON CONFLICT (day)
       DO UPDATE SET ai_calls = ai_calls + 1`
    )
    .bind(day)
    .run();
}

/**
 * Scope 4: Per-user daily preview AI limit.
 * Key: (user_id, day) in preview_usage table
 */
export async function checkPreviewLimit(
  db: D1Database,
  userId: string,
  day: string,
  limit: number
): Promise<RateLimitResult> {
  const row = await db
    .prepare(
      `INSERT INTO preview_usage (user_id, day, msg_count)
       VALUES (?, ?, 1)
       ON CONFLICT (user_id, day)
       DO UPDATE SET msg_count = msg_count + 1
       RETURNING msg_count`
    )
    .bind(userId, day)
    .first<{ msg_count: number }>();

  const count = row?.msg_count ?? 1;
  if (count > limit) {
    await db
      .prepare(
        `UPDATE preview_usage
         SET msg_count = MAX(0, msg_count - 1)
         WHERE user_id = ? AND day = ?`
      )
      .bind(userId, day)
      .run();
    return { allowed: false, reason: 'preview_limit' };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Groq Quota Ledger (Generic per-model, per-use-case budget & atomic ceiling)
// ---------------------------------------------------------------------------

/**
 * Generic atomic quota reservation for any (model_id, use_case) combination.
 *
 * For models with a combined ceiling (ceilingBudget is defined), this also
 * atomically reserves a slot in the sentinel '__model__' row BEFORE
 * reserving the per-use-case slot. This guarantees:
 *   SUM(request_count WHERE model_id=X) <= ceilingBudget
 * at the instant any slot is authorized.
 *
 * SQLite serializes all writes. Two concurrent requests both race to
 * increment the '__model__' sentinel row. One sees count <= ceiling (allowed),
 * the other sees count > ceiling (denied, rolled back). No read-before-write
 * race is possible.
 *
 * Budget values are PreBase application budgets — NOT provider quotas.
 * Provider quotas are external and enforced by Groq (HTTP 429).
 *
 * @param db            - D1 database binding
 * @param day           - 'YYYY-MM-DD' UTC
 * @param modelId       - Groq model ID (e.g. 'qwen/qwen3.8-27b')
 * @param useCase       - 'guard' | 'runtime' | 'ingestion'
 * @param ucBudget      - Per-use-case PreBase application daily budget
 * @param ceilingBudget - Combined model-level ceiling (omit if no shared ceiling)
 */
export async function atomicReserveGroqQuota(
  db: D1Database,
  day: string,
  modelId: string,
  useCase: string,
  ucBudget: number,
  ceilingBudget?: number
): Promise<{ allowed: boolean; count: number; reason?: 'model_ceiling' | 'uc_budget' }> {
  // Step 1: If ceilingBudget is provided, atomically increment the sentinel '__model__' row first
  if (ceilingBudget !== undefined) {
    const ceilingRow = await db
      .prepare(
        `INSERT INTO groq_quota_ledger (day, model_id, use_case, request_count)
         VALUES (?, ?, '__model__', 1)
         ON CONFLICT (day, model_id, use_case)
         DO UPDATE SET request_count = request_count + 1
         RETURNING request_count`
      )
      .bind(day, modelId)
      .first<{ request_count: number }>();

    const ceilingCount = ceilingRow?.request_count ?? 1;
    if (ceilingCount > ceilingBudget) {
      await db
        .prepare(
          `UPDATE groq_quota_ledger
           SET request_count = MAX(0, request_count - 1)
           WHERE day = ? AND model_id = ? AND use_case = '__model__'`
        )
        .bind(day, modelId)
        .run();
      return { allowed: false, count: ceilingCount, reason: 'model_ceiling' };
    }
  }

  // Step 2: Atomically increment the use_case row
  const ucRow = await db
    .prepare(
      `INSERT INTO groq_quota_ledger (day, model_id, use_case, request_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (day, model_id, use_case)
       DO UPDATE SET request_count = request_count + 1
       RETURNING request_count`
    )
    .bind(day, modelId, useCase)
    .first<{ request_count: number }>();

  const ucCount = ucRow?.request_count ?? 1;
  if (ucCount > ucBudget) {
    // Rollback step 2 (use_case row)
    await db
      .prepare(
        `UPDATE groq_quota_ledger
         SET request_count = MAX(0, request_count - 1)
         WHERE day = ? AND model_id = ? AND use_case = ?`
      )
      .bind(day, modelId, useCase)
      .run();

    // Rollback step 1 (sentinel row) if ceilingBudget was provided
    if (ceilingBudget !== undefined) {
      await db
        .prepare(
          `UPDATE groq_quota_ledger
           SET request_count = MAX(0, request_count - 1)
           WHERE day = ? AND model_id = ? AND use_case = '__model__'`
        )
        .bind(day, modelId)
        .run();
    }

    return { allowed: false, count: ucCount, reason: 'uc_budget' };
  }

  return { allowed: true, count: ucCount };
}

/**
 * Updates token usage counters in groq_quota_ledger after a successful call.
 *
 * LAYER 3 — OBSERVABILITY ONLY. Not used for enforcement decisions.
 *
 * est_* values are PreBase estimates from request parameters.
 * act_* values are provider-reported from response.usage when present.
 * Neither value is authoritative against Groq's provider-side TPD/TPM accounting.
 *
 * This update is best-effort. Failures are logged but do not affect the response.
 */
export async function updateGroqTokenLedger(
  db: D1Database,
  day: string,
  modelId: string,
  useCase: string,
  tokens: {
    estInput: number;
    estOutput: number;
    actInput?: number;
    actOutput?: number;
  }
): Promise<void> {
  // Never write token updates to the sentinel '__model__' row
  if (useCase === '__model__') return;

  await db
    .prepare(
      `INSERT INTO groq_quota_ledger
         (day, model_id, use_case, request_count, est_input_tokens, est_output_tokens,
          act_input_tokens, act_output_tokens)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT (day, model_id, use_case)
       DO UPDATE SET
         est_input_tokens  = est_input_tokens  + excluded.est_input_tokens,
         est_output_tokens = est_output_tokens + excluded.est_output_tokens,
         act_input_tokens  = act_input_tokens  + excluded.act_input_tokens,
         act_output_tokens = act_output_tokens + excluded.act_output_tokens`
    )
    .bind(
      day,
      modelId,
      useCase,
      tokens.estInput || 0,
      tokens.estOutput || 0,
      tokens.actInput || 0,
      tokens.actOutput || 0
    )
    .run();
}

/**
 * Reads a row from groq_quota_ledger for a given day, model_id, and use_case.
 * Primarily for testing and observability.
 */
export async function readGroqQuotaLedger(
  db: D1Database,
  day: string,
  modelId: string,
  useCase: string
): Promise<{
  request_count: number;
  est_input_tokens: number;
  est_output_tokens: number;
  act_input_tokens: number;
  act_output_tokens: number;
} | null> {
  return await db
    .prepare(
      `SELECT request_count, est_input_tokens, est_output_tokens, act_input_tokens, act_output_tokens
       FROM groq_quota_ledger
       WHERE day = ? AND model_id = ? AND use_case = ?`
    )
    .bind(day, modelId, useCase)
    .first();
}
