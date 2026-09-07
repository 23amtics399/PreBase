import type { Bindings } from './types';
import { FTS5Engine } from './retrieval';
import { filterByRelevance } from './guard';
import { readGlobalAiUsage, incrementGlobalAiUsage } from './ratelimit';

export const FALLBACK_RESPONSE =
  "I couldn't find information about that in this bot's knowledge base.";

const engine = new FTS5Engine();

export type RagStatus =
  | 'fallback_no_candidates'   // FTS5 returned empty
  | 'fallback_below_threshold' // candidates exist but all below relevance threshold
  | 'fallback_ai_quota'        // global AI quota exhausted
  | 'ai_called'                // AI inference was invoked
  | 'ai_error';                // AI inference threw an error

export interface RagPipelineResult {
  status: number;
  answer?: string;
  error?: string;
  message?: string;
  /** Pipeline telemetry — useful for debugging and test measurement. */
  _rag?: {
    ragStatus: RagStatus;
    candidateCount: number;
    passedGuardCount: number;
    /** bm25() score of the top candidate (more negative = stronger match). */
    topScore: number | null;
    /** Whether the AI was actually invoked for this request. */
    aiCalled: boolean;
    /**
     * Neuron usage from the AI response, if the field is present.
     * Workers AI currently does not expose neuron counts in the run() response
     * object — the value will be null until Cloudflare adds this to the SDK.
     * Use the Cloudflare dashboard for authoritative usage metrics.
     */
    neuronsUsed: number | null;
  };
}

export async function executeRagPipeline(
  env: Bindings,
  botId: string,
  systemPrompt: string | undefined,
  message: string,
  today: string
): Promise<RagPipelineResult> {
  // 1. FTS5 retrieval (two-pass: AND then OR fallback)
  const charBudget = Math.max(100, parseInt(env.PREBASE_CHAR_BUDGET, 10) || 3600);
  const rawChunks = await engine.search(env.DB, botId, message, charBudget);

  if (rawChunks.length === 0) {
    return {
      status: 200,
      answer: FALLBACK_RESPONSE,
      _rag: { ragStatus: 'fallback_no_candidates', candidateCount: 0, passedGuardCount: 0, topScore: null, aiCalled: false, neuronsUsed: null },
    };
  }

  // 2. Relevance guard
  const minBm25 = parseFloat(env.PREBASE_MIN_BM25_SCORE) || -0.5;
  const relevantChunks = filterByRelevance(rawChunks, minBm25);
  const topScore = rawChunks[0]?.score ?? null;

  if (relevantChunks.length === 0) {
    return {
      status: 200,
      answer: FALLBACK_RESPONSE,
      _rag: { ragStatus: 'fallback_below_threshold', candidateCount: rawChunks.length, passedGuardCount: 0, topScore, aiCalled: false, neuronsUsed: null },
    };
  }

  // 3. Global AI Quota
  const aiDailyLimit = Math.max(1, parseInt(env.PREBASE_AI_DAILY_LIMIT, 10) || 7954);
  const currentAiCalls = await readGlobalAiUsage(env.DB, today);
  if (currentAiCalls >= aiDailyLimit) {
    return {
      status: 429,
      error: 'service_unavailable',
      message: 'Service is temporarily at capacity. Please try again tomorrow.',
      _rag: { ragStatus: 'fallback_ai_quota', candidateCount: rawChunks.length, passedGuardCount: relevantChunks.length, topScore, aiCalled: false, neuronsUsed: null },
    };
  }

  // 4. Build system prompt
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
    }) as { response?: string; choices?: Array<{ message: { content: string } }>; usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } };

    answer =
      response?.response ??
      response?.choices?.[0]?.message?.content ??
      "I was unable to generate a response. Please try again.";

    // Workers AI does not currently expose neuron counts in the run() response.
    // If Cloudflare adds a usage field in future, extract it here.
    // For now, this remains null — use the Cloudflare dashboard for billing metrics.
    neuronsUsed = null; // response?.usage is token-level if present, not neurons

    // 6. Increment global AI usage on success
    await incrementGlobalAiUsage(env.DB, today);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[widget] AI inference failed for bot ${botId}:`, msg);
    return {
      status: 503,
      error: 'inference_error',
      message: 'The AI service encountered an error. Please try again.',
      _rag: { ragStatus: 'ai_error', candidateCount: rawChunks.length, passedGuardCount: relevantChunks.length, topScore, aiCalled: true, neuronsUsed: null },
    };
  }

  return {
    status: 200,
    answer,
    _rag: { ragStatus: 'ai_called', candidateCount: rawChunks.length, passedGuardCount: relevantChunks.length, topScore, aiCalled: true, neuronsUsed },
  };
}
