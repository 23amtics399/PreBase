import type { Bindings } from './types';
import { FTS5Engine } from './retrieval';
import { filterByRelevance } from './guard';
import { readGlobalAiUsage, incrementGlobalAiUsage } from './ratelimit';

export const FALLBACK_RESPONSE =
  "I couldn't find information about that in this bot's knowledge base.";

const engine = new FTS5Engine();

export type RagStatus =
  | 'fallback_no_candidates'   // FTS5 returned empty
  | 'fallback_below_threshold' // candidates exist but all scored below relevance threshold
  | 'fallback_ai_quota'        // global AI quota exhausted
  | 'ai_called'                // AI inference was invoked and returned a response
  | 'ai_error';                // AI inference threw an error

/**
 * Internal telemetry collected during a RAG pipeline execution.
 * Never exposed in the public API response.
 * Visible in server logs via `wrangler tail` and available to unit tests
 * that call executeRagPipeline() directly.
 */
export interface RagTelemetry {
  ragStatus: RagStatus;
  /** FTS5 query string sent to D1 (sanitized, AND or OR joined). */
  ftsQuery: string | null;
  /** Whether the AND pass was used (true) or OR fallback was triggered (false). */
  retrievalMode: 'and' | 'or_fallback' | 'none';
  /** Number of chunks returned by FTS5 before the relevance guard. */
  candidateCount: number;
  /** Number of chunks that passed the relevance guard (score <= threshold). */
  passedGuardCount: number;
  /** BM25 score of the top candidate (more negative = stronger match). null if no candidates. */
  topScore: number | null;
  /** Whether the AI was actually invoked for this request. */
  aiCalled: boolean;
  /**
   * Neuron usage from the AI response, if exposed by Workers AI SDK.
   * Currently null — Cloudflare Workers AI does not return neuron counts in
   * the env.AI.run() response object. Use the Cloudflare dashboard for usage.
   */
  neuronsUsed: number | null;
}

export interface RagPipelineResult {
  status: number;
  answer?: string;
  error?: string;
  message?: string;
  /** Internal telemetry — NOT for inclusion in public API responses. */
  _rag: RagTelemetry;
}

export async function executeRagPipeline(
  env: Bindings,
  botId: string,
  systemPrompt: string | undefined,
  message: string,
  today: string
): Promise<RagPipelineResult> {
  // 1. FTS5 retrieval (two-pass: AND first, OR fallback)
  const charBudget = Math.max(100, parseInt(env.PREBASE_CHAR_BUDGET, 10) || 3600);
  const rawChunks = await engine.search(env.DB, botId, message, charBudget);

  // Determine what retrieval mode was used (for telemetry)
  const { sanitizeFtsQuery } = await import('./sanitize');
  const sanitized = sanitizeFtsQuery(message);
  const hadAndQuery = sanitized !== null && sanitized.includes(' AND ');
  const retrievalMode: RagTelemetry['retrievalMode'] =
    sanitized === null ? 'none' :
    rawChunks.length === 0 ? 'none' :
    hadAndQuery ? 'and' : 'or_fallback';

  const topScore = rawChunks.length > 0 ? rawChunks[0].score : null;

  if (rawChunks.length === 0) {
    const telemetry: RagTelemetry = {
      ragStatus: 'fallback_no_candidates',
      ftsQuery: sanitized,
      retrievalMode: 'none',
      candidateCount: 0,
      passedGuardCount: 0,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: FALLBACK_RESPONSE, _rag: telemetry };
  }

  // 2. Relevance guard
  const minBm25 = parseFloat(env.PREBASE_MIN_BM25_SCORE) || -0.5;
  const relevantChunks = filterByRelevance(rawChunks, minBm25);

  if (relevantChunks.length === 0) {
    const telemetry: RagTelemetry = {
      ragStatus: 'fallback_below_threshold',
      ftsQuery: sanitized,
      retrievalMode,
      candidateCount: rawChunks.length,
      passedGuardCount: 0,
      topScore,
      aiCalled: false,
      neuronsUsed: null,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: FALLBACK_RESPONSE, _rag: telemetry };
  }

  // 3. Global AI Quota
  const aiDailyLimit = Math.max(1, parseInt(env.PREBASE_AI_DAILY_LIMIT, 10) || 7954);
  const currentAiCalls = await readGlobalAiUsage(env.DB, today);
  if (currentAiCalls >= aiDailyLimit) {
    const telemetry: RagTelemetry = {
      ragStatus: 'fallback_ai_quota',
      ftsQuery: sanitized,
      retrievalMode,
      candidateCount: rawChunks.length,
      passedGuardCount: relevantChunks.length,
      topScore,
      aiCalled: false,
      neuronsUsed: null,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return {
      status: 429,
      error: 'service_unavailable',
      message: 'Service is temporarily at capacity. Please try again tomorrow.',
      _rag: telemetry,
    };
  }

  // 4. Build system prompt with retrieved context
  const contextText = relevantChunks.map(r => r.content).join('\n\n');
  const ownerInstructions = systemPrompt?.trim() ? systemPrompt.trim() : 'You are a helpful assistant.';

  const finalSystemPrompt = [
    ownerInstructions,
    '',
    'Use only the following knowledge base content to answer the user\'s question.',
    'If the answer is not clearly supported by the provided context, say:',
    '"I don\'t have information about that in this bot\'s knowledge base."',
    'Do not invent facts not present in the context below.',
    '',
    '=== Knowledge Base Context ===',
    contextText,
    '=== End of Context ===',
  ].join('\n');

  // 5. Call AI
  let answer: string;
  let neuronsUsed: number | null = null;
  try {
    const response = await env.AI.run(env.PREBASE_AI_MODEL, {
      messages: [
        { role: 'system', content: finalSystemPrompt },
        { role: 'user',   content: message },
      ],
    }) as {
      response?: string;
      choices?: Array<{ message: { content: string } }>;
      // Workers AI does not currently expose neuron counts in the run() response.
      // Token-level usage (if ever added) would appear here, but is not neurons.
    };

    answer =
      response?.response ??
      response?.choices?.[0]?.message?.content ??
      "I was unable to generate a response. Please try again.";

    neuronsUsed = null; // Not exposed by Workers AI SDK; track via Cloudflare dashboard.

    // 6. Increment global AI usage on success
    await incrementGlobalAiUsage(env.DB, today);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[widget] AI inference failed for bot ${botId}:`, msg);

    const telemetry: RagTelemetry = {
      ragStatus: 'ai_error',
      ftsQuery: sanitized,
      retrievalMode,
      candidateCount: rawChunks.length,
      passedGuardCount: relevantChunks.length,
      topScore,
      aiCalled: true,
      neuronsUsed: null,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return {
      status: 503,
      error: 'inference_error',
      message: 'The AI service encountered an error. Please try again.',
      _rag: telemetry,
    };
  }

  const telemetry: RagTelemetry = {
    ragStatus: 'ai_called',
    ftsQuery: sanitized,
    retrievalMode,
    candidateCount: rawChunks.length,
    passedGuardCount: relevantChunks.length,
    topScore,
    aiCalled: true,
    neuronsUsed,
  };
  console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));

  return { status: 200, answer, _rag: telemetry };
}
