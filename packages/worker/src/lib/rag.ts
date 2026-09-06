import type { Bindings } from './types';
import { FTS5Engine } from './retrieval';
import { filterByRelevance } from './guard';
import { readGlobalAiUsage, incrementGlobalAiUsage } from './ratelimit';

export const FALLBACK_RESPONSE =
  "I couldn't find information about that in this bot's knowledge base.";

const engine = new FTS5Engine();

export async function executeRagPipeline(
  env: Bindings,
  botId: string,
  systemPrompt: string | undefined,
  message: string,
  today: string
): Promise<{ status: number; answer?: string; error?: string; message?: string }> {
  // 1. FTS5 retrieval
  const charBudget = Math.max(100, parseInt(env.PREBASE_CHAR_BUDGET, 10) || 3600);
  const rawChunks = await engine.search(env.DB, botId, message, charBudget);

  if (rawChunks.length === 0) {
    return { status: 200, answer: FALLBACK_RESPONSE };
  }

  // 2. Relevance guard
  const minBm25 = parseFloat(env.PREBASE_MIN_BM25_SCORE) || -0.5;
  const relevantChunks = filterByRelevance(rawChunks, minBm25);

  if (relevantChunks.length === 0) {
    return { status: 200, answer: FALLBACK_RESPONSE };
  }

  // 3. Global AI Quota
  const aiDailyLimit = Math.max(1, parseInt(env.PREBASE_AI_DAILY_LIMIT, 10) || 7954);
  const currentAiCalls = await readGlobalAiUsage(env.DB, today);
  if (currentAiCalls >= aiDailyLimit) {
    return { status: 429, error: 'service_unavailable', message: 'Service is temporarily at capacity. Please try again tomorrow.' };
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
  try {
    const response = await env.AI.run(env.PREBASE_AI_MODEL, {
      messages: [
        { role: 'system', content: finalSystemPrompt },
        { role: 'user',   content: message },
      ],
    }) as { response?: string; choices?: Array<{ message: { content: string } }> };

    answer =
      response?.response ??
      response?.choices?.[0]?.message?.content ??
      "I was unable to generate a response. Please try again.";

    // 6. Increment global AI usage on success
    await incrementGlobalAiUsage(env.DB, today);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[widget] AI inference failed for bot ${botId}:`, msg);
    return { status: 503, error: 'inference_error', message: 'The AI service encountered an error. Please try again.' };
  }

  return { status: 200, answer };
}
