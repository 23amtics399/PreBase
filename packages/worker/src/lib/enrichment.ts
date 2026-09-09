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
  | { ok: true; result: EnrichmentResult }
  | {
      ok: false;
      category: 'auth' | 'not_found' | 'rate_limit' | 'server_error' | 'parse_error' | 'network_error';
      httpStatus?: number;
      // permanent=true means retrying will not help
      permanent: boolean;
    };

/**
 * Calls the Gemini API using structured JSON output to extract metadata
 * for a specific knowledge base chunk.
 *
 * Returns a typed EnrichmentOutcome so callers can log safe diagnostic
 * information (HTTP status, category) without ever logging the API key,
 * full prompt, document content, or full Gemini response.
 */
export async function enrichChunk(
  apiKey: string,
  model: string,
  content: string
): Promise<EnrichmentOutcome> {
  if (!apiKey) {
    console.error('[Enrichment] Missing GEMINI_API_KEY');
    return { ok: false, category: 'auth', permanent: true };
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Structured output schema
  const schema = {
    type: "OBJECT",
    properties: {
      questions: {
        type: "ARRAY",
        description: "List of possible user questions this text answers.",
        items: { type: "STRING" }
      },
      aliases: {
        type: "ARRAY",
        description: "Alternative names, abbreviations, or acronyms found in the text.",
        items: { type: "STRING" }
      },
      keywords: {
        type: "ARRAY",
        description: "Key terms and specific identifiers from the text.",
        items: { type: "STRING" }
      },
      topics: {
        type: "ARRAY",
        description: "High-level themes or categories.",
        items: { type: "STRING" }
      },
      entities: {
        type: "ARRAY",
        description: "Names of people, organizations, places, or products.",
        items: { type: "STRING" }
      },
      negative_constraints: {
        type: "ARRAY",
        description: "Things the text explicitly says it does NOT do, or exceptions to rules.",
        items: { type: "STRING" }
      }
    },
    required: ["questions", "aliases", "keywords", "topics", "entities", "negative_constraints"]
  };

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Analyze the following text and extract metadata for search indexing. DO NOT summarize the text. Only extract the structured data requested.\n\nText:\n" + content
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1, // Low temperature for deterministic extraction
      responseMimeType: "application/json",
      responseSchema: schema
    }
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[Enrichment] Network error calling Gemini: ${String(err)}`);
    return { ok: false, category: 'network_error', permanent: false };
  }

  if (!res.ok) {
    // Categorise the failure from the HTTP status alone — DO NOT log the full response body.
    let category: 'auth' | 'not_found' | 'rate_limit' | 'server_error' | 'parse_error' | 'network_error';
    let permanent: boolean;

    if (res.status === 401 || res.status === 403) {
      category = 'auth';
      permanent = true;
    } else if (res.status === 404) {
      category = 'not_found';
      permanent = true;
    } else if (res.status === 400) {
      category = 'parse_error';
      permanent = true;
    } else if (res.status === 429) {
      category = 'rate_limit';
      permanent = false; // transient — backing off will help
    } else if (res.status >= 500 || res.status === 408) {
      category = 'server_error';
      permanent = false; // transient
    } else {
      category = 'server_error';
      permanent = false;
    }

    console.error(
      `[Enrichment] Gemini request failed: HTTP ${res.status}, category: ${category}, model: ${model}`
    );
    return { ok: false, category: category as any, httpStatus: res.status, permanent };
  }

  const data = await res.json() as any;

  // Safely extract the JSON from the Gemini response
  const candidate = data.candidates?.[0];
  if (!candidate || !candidate.content || !candidate.content.parts || !candidate.content.parts[0]?.text) {
    const finishReason = candidate?.finishReason || 'unknown';
    console.error(`[Enrichment] Unexpected Gemini response: no content, finishReason=${finishReason}, model=${model}`);
    return { ok: false, category: 'parse_error', httpStatus: res.status, permanent: false };
  }

  let parsed: EnrichmentResult;
  try {
    parsed = JSON.parse(candidate.content.parts[0].text) as EnrichmentResult;
  } catch {
    console.error(`[Enrichment] Failed to parse Gemini structured output as JSON, model=${model}`);
    return { ok: false, category: 'parse_error', httpStatus: res.status, permanent: false };
  }

  // Normalise: ensure all arrays exist even if Gemini omitted them
  return {
    ok: true,
    result: {
      questions:            Array.isArray(parsed.questions)            ? parsed.questions            : [],
      aliases:              Array.isArray(parsed.aliases)              ? parsed.aliases              : [],
      keywords:             Array.isArray(parsed.keywords)             ? parsed.keywords             : [],
      topics:               Array.isArray(parsed.topics)               ? parsed.topics               : [],
      entities:             Array.isArray(parsed.entities)             ? parsed.entities             : [],
      negative_constraints: Array.isArray(parsed.negative_constraints) ? parsed.negative_constraints : [],
    }
  };
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
 *    chunks in the same batch.  We call msg.ack() on success and msg.retry()
 *    on transient failure.  This replaces the old batch-throw pattern.
 *
 * 2. Idempotency — if knowledge_enrichment already exists for a chunkId we
 *    ack immediately without calling Gemini.  This makes Queue redeliveries
 *    safe and quota-efficient.
 *
 * 3. Permanent vs transient failures — auth (401/403) and not_found (404)
 *    errors are permanent; we ack the message and mark the source failed
 *    rather than burning retries pointlessly.
 *
 * 4. Source status correctness:
 *    - queued → processing  (first message for a source)
 *    - processing → completed  (last chunk succeeds, guarded by chunk_count)
 *    - processing → failed  (permanent failure, guarded to not overwrite 'completed')
 *    A completed source is never downgraded to failed.
 *
 * 5. Safe logging — only HTTP status codes and categories are logged.
 *    API key, document content, prompts and Gemini responses are never logged.
 */
export async function handleEnrichmentBatch(
  messages: readonly Message<EnrichmentMessage>[],
  env: {
    DB: any;
    GEMINI_API_KEY: string;
    PREBASE_GEMINI_MODEL: string;
    PREBASE_ENRICH_MAX_RETRIES: string;
  }
) {
  const model = env.PREBASE_GEMINI_MODEL || 'gemini-3.6-flash';
  const maxQueueAttempts = parseInt(env.PREBASE_ENRICH_MAX_RETRIES || '3', 10);

  for (const queueMsg of messages) {
    const msg = queueMsg.body;

    // ── Step 0: Idempotency check ───────────────────────────────────────────
    // If this chunk was already successfully enriched (e.g. duplicate delivery),
    // ack and skip — do not call Gemini again.
    const existing = await env.DB.prepare(
      `SELECT chunk_id FROM knowledge_enrichment WHERE chunk_id = ?`
    ).bind(msg.chunkId).first() as { chunk_id: number } | null;

    if (existing) {
      console.log(`[Enrichment] Chunk ${msg.chunkId} already enriched — acking idempotently`);
      // Still check if source completion was missed (e.g. the status update failed previously)
      await maybeCompleteSource(env.DB, msg.sourceId);
      queueMsg.ack();
      continue;
    }

    // ── Step 1: Mark source as processing (idempotent guard) ───────────────
    await env.DB.prepare(
      `UPDATE kb_sources SET enrichment_status = 'processing' WHERE id = ? AND enrichment_status = 'queued'`
    ).bind(msg.sourceId).run();

    // ── Step 2: Retrieve the authoritative chunk content from D1 ───────────
    const chunkRecord = await env.DB.prepare(
      `SELECT content FROM kb_chunks WHERE id = ? AND bot_id = ? AND source_id = ?`
    ).bind(msg.chunkId, msg.botId, msg.sourceId).first() as { content: string } | null;

    if (!chunkRecord?.content) {
      // Chunk doesn't exist — source was deleted or message is stale. Discard safely.
      console.error(`[Enrichment] Chunk ${msg.chunkId} not found in DB — discarding stale message`);
      queueMsg.ack();
      continue;
    }

    // ── Step 3: Call Gemini ────────────────────────────────────────────────
    const outcome = await enrichChunk(env.GEMINI_API_KEY, model, chunkRecord.content);

    if (outcome.ok) {
      // ── Step 4a: Success — store enrichment ────────────────────────────
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

        // Check if all chunks for this source are now enriched → completed.
        // Guard: only transition from 'processing' to prevent overwriting 'failed'.
        await maybeCompleteSource(env.DB, msg.sourceId);

        console.log(`[Enrichment] Chunk ${msg.chunkId} enriched OK (source ${msg.sourceId})`);
        queueMsg.ack();
      } catch (dbErr) {
        // DB write failure is transient — retry the message
        console.error(`[Enrichment] DB error storing chunk ${msg.chunkId} — will retry:`, dbErr);
        queueMsg.retry({ delaySeconds: 10 });
      }
    } else {
      // ── Step 4b: Gemini failure ────────────────────────────────────────
      const isPermanent = outcome.permanent || queueMsg.attempts >= maxQueueAttempts;

      console.error(
        `[Enrichment] Chunk ${msg.chunkId} failed: category=${outcome.category} ` +
        `httpStatus=${outcome.httpStatus ?? 'n/a'} attempt=${queueMsg.attempts}/${maxQueueAttempts} ` +
        `permanent=${isPermanent} model=${model}`
      );

      if (isPermanent) {
        // Mark source as failed — guard against overwriting 'completed'
        await env.DB.prepare(
          `UPDATE kb_sources SET enrichment_status = 'failed' WHERE id = ? AND enrichment_status = 'processing'`
        ).bind(msg.sourceId).run();
        // Ack the message so it is removed from the queue.
        queueMsg.ack();
      } else {
        // Transient failure — let Cloudflare Queue retry this message individually
        // Apply backoff: 10s, 30s, 60s
        let delaySeconds = 10;
        if (queueMsg.attempts === 2) delaySeconds = 30;
        else if (queueMsg.attempts >= 3) delaySeconds = 60;
        
        queueMsg.retry({ delaySeconds });
      }
    }
  }
}

/**
 * Mark source as 'completed' if all its chunks now have enrichment records.
 * Guard: only transitions from 'processing' to prevent overwriting 'failed'.
 */
async function maybeCompleteSource(DB: any, sourceId: number): Promise<void> {
  await DB.prepare(`
    UPDATE kb_sources
    SET enrichment_status = 'completed'
    WHERE id = ?
      AND enrichment_status = 'processing'
      AND chunk_count = (
        SELECT COUNT(*) FROM kb_chunks c
        JOIN knowledge_enrichment e ON c.id = e.chunk_id
        WHERE c.source_id = ?
      )
  `).bind(sourceId, sourceId).run();
}
