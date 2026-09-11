import type { Bindings } from './types';
import { FTS5Engine, type RetrievalResult } from './retrieval';
import { filterByRelevance } from './guard';
import { readGlobalAiUsage, incrementGlobalAiUsage } from './ratelimit';
import { buildPrompt } from './prompt';
import { checkPromptGuard, type GuardStatus, type GuardAction } from './prompt_guard';
import { generateAlternativeQueries, type HelperStatus } from './retrieval_helper';
import {
  extractCandidateEntities,
  findEntityInChunks,
  searchFullBotKbForEntity,
  evaluateEntityGroundingState,
  resolveTrustedSupportContact,
  buildBoundedUnconfirmedResponse,
  mergeRecoveredChunks,
  type EntityEvidenceState,
} from './entity_grounding';

export const FALLBACK_RESPONSE =
  "I couldn't find information about that in this bot's knowledge base.";

export const BLOCKED_GUARD_RESPONSE =
  "I cannot process this request.";

const engine = new FTS5Engine();

export type RagStatus =
  | 'guard_blocked'            // Prompt Guard blocked the request (score > threshold)
  | 'fallback_no_candidates'   // FTS5 returned empty
  | 'fallback_below_threshold' // candidates exist but all scored below relevance threshold
  | 'fallback_ai_quota'        // global AI quota exhausted
  | 'entity_intercepted'       // entity unconfirmed, absent, or conflicting; bounded response returned
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
  /** Prompt Guard status: 'passed' | 'blocked' | 'unavailable' */
  guardStatus: GuardStatus;
  /** Prompt Guard probability score (0.0 to 1.0) or null if unavailable */
  guardScore: number | null;
  /** Prompt Guard execution latency in ms */
  guardLatencyMs: number;
  /** Prompt Guard action taken: 'passed' | 'blocked' | 'fallback_to_t0' */
  guardAction: GuardAction;
  /** Whether Groq Retrieval Helper was invoked */
  helperInvoked: boolean;
  /** Retrieval Helper status: 'skipped_strong_match' | 'success' | 'budget_exhausted' | 'unavailable' | 'validation_failed' | 'none' */
  helperStatus: HelperStatus | 'none';
  /** Retrieval Helper execution latency in ms */
  helperLatencyMs: number;
  /** Whether Retrieval Helper returned valid, parsed JSON */
  helperParseOk: boolean;
  /** Candidate entity extracted from query, if any */
  candidateEntity?: string | null;
  /** Evidence state of the entity: confirmed | explicitly_excluded | conflicting | insufficient_context | mentioned_only | absent | none */
  entityGroundingState?: EntityEvidenceState;
  /** Whether the entity chunk was absent from initial retrieval and recovered from full KB */
  entityRecoveredFromFullKb?: boolean;
  /** Action taken by entity grounding layer: 'proceed_to_ai' | 'intercepted' | 'none' */
  entityGroundingAction?: 'proceed_to_ai' | 'intercepted' | 'none';
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
  // 1. Prompt Guard security classifier (pre-RAG)
  const guardResult = await checkPromptGuard(env, message);
  if (guardResult.status === 'blocked') {
    const telemetry: RagTelemetry = {
      ragStatus: 'guard_blocked',
      retrievalMode: 'none',
      candidateCount: 0,
      passedGuardCount: 0,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      guardStatus: 'blocked',
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: 'blocked',
      helperInvoked: false,
      helperStatus: 'none',
      helperLatencyMs: 0,
      helperParseOk: false,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: BLOCKED_GUARD_RESPONSE, _rag: telemetry };
  }

  // 2. First-pass FTS5 retrieval (AND-first, OR-fallback)
  const charBudget = Math.max(100, parseInt(env.PREBASE_CHAR_BUDGET, 10) || 3600);
  const searchResult = await engine.search(env.DB, botId, message, charBudget);
  const rawChunks: RetrievalResult[] = Array.isArray(searchResult) ? searchResult : ((searchResult as any)?.results ?? []);
  let retrievalMode: RagTelemetry['retrievalMode'] =
    (searchResult as any)?.mode ?? (rawChunks.length > 0 ? 'and' : 'none');

  let topScore = rawChunks.length > 0 ? rawChunks[0].score : null;

  // 3. First-pass BM25 relevance guard
  const minBm25 = parseFloat(env.PREBASE_MIN_BM25_SCORE) || -0.5;
  let relevantChunks = filterByRelevance(rawChunks, minBm25);

  let helperInvoked = false;
  let helperStatus: HelperStatus | 'none' = 'none';
  let helperLatencyMs = 0;
  let helperParseOk = false;
  let candidateCount = rawChunks.length;

  // 4. Strong match check vs Weak/No-match recovery
  if (relevantChunks.length === 0) {
    // Weak candidate (rawChunks > 0 but all failed relevance guard) OR no candidate (rawChunks === 0)
    // Invoke Retrieval Helper to generate search vocabulary
    helperInvoked = true;
    const helperResult = await generateAlternativeQueries(env, message, today);
    helperStatus = helperResult.status;
    helperLatencyMs = helperResult.latencyMs;
    helperParseOk = helperResult.parseOk;

    if (helperResult.status === 'success' && helperResult.output) {
      // Execute second-pass FTS5 search using validated vocabulary terms
      // Strict botId scoping and AND-first / OR-fallback preserved via engine.search()
      const candidateMap = new Map<string, RetrievalResult>();

      // Search each alternative query with strict AND-matching (no loose OR-fallback)
      for (const q of helperResult.output.queries) {
        const qChunks = await engine.search(env.DB, botId, q, charBudget, false);
        for (const chunk of qChunks) {
          const key = `${chunk.sourceFilename}:${chunk.chunkIndex}`;
          const existing = candidateMap.get(key);
          if (!existing || chunk.score < existing.score) {
            candidateMap.set(key, chunk);
          }
        }
      }

      // If queries yielded no candidates, search keywords (filtering out generic filler unless in user message)
      if (candidateMap.size === 0 && helperResult.output.keywords.length > 0) {
        const lowerMsg = message.toLowerCase();
        const GENERIC_FILLER = ['support', 'customer', 'store', 'help', 'faq', 'information', 'policy', 'service', 'contact'];
        const safeKeywords = helperResult.output.keywords.filter(kw => {
          const lowerKw = kw.toLowerCase().trim();
          if (GENERIC_FILLER.includes(lowerKw) && !lowerMsg.includes(lowerKw)) {
            return false;
          }
          return true;
        });

        if (safeKeywords.length > 0) {
          const kwQuery = safeKeywords.join(' ');
          const kwChunks = await engine.search(env.DB, botId, kwQuery, charBudget, false);
          for (const chunk of kwChunks) {
            const key = `${chunk.sourceFilename}:${chunk.chunkIndex}`;
            const existing = candidateMap.get(key);
            if (!existing || chunk.score < existing.score) {
              candidateMap.set(key, chunk);
            }
          }
        }
      }

      if (candidateMap.size > 0) {
        // Sort all unique second-pass candidates by score ASC (more negative = stronger)
        const sortedSecondCandidates = Array.from(candidateMap.values()).sort((a, b) => a.score - b.score);

        // Accumulate within character budget
        let usedChars = 0;
        const budgetedSecondChunks: RetrievalResult[] = [];
        for (const chunk of sortedSecondCandidates) {
          if (usedChars + chunk.content.length > charBudget) break;
          budgetedSecondChunks.push(chunk);
          usedChars += chunk.content.length;
        }

        // Apply authoritative BM25 relevance guard AGAIN
        const secondRelevant = filterByRelevance(budgetedSecondChunks, minBm25);
        if (secondRelevant.length > 0) {
          relevantChunks = secondRelevant;
          candidateCount = budgetedSecondChunks.length;
          topScore = secondRelevant[0].score;
          retrievalMode = 'or_fallback';
        }
      }
    }
  } else {
    helperStatus = 'skipped_strong_match';
  }

  // 5. Entity Grounding Safety Layer & Full-KB Authoritative Recovery
  const candidateEntities = extractCandidateEntities(message);
  let candidateEntity: string | null = null;
  let entityGroundingState: EntityEvidenceState = 'none';
  let entityRecoveredFromFullKb = false;
  let entityGroundingAction: 'proceed_to_ai' | 'intercepted' | 'none' = 'none';

  if (candidateEntities.length > 0) {
    const primaryEntity = candidateEntities[0];
    candidateEntity = primaryEntity.name;

    // Check presence in initially retrieved chunks
    let presence = findEntityInChunks(candidateEntity, relevantChunks);
    let effectiveChunks = [...relevantChunks];

    // If absent from initial retrieval, search full bot KB in D1 (strictly bot-scoped, BM25 <= minBm25)
    if (!presence.found) {
      const recovered = await searchFullBotKbForEntity(env.DB, botId, candidateEntity, minBm25, 1);
      if (recovered.length > 0) {
        entityRecoveredFromFullKb = true;
        presence = { found: true, matchingChunk: recovered[0] };
        effectiveChunks = mergeRecoveredChunks(relevantChunks, recovered, charBudget);
      }
    }

    // Evaluate 6-state evidence priority
    const evalResult = evaluateEntityGroundingState(candidateEntity, presence, effectiveChunks);
    entityGroundingState = evalResult.state;

    if (evalResult.state === 'confirmed' || evalResult.state === 'explicitly_excluded') {
      // Entity is explicitly confirmed or explicitly excluded in authoritative KB
      // Proceed to AI with effectiveChunks (which includes recovered chunk if recovered from full KB)
      relevantChunks = effectiveChunks;
      entityGroundingAction = 'proceed_to_ai';
    } else if (effectiveChunks.length > 0) {
      // Entity is absent, conflicting, insufficient_context, or mentioned_only in existing context
      // Deterministic interception: bypass Granite completely!
      entityGroundingAction = 'intercepted';
      const supportContact = resolveTrustedSupportContact(systemPrompt, effectiveChunks);
      const categoryChunkText = effectiveChunks[0]?.content ?? '';
      const boundedAnswer = buildBoundedUnconfirmedResponse(
        categoryChunkText,
        candidateEntity,
        evalResult.state,
        supportContact
      );

      const telemetry: RagTelemetry = {
        ragStatus: 'entity_intercepted',
        retrievalMode,
        candidateCount,
        passedGuardCount: effectiveChunks.length,
        topScore,
        aiCalled: false,
        neuronsUsed: null,
        guardStatus: guardResult.status,
        guardScore: guardResult.score,
        guardLatencyMs: guardResult.latencyMs,
        guardAction: guardResult.action,
        helperInvoked,
        helperStatus,
        helperLatencyMs,
        helperParseOk,
        candidateEntity,
        entityGroundingState,
        entityRecoveredFromFullKb,
        entityGroundingAction,
      };
      console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
      return { status: 200, answer: boundedAnswer, _rag: telemetry };
    }
  }

  // 6. If still no relevant chunks after both passes and no candidate entity interception, return deterministic fallback
  if (relevantChunks.length === 0) {
    const ragStatus: RagStatus =
      candidateCount === 0 ? 'fallback_no_candidates' : 'fallback_below_threshold';
    const telemetry: RagTelemetry = {
      ragStatus,
      retrievalMode: candidateCount === 0 ? 'none' : retrievalMode,
      candidateCount,
      passedGuardCount: 0,
      topScore,
      aiCalled: false,
      neuronsUsed: null,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      helperInvoked,
      helperStatus,
      helperLatencyMs,
      helperParseOk,
      candidateEntity: null,
      entityGroundingState: 'none',
      entityRecoveredFromFullKb: false,
      entityGroundingAction: 'none',
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: FALLBACK_RESPONSE, _rag: telemetry };
  }

  // 7. Global AI Quota check
  const aiDailyLimit = Math.max(1, parseInt(env.PREBASE_AI_DAILY_LIMIT, 10) || 7954);
  const currentAiCalls = await readGlobalAiUsage(env.DB, today);
  if (currentAiCalls >= aiDailyLimit) {
    const telemetry: RagTelemetry = {
      ragStatus: 'fallback_ai_quota',
      retrievalMode,
      candidateCount,
      passedGuardCount: relevantChunks.length,
      topScore,
      aiCalled: false,
      neuronsUsed: null,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      helperInvoked,
      helperStatus,
      helperLatencyMs,
      helperParseOk,
      candidateEntity,
      entityGroundingState,
      entityRecoveredFromFullKb,
      entityGroundingAction,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return {
      status: 429,
      error: 'service_unavailable',
      message: 'Service is temporarily at capacity. Please try again tomorrow.',
      _rag: telemetry,
    };
  }

  // 8. Build system prompt with retrieved context
  // CRITICAL INVARIANT: Granite receives ONLY original kb_chunks.content from DB
  // Helper output NEVER reaches Granite!
  const contextText = relevantChunks.map(r => r.content).join('\n\n');

  const messages = buildPrompt({
    ownerInstructions: systemPrompt ?? '',
    knowledge: contextText,
    userMessage: message,
  });

  // 9. Call AI (Granite)
  let answer: string;
  let neuronsUsed: number | null = null;
  try {
    const response = await env.AI.run(env.PREBASE_AI_MODEL, {
      messages,
    }) as {
      response?: string;
      choices?: Array<{ message: { content: string } }>;
    };

    answer =
      response?.response ??
      response?.choices?.[0]?.message?.content ??
      "I was unable to generate a response. Please try again.";

    // Defensive cleanup: remove any leading prompt echo from model output
    const trimmedMsg = message.trim();
    if (trimmedMsg && answer.toLowerCase().startsWith(trimmedMsg.toLowerCase())) {
      answer = answer.slice(trimmedMsg.length).replace(/^[\s:?.-]+/, '').trim();
    }
    // Also remove rhetorical opening question echoing the user inquiry (e.g., "Do we ship internationally?", "Do you ship specifically to Germany?")
    const firstQMark = answer.indexOf('?');
    if (firstQMark !== -1 && firstQMark < 100) {
      const candidateQuestion = answer.slice(0, firstQMark + 1).trim();
      if (/^(do|is|are|can|what|where|how|why|when|will|would|could|should)\b/i.test(candidateQuestion)) {
        answer = answer.slice(firstQMark + 1).replace(/^[\s:?.-]+/, '').trim();
      }
    }

    // Defensive cleanup: remove unsolicited closing support offers on direct answers
    if (candidateEntity === null || entityGroundingState === 'confirmed') {
      answer = answer
        .replace(
          /\s*(?:For (?:any )?(?:further|additional|specific|more|other)?\s*(?:assistance|help|questions|information|details|inquiries|shipping options|options)[^]*?|\bTo discuss[^]*?|\bFeel free to[^]*?|\bIf you (?:have|need)[^]*?|\bPlease contact[^]*?|\bYou can contact[^]*?|\bTo initiate a return[^]*?)\s+[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\.?/gi,
          ''
        )
        .trim();
    }

    neuronsUsed = null;

    // 10. Increment global AI usage on success
    await incrementGlobalAiUsage(env.DB, today);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[widget] AI inference failed for bot ${botId}:`, msg);

    const telemetry: RagTelemetry = {
      ragStatus: 'ai_error',
      retrievalMode,
      candidateCount,
      passedGuardCount: relevantChunks.length,
      topScore,
      aiCalled: true,
      neuronsUsed: null,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      helperInvoked,
      helperStatus,
      helperLatencyMs,
      helperParseOk,
      candidateEntity,
      entityGroundingState,
      entityRecoveredFromFullKb,
      entityGroundingAction,
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
    retrievalMode,
    candidateCount,
    passedGuardCount: relevantChunks.length,
    topScore,
    aiCalled: true,
    neuronsUsed,
    guardStatus: guardResult.status,
    guardScore: guardResult.score,
    guardLatencyMs: guardResult.latencyMs,
    guardAction: guardResult.action,
    helperInvoked,
    helperStatus,
    helperLatencyMs,
    helperParseOk,
    candidateEntity,
    entityGroundingState,
    entityRecoveredFromFullKb,
    entityGroundingAction,
  };
  console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));

  return { status: 200, answer, _rag: telemetry };
  console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));

  return { status: 200, answer, _rag: telemetry };
}
