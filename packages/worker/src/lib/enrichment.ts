import { atomicReserveGroqQuota, updateGroqTokenLedger } from './ratelimit';
import { QWEN_CEILING_MODEL_ID } from './provider_config';

export type EnrichmentMessage = {
  version: number;
  chunkId: number;
  botId: string;
  sourceId: number;
};

export type EnrichmentResult = {
  questions: string[];
  aliases: string[];
  keywords: string[];
  topics: string[];
  entities: string[];
  negative_constraints: string[];
};

// Categorised outcome — lets callers log safe diagnostics without exposing key/content.
export type EnrichmentOutcome =
  | {
      ok: true;
      result: EnrichmentResult;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
      };
    }
  | {
      ok: false;
      category: 'auth' | 'not_found' | 'rate_limit' | 'server_error' | 'parse_error' | 'network_error';
      httpStatus?: number;
      // permanent=true means retrying will not help
      permanent: boolean;
    };

// ---------------------------------------------------------------------------
// Max lengths for output validation — prevents runaway aliases / questions
// ---------------------------------------------------------------------------
const MAX_ITEMS_PER_FIELD = 40;
const MAX_ITEM_LENGTH     = 200;

/**
 * Validate and sanitize the raw parsed object from Groq.
 *
 * Rules:
 *   - All six fields must be present and be arrays.
 *   - Each element must be a non-empty string within MAX_ITEM_LENGTH chars.
 *   - Extra fields are silently ignored.
 *   - Arrays exceeding MAX_ITEMS_PER_FIELD are truncated.
 *
 * Returns null if the object is fundamentally malformed.
 */
function validateEnrichmentOutput(raw: unknown): EnrichmentResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const FIELDS = ['questions', 'aliases', 'keywords', 'topics', 'entities', 'negative_constraints'] as const;

  const result: EnrichmentResult = {
    questions: [], aliases: [], keywords: [],
    topics: [], entities: [], negative_constraints: [],
  };

  for (const field of FIELDS) {
    const val = obj[field];
    if (!Array.isArray(val)) {
      // Missing or wrong type — treat as empty (not fatal, normalise)
      result[field] = [];
      continue;
    }
    result[field] = (val as unknown[])
      .filter((item): item is string =>
        typeof item === 'string' && item.trim().length > 0
      )
      .map(item => item.trim().slice(0, MAX_ITEM_LENGTH))
      .slice(0, MAX_ITEMS_PER_FIELD);
  }

  return result;
}

/**
 * Strip markdown code fences that Groq occasionally wraps around JSON output.
 * Handles both ```json...``` and plain ```...``` blocks.
 */
function stripMarkdownFences(text: string): string {
  // Remove leading/trailing whitespace first
  const trimmed = text.trim();
  // Match ```json or ``` at start, ``` at end
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

// ---------------------------------------------------------------------------
// Enrichment system prompt (synonym-focused, vocabulary bridging)
// ---------------------------------------------------------------------------
const GROQ_ENRICHMENT_SYSTEM_PROMPT = `You are a search metadata extractor for a customer support knowledge base.

Your ONLY job is to output a JSON object that will be used to index the given text so that users can find it even when they use informal, regional, abbreviated, or misspelled language.

Output ONLY a valid JSON object with exactly these six fields — no other text:
- "questions": 4–8 natural user questions this text answers. Include formal and informal phrasings.
- "aliases": Alternative terms, synonyms, informal phrasings, common misspellings, regional variants, and abbreviations for the key concepts. Be comprehensive — include terms a real customer might type, not just policy language. Examples: if the text mentions "liquid damage", include: water damage, water exposure, wet, submerged, dropped in water, pool, rain damage, spilled on, moisture damage. If it mentions "international shipping", include: overseas, abroad, foreign delivery, outside the country, global shipping, ship internationally.
- "keywords": Specific search terms — numbers, dates, percentages, product names, actions, named policies.
- "topics": 2–4 high-level category labels.
- "entities": Specific names, email addresses, phone numbers, URLs, or brand names mentioned.
- "negative_constraints": Things the text explicitly says are NOT covered, NOT allowed, or NOT applicable.

Rules:
1. Every item must be directly supported by the source text. Do not invent facts not present in the text.
2. Output ONLY the JSON object. No explanation, no markdown, no code fences.
3. Keep each alias short (2–6 words maximum). Quality over quantity.
4. Prefer terms a non-expert user would type in a chat box over formal policy language.`;

/**
 * Calls the Groq API (qwen/qwen3.8-27b) to extract enrichment metadata
 * for a single knowledge base chunk.
 *
 * Returns a typed EnrichmentOutcome so callers can log safe diagnostic
 * information (HTTP status, category) without ever logging the API key,
 * full prompt, document content, or full Groq response.
 *
 * Phase 1: replaces the previous Gemini implementation.
 * The function signature is intentionally identical so the queue handler
 * and tests require minimal changes.
 */
export async function enrichChunk(
  apiKey: string,
  model: string,
  content: string,
  timeoutMs: number = 10000
): Promise<EnrichmentOutcome> {
  if (!apiKey) {
    console.error('[Enrichment] Missing GROQ_API_KEY');
    return { ok: false, category: 'auth', permanent: true };
  }

  const endpoint = 'https://api.groq.com/openai/v1/chat/completions';

  const payload = {
    model,
    messages: [
      { role: 'system', content: GROQ_ENRICHMENT_SYSTEM_PROMPT },
      { role: 'user',   content: `Text:\n${content}` },
    ],
    temperature: 0.0,   // deterministic extraction
    max_tokens:  600,   // compact output to respect Groq OTPM limits
    response_format: { type: 'json_object' },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const isAbort = (err instanceof Error && err.name === 'AbortError') || controller.signal.aborted;
    if (isAbort) {
      console.error(`[Enrichment] Groq request timed out after ${timeoutMs}ms, model=${model}`);
      return { ok: false, category: 'network_error', permanent: false };
    }
    console.error(`[Enrichment] Network error calling Groq: ${String(err)}`);
    return { ok: false, category: 'network_error', permanent: false };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Categorise the failure from HTTP status alone — DO NOT log the full response body.

    if (res.status === 401 || res.status === 403) {
      // Auth errors are permanent
      console.error(`[Enrichment] Groq auth failure: HTTP ${res.status}, model=${model}`);
      return { ok: false, category: 'auth', httpStatus: res.status, permanent: true };
    } else if (res.status === 404) {
      // Model not found — permanent
      console.error(`[Enrichment] Groq model not found: HTTP ${res.status}, model=${model}`);
      return { ok: false, category: 'not_found', httpStatus: res.status, permanent: true };
    } else if (res.status === 400) {
      // Bad request — permanent (bad payload, not a transient issue)
      console.error(`[Enrichment] Groq bad request: HTTP ${res.status}, model=${model}`);
      return { ok: false, category: 'parse_error', httpStatus: res.status, permanent: true };
    } else if (res.status === 429) {
      // Rate limit (RPM/RPD/TPM/OTPM) — transient, backing off will help
      console.error(`[Enrichment] Groq rate limit: HTTP 429, model=${model}`);
      return { ok: false, category: 'rate_limit', httpStatus: 429, permanent: false };
    } else if (res.status >= 500 || res.status === 408) {
      // Server/timeout error — transient
      console.error(`[Enrichment] Groq server error: HTTP ${res.status}, model=${model}`);
      return { ok: false, category: 'server_error', httpStatus: res.status, permanent: false };
    } else {
      // Unknown status — treat as transient server error
      console.error(`[Enrichment] Groq unexpected status: HTTP ${res.status}, model=${model}`);
      return { ok: false, category: 'server_error', httpStatus: res.status, permanent: false };
    }
  }

  const data = await res.json() as any;

  // Extract content from Groq's OpenAI-compatible response format
  const rawContent: unknown = data?.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    console.error(`[Enrichment] Groq returned empty or missing content, model=${model}`);
    return { ok: false, category: 'parse_error', httpStatus: res.status, permanent: false };
  }

  // Strip markdown fences (Groq occasionally wraps output in ```json...```)
  const cleaned = stripMarkdownFences(rawContent);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error(`[Enrichment] Failed to parse Groq JSON output, model=${model}`);
    return { ok: false, category: 'parse_error', httpStatus: res.status, permanent: false };
  }

  // Strict validation — reject malformed structures
  const validated = validateEnrichmentOutput(parsed);
  if (!validated) {
    console.error(`[Enrichment] Groq output failed structural validation, model=${model}`);
    return { ok: false, category: 'parse_error', httpStatus: res.status, permanent: false };
  }

  const usage = data?.usage ? {
    prompt_tokens: Number(data.usage.prompt_tokens) || 0,
    completion_tokens: Number(data.usage.completion_tokens) || 0,
  } : undefined;

  return { ok: true, result: validated, usage };
}

// ---------------------------------------------------------------------------
// Per-message Queue handler
// ---------------------------------------------------------------------------

import type { Message } from '@cloudflare/workers-types';

/**
 * Process a batch of enrichment messages from Cloudflare Queue.
 *
 * KEY DESIGN DECISIONS:
 *
 * 1. Per-message ack/retry — a failure in one chunk does NOT affect other
 *    chunks in the same batch.
 *
 * 2. Idempotency — if knowledge_enrichment already exists for a chunkId we
 *    ack immediately without calling Groq.
 *
 * 3. Daily Budget Enforcement (C3) — before calling Groq, atomically reserve
 *    a daily ingestion call slot. Requeue with delay if limit reached.
 *
 * 4. State Machine (C2) — tracks chunk results (succeeded vs failed).
 *    Source resolves to 'completed' (100% success), 'partial' (mixed), or 'failed' (100% fail).
 */
export async function handleEnrichmentBatch(
  messages: readonly Message<EnrichmentMessage>[],
  env: {
    DB: any;
    GROQ_API_KEY: string;
    PREBASE_INGESTION_MODEL: string;
    PREBASE_ENRICH_MAX_RETRIES: string;
    PREBASE_GROQ_INGESTION_BUDGET?: string;
    PREBASE_GROQ_QWEN_DAILY_CEILING?: string;
    // Optional: inter-chunk pacing delay in ms.
    PREBASE_ENRICH_PACE_MS?: string;
    // Optional: Groq enrichment API timeout in ms. Default: 10000ms.
    PREBASE_ENRICH_TIMEOUT_MS?: string;
  }
) {
  const model = env.PREBASE_INGESTION_MODEL || 'qwen/qwen3.8-27b';
  const maxQueueAttempts = parseInt(env.PREBASE_ENRICH_MAX_RETRIES || '3', 10);
  const paceMs = parseInt(env.PREBASE_ENRICH_PACE_MS ?? '8500', 10);
  const timeoutMs = parseInt(env.PREBASE_ENRICH_TIMEOUT_MS ?? '10000', 10);

  for (let i = 0; i < messages.length; i++) {
    const queueMsg = messages[i];
    const msg = queueMsg.body;

    // ── Step 0: Idempotency check ───────────────────────────────────────────
    const existing = await env.DB.prepare(
      `SELECT chunk_id FROM knowledge_enrichment WHERE chunk_id = ?`
    ).bind(msg.chunkId).first() as { chunk_id: number } | null;

    if (existing) {
      console.log(`[Enrichment] Chunk ${msg.chunkId} already enriched — acking idempotently`);
      await maybeResolveSource(env.DB, msg.sourceId);
      queueMsg.ack();
      continue;
    }

    // ── Step 1: Mark source as processing (idempotent guard) ───────────────
    await env.DB.prepare(
      `UPDATE kb_sources SET enrichment_status = 'processing' WHERE id = ? AND enrichment_status = 'queued'`
    ).bind(msg.sourceId).run();

    // ── Step 2: Retrieve chunk content ─────────────────────────────────────
    const chunkRecord = await env.DB.prepare(
      `SELECT content FROM kb_chunks WHERE id = ? AND bot_id = ? AND source_id = ?`
    ).bind(msg.chunkId, msg.botId, msg.sourceId).first() as { content: string } | null;

    if (!chunkRecord?.content) {
      console.error(`[Enrichment] Chunk ${msg.chunkId} not found in DB — discarding stale message`);
      queueMsg.ack();
      continue;
    }

    // ── Step 3: Daily Rate Limit Budget check (C3) ──────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    // PREBASE_GROQ_INGESTION_BUDGET = PreBase's internal allocation. NOT Groq's quota.
    // PREBASE_GROQ_QWEN_DAILY_CEILING = PreBase's combined model ceiling. NOT Groq's limit.
    const ingestionBudget = Math.max(
      1,
      parseInt(env.PREBASE_GROQ_INGESTION_BUDGET || '650', 10)
    );
    const qwenCeiling = model === QWEN_CEILING_MODEL_ID
      ? Math.max(1, parseInt(env.PREBASE_GROQ_QWEN_DAILY_CEILING || '950', 10))
      : undefined;

    const reservation = await atomicReserveGroqQuota(
      env.DB,
      today,
      model,
      'ingestion',
      ingestionBudget,
      qwenCeiling
    );
    if (!reservation.allowed) {
      console.warn(
        `[Enrichment] Groq daily ingestion budget or model ceiling exhausted (${reservation.count}/${ingestionBudget}, reason=${reservation.reason}). ` +
        `Requeuing chunk ${msg.chunkId} with 1-hour delay.`
      );
      queueMsg.retry({ delaySeconds: 3600 });
      continue;
    }

    // ── Step 4: Call Groq ──────────────────────────────────────────────────
    const outcome = await enrichChunk(env.GROQ_API_KEY, model, chunkRecord.content, timeoutMs);

    // Token observability — Layer 3 advisory only (not enforcement)
    // est_* are PreBase estimates. act_* are provider-reported when available.
    if (outcome.ok) {
      const estInput = Math.ceil(chunkRecord.content.length / 4); // rough estimate
      const estOutput = 200; // enrichment output ceiling estimate
      const actInput = outcome.usage?.prompt_tokens;      // from Groq response
      const actOutput = outcome.usage?.completion_tokens; // from Groq response
      // Best-effort: failure logged, not retried
      updateGroqTokenLedger(env.DB, today, model, 'ingestion', {
        estInput,
        estOutput,
        actInput,
        actOutput,
      }).catch(e => console.warn('[Enrichment] Token ledger update failed:', e));
    }

    if (outcome.ok) {
      // ── Step 5a: Success — store enrichment ────────────────────────────
      try {
        const r = outcome.result;
        await env.DB.prepare(
          `INSERT INTO knowledge_enrichment (
             chunk_id, questions, aliases, keywords, topics, entities, negative_constraints, model, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chunk_id) DO UPDATE SET
             questions=excluded.questions,
             aliases=excluded.aliases,
             keywords=excluded.keywords,
             topics=excluded.topics,
             entities=excluded.entities,
             negative_constraints=excluded.negative_constraints,
             model=excluded.model,
             updated_at=excluded.updated_at`
        ).bind(
          msg.chunkId,
          JSON.stringify(r.questions),
          JSON.stringify(r.aliases),
          JSON.stringify(r.keywords),
          JSON.stringify(r.topics),
          JSON.stringify(r.entities),
          JSON.stringify(r.negative_constraints),
          model,
          Date.now(),
          Date.now()
        ).run();

        // Check if source can be resolved (completed or partial)
        await maybeResolveSource(env.DB, msg.sourceId);

        console.log(`[Enrichment] Chunk ${msg.chunkId} enriched OK (source ${msg.sourceId}), model=${model}`);
        queueMsg.ack();
      } catch (dbErr) {
        console.error(`[Enrichment] DB error storing chunk ${msg.chunkId} — will retry:`, dbErr);
        queueMsg.retry({ delaySeconds: 10 });
      }
    } else {
      // ── Step 5b: Groq failure ──────────────────────────────────────────
      const isPermanent = outcome.permanent || queueMsg.attempts >= maxQueueAttempts;

      console.error(
        `[Enrichment] Chunk ${msg.chunkId} failed: category=${outcome.category} ` +
        `httpStatus=${outcome.httpStatus ?? 'n/a'} attempt=${queueMsg.attempts}/${maxQueueAttempts} ` +
        `permanent=${isPermanent} model=${model}`
      );

      if (isPermanent) {
        // Track chunk failure in DB for state machine accounting
        try {
          await env.DB.prepare(
            `INSERT INTO knowledge_enrichment_failures (chunk_id, source_id, reason, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(chunk_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`
          ).bind(
            msg.chunkId,
            msg.sourceId,
            outcome.category || 'failed',
            Date.now()
          ).run();
        } catch (failErr) {
          console.error(`[Enrichment] Error recording failure for chunk ${msg.chunkId}:`, failErr);
        }

        // Check if all chunks for this source are now resolved
        await maybeResolveSource(env.DB, msg.sourceId);

        // Ack the message so it is removed from the queue
        queueMsg.ack();
      } else {
        // Transient failure — retry with exponential backoff
        let delaySeconds = 15;
        if (queueMsg.attempts >= 2) delaySeconds = 30;
        if (queueMsg.attempts >= 4) delaySeconds = 60;
        if (queueMsg.attempts >= 6) delaySeconds = 120;

        queueMsg.retry({ delaySeconds });
      }
    }

    // Only sleep between actual consecutive Groq calls within this batch.
    // Never sleep after the final message in a batch when no next request exists.
    if (i < messages.length - 1 && paceMs > 0) {
      await new Promise(resolve => setTimeout(resolve, paceMs));
    }
  }
}

/**
 * Resolves source status based on completed vs failed chunks.
 * Status values:
 *   - 'completed': 100% of chunks succeeded
 *   - 'failed': 100% of chunks permanently failed
 *   - 'partial': >0% succeeded and >0% failed, all accounted for
 * Guard: Never overwrites an already 'completed' source.
 */
export async function maybeResolveSource(DB: any, sourceId: number): Promise<void> {
  const source = await DB.prepare(
    `SELECT chunk_count, enrichment_status FROM kb_sources WHERE id = ?`
  ).bind(sourceId).first() as { chunk_count: number; enrichment_status: string } | null;

  if (!source) return;
  if (source.enrichment_status === 'completed') return;

  const totalChunks = source.chunk_count;
  if (totalChunks <= 0) {
    await DB.prepare(
      `UPDATE kb_sources SET enrichment_status = 'completed' WHERE id = ? AND enrichment_status IN ('processing', 'queued')`
    ).bind(sourceId).run();
    return;
  }

  const succeededRow = await DB.prepare(`
    SELECT COUNT(*) as cnt FROM knowledge_enrichment e
    JOIN kb_chunks c ON c.id = e.chunk_id
    WHERE c.source_id = ?
  `).bind(sourceId).first() as { cnt: number } | null;

  const failedRow = await DB.prepare(`
    SELECT COUNT(*) as cnt FROM knowledge_enrichment_failures
    WHERE source_id = ?
  `).bind(sourceId).first() as { cnt: number } | null;

  const succeededCount = succeededRow?.cnt ?? 0;
  const failedCount = failedRow?.cnt ?? 0;
  const processedTotal = succeededCount + failedCount;

  if (processedTotal >= totalChunks) {
    let finalStatus = 'partial';
    if (succeededCount === totalChunks) {
      finalStatus = 'completed';
    } else if (failedCount === totalChunks) {
      finalStatus = 'failed';
    }

    await DB.prepare(`
      UPDATE kb_sources
      SET enrichment_status = ?
      WHERE id = ? AND enrichment_status IN ('processing', 'queued', 'partial', 'failed')
    `).bind(finalStatus, sourceId).run();
  }
}
