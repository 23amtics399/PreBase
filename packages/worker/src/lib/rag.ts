import type { Bindings } from './types';
import { loadFullBotKb, type RetrievalResult } from './retrieval';
import { readGlobalAiUsage, incrementGlobalAiUsage } from './ratelimit';
import { buildPrompt } from './prompt';
import { checkPromptGuard, type GuardStatus, type GuardAction } from './prompt_guard';
import {
  extractCandidateEntities,
  findEntityInChunks,
  evaluateEntityGroundingState,
  resolveTrustedSupportContact,
  buildBoundedUnconfirmedResponse,
  type EntityEvidenceState,
} from './entity_grounding';
import {
  evaluatePolicyGrounding,
} from './policy_grounding';
import {
  isGreeting,
  extractKbTopics,
  detectShortIntent,
} from './intent_interceptor';
import {
  buildCacheKey,
  getCachedAnswer,
  setCachedAnswer,
} from './answer_cache';

export const FALLBACK_RESPONSE =
  "I couldn't find information about that in this bot's knowledge base.";

export const BLOCKED_GUARD_RESPONSE =
  "I cannot process this request.";

export const CREDENTIAL_SAFETY_RESPONSE =
  "I can't handle or use OTPs or authentication codes. Please use the account recovery process or contact support without sharing the code.";

export const GREETING_RESPONSE =
  "Hi! I'm here to help. What would you like to know?";

/** Builds a conservative short-intent clarification. Never invents policy details. */
export function buildShortIntentResponse(topic: string): string {
  return `Could you tell me a little more about what you'd like to know about ${topic}?`;
}

/**
 * Detects whether the user's input contains or attempts to submit sensitive authentication credentials,
 * one-time passwords (OTPs), verification codes, passwords, API keys, or banking PINs.
 */
export function isCredentialOrOtpInput(message: string): boolean {
  if (!message || !message.trim()) return false;

  // Check for OTP, one-time passwords, verification codes, login codes
  const otpPattern = /\b(?:otp|one[- ]?time password|verification code|security code|auth(?:entication)? code|login code)\b/i;
  if (otpPattern.test(message)) {
    // Check if accompanied by numeric codes or account actions/submission
    if (/\b\d{4,8}\b/.test(message) ||
        /\b(?:log(?:ged)? in|sign in|unlock|verify|authenticate|my email is|here is|code is|got is)\b/i.test(message)) {
      return true;
    }
  }

  // Check for direct password submission
  if (/\b(?:my password is|here is my password|account password is|password:\s*\S+)\b/i.test(message)) {
    return true;
  }

  // Check for PIN, CVV submission
  if (/\b(?:my (?:atm )?pin is|atm pin\s*[:=]?\s*\d{4,6}|cvv2?\s*[:=]?\s*\d{3,4})\b/i.test(message)) {
    return true;
  }

  // Check for API key / secret token submission
  if (/\b(?:(?:my )?api[_-]?key|secret[_-]?key|bearer token)\s*[:=]\s*\S+/i.test(message)) {
    return true;
  }

  return false;
}

/**
 * Sanitizes final answer to guarantee no markdown headers or prompt echoes leak.
 */
export function sanitizeFinalAnswer(answer: string): string {
  if (!answer) return answer;
  let clean = answer.trim();
  // Strip leading markdown headings e.g. ###, ##, #
  clean = clean.replace(/^#{1,6}\s+/, '');
  // Strip stray prompt or role echoes e.g. <USER_INPUT>, User:
  clean = clean.replace(/^(?:<USER_INPUT>|User:)\s*/i, '');
  return clean.trim();
}

export type RagStatus =
  | 'guard_blocked'            // Prompt Guard blocked the request (score > threshold)
  | 'credential_intercepted'   // Authentication code, OTP, or credential intercepted
  | 'greeting_intercepted'     // Greeting detected — no KB load, no AI
  | 'short_intent_intercepted' // Bare topic word with KB match — clarification returned
  | 'cache_hit'                // Answered from D1 answer cache — no AI call
  | 'fallback_no_kb'           // Bot has no knowledge base chunks
  | 'fallback_no_candidates'   // No relevant knowledge found (legacy — kept for compat)
  | 'fallback_ai_quota'        // global AI quota exhausted
  | 'entity_intercepted'       // entity unconfirmed, absent, or conflicting; bounded response returned
  | 'policy_intercepted'       // deterministic policy/numerical evaluation conclusive (satisfied/violated/conditional_met)
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
  /** Retrieval strategy used: 'full_kb' (whole-KB load) or legacy FTS5 modes ('and', 'or_fallback', 'none'). */
  retrievalMode: 'and' | 'or_fallback' | 'none' | 'full_kb';
  /** Retrieval Helper status: 'skipped_full_kb' on primary whole-KB path, or legacy helper status */
  helperStatus?: 'skipped_full_kb' | 'invoked' | 'unavailable' | 'none';
  /** Total number of chunks loaded from KB. */
  candidateCount: number;
  /** Number of chunks that passed to the synthesis step. */
  passedGuardCount: number;
  /** Top BM25 score — null in whole-KB mode (no BM25 ranking applied). */
  topScore: number | null;
  /** Whether the AI was actually invoked for this request. */
  aiCalled: boolean;
  /**
   * Approximate total prompt characters sent to AI synthesis model.
   * Calculated from all messages in the prompt. Null if AI was not invoked.
   */
  promptChars?: number | null;
  /**
   * Approximate input tokens sent to AI synthesis model (~4 chars/token).
   * Null if AI was not invoked.
   */
  estimatedInputTokens?: number | null;
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
  /** Candidate entity extracted from query, if any */
  candidateEntity?: string | null;
  /** Evidence state of the entity: confirmed | explicitly_excluded | conflicting | insufficient_context | mentioned_only | absent | none */
  entityGroundingState?: EntityEvidenceState;
  /** Action taken by entity grounding layer: 'proceed_to_ai' | 'intercepted' | 'none' */
  entityGroundingAction?: 'proceed_to_ai' | 'intercepted' | 'none';
  /** Policy grounding evaluation status: 'satisfied' | 'violated' | 'conditional_met' | 'explicit_negative' | 'indeterminate' | 'none' */
  policyGroundingStatus?: 'satisfied' | 'violated' | 'conditional_met' | 'explicit_negative' | 'indeterminate' | 'none';
  /** Matched policy operation, if any */
  policyOperation?: string | null;
}

export interface RagPipelineResult {
  status: number;
  answer?: string;
  error?: string;
  message?: string;
  /** Internal telemetry — NOT for inclusion in public API responses. */
  _rag: RagTelemetry;
}

/**
 * @param env           Worker environment bindings
 * @param botId         Bot UUID
 * @param systemPrompt  Owner system prompt
 * @param message       Raw user message
 * @param today         'YYYY-MM-DD' UTC date string
 * @param botUpdatedAt  bots.updated_at Unix timestamp — used as cache version key.
 *                      Must be updated by every mutation that changes effective answers.
 * @param waitUntil     Optional executionCtx.waitUntil for async cache write/cleanup.
 */
export async function executeRagPipeline(
  env: Bindings,
  botId: string,
  systemPrompt: string | undefined,
  message: string,
  today: string,
  botUpdatedAt: number = 0,
  waitUntil?: (p: Promise<unknown>) => void
): Promise<RagPipelineResult> {
  // 0. Dedicated authentication / credential / OTP safety pre-filter (runs before retrieval & AI)
  if (isCredentialOrOtpInput(message)) {
    const telemetry: RagTelemetry = {
      ragStatus: 'credential_intercepted',
      retrievalMode: 'none',
      helperStatus: 'none',
      candidateCount: 0,
      passedGuardCount: 0,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      promptChars: null,
      estimatedInputTokens: null,
      guardStatus: 'none' as any,
      guardScore: null,
      guardLatencyMs: 0,
      guardAction: 'none' as any,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: CREDENTIAL_SAFETY_RESPONSE, _rag: telemetry };
  }

  // 0b. Greeting interceptor (before KB load, before Prompt Guard)
  //     Only fires when the ENTIRE message is a greeting — not a substring.
  if (isGreeting(message)) {
    const telemetry: RagTelemetry = {
      ragStatus: 'greeting_intercepted',
      retrievalMode: 'none',
      helperStatus: 'none',
      candidateCount: 0,
      passedGuardCount: 0,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      promptChars: null,
      estimatedInputTokens: null,
      guardStatus: 'none' as any,
      guardScore: null,
      guardLatencyMs: 0,
      guardAction: 'none' as any,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: GREETING_RESPONSE, _rag: telemetry };
  }

  // 1. Prompt Guard security classifier (pre-RAG)
  const guardResult = await checkPromptGuard(env, message);
  if (guardResult.status === 'blocked') {
    const telemetry: RagTelemetry = {
      ragStatus: 'guard_blocked',
      retrievalMode: 'none',
      helperStatus: 'none',
      candidateCount: 0,
      passedGuardCount: 0,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      promptChars: null,
      estimatedInputTokens: null,
      guardStatus: 'blocked',
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: 'blocked',
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: BLOCKED_GUARD_RESPONSE, _rag: telemetry };
  }

  // 2. Load the entire bot KB (whole-KB architecture)
  //    Replaces FTS5 retrieval + relevance guard + Retrieval Helper.
  //    All chunks are loaded ordered by source then chunk index.
  //    Bot-ID scoping is enforced inside loadFullBotKb() — no cross-bot leakage.
  let allChunks: RetrievalResult[] = await loadFullBotKb(env.DB, botId);
  let relevantChunks = allChunks;
  const retrievalMode: RagTelemetry['retrievalMode'] = 'full_kb';
  const helperStatus: RagTelemetry['helperStatus'] = 'skipped_full_kb';
  const candidateCount = allChunks.length;

  // 3. Entity Grounding Safety Layer
  //    The full KB is already loaded — no secondary FTS5 lookup needed.
  //    findEntityInChunks() scans allChunks directly.
  const candidateEntities = extractCandidateEntities(message);
  let candidateEntity: string | null = null;
  let entityGroundingState: EntityEvidenceState = 'none';
  let entityGroundingAction: 'proceed_to_ai' | 'intercepted' | 'none' = 'none';

  if (candidateEntities.length > 0) {
    const primaryEntity = candidateEntities[0];
    candidateEntity = primaryEntity.name;

    // Entity is guaranteed to be found if it exists anywhere in the KB —
    // we have all chunks in memory, so no DB fallback is needed.
    const presence = findEntityInChunks(candidateEntity, allChunks);
    const effectiveChunks = allChunks;

    // Evaluate 6-state evidence priority
    const evalResult = evaluateEntityGroundingState(candidateEntity, presence, effectiveChunks);
    entityGroundingState = evalResult.state;

    if (evalResult.state === 'confirmed' || evalResult.state === 'explicitly_excluded') {
      // Entity is explicitly confirmed or excluded in KB — proceed to AI
      entityGroundingAction = 'proceed_to_ai';
    } else if (effectiveChunks.length > 0) {
      // Entity is absent, conflicting, insufficient_context, or mentioned_only
      // Deterministic interception: bypass Granite completely!
      entityGroundingAction = 'intercepted';
      const supportContact = resolveTrustedSupportContact(systemPrompt, effectiveChunks);
      const categoryChunkText = effectiveChunks.map(c => c.content).join('\n\n');
      const boundedAnswer = buildBoundedUnconfirmedResponse(
        categoryChunkText,
        candidateEntity,
        evalResult.state,
        supportContact,
        message
      );

      const telemetry: RagTelemetry = {
        ragStatus: 'entity_intercepted',
        retrievalMode,
        helperStatus,
        candidateCount,
        passedGuardCount: effectiveChunks.length,
        topScore: null,
        aiCalled: false,
        neuronsUsed: null,
        promptChars: null,
        estimatedInputTokens: null,
        guardStatus: guardResult.status,
        guardScore: guardResult.score,
        guardLatencyMs: guardResult.latencyMs,
        guardAction: guardResult.action,
        candidateEntity,
        entityGroundingState,
        entityGroundingAction,
      };
      console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
      return { status: 200, answer: sanitizeFinalAnswer(boundedAnswer), _rag: telemetry };
    }
  }

  // 3b. Short-intent detection (after KB load, uses extracted KB topics)
  //     Conservative: only intercept bare 1-2 word non-question messages with a
  //     confident KB topic match. Passes through if no confident match.
  const kbTopics = extractKbTopics(allChunks);
  const shortIntentResult = detectShortIntent(message, kbTopics);
  if (shortIntentResult.type === 'short_intent') {
    const clarification = buildShortIntentResponse(shortIntentResult.topic);
    const telemetry: RagTelemetry = {
      ragStatus: 'short_intent_intercepted',
      retrievalMode,
      helperStatus,
      candidateCount,
      passedGuardCount: 0,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      promptChars: null,
      estimatedInputTokens: null,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      candidateEntity: null,
      entityGroundingState: 'none',
      entityGroundingAction: 'none',
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: clarification, _rag: telemetry };
  }

  // 4. Empty KB fallback — bot has no knowledge base chunks
  if (relevantChunks.length === 0) {
    const telemetry: RagTelemetry = {
      ragStatus: 'fallback_no_kb',
      retrievalMode,
      helperStatus,
      candidateCount: 0,
      passedGuardCount: 0,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      promptChars: null,
      estimatedInputTokens: null,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      candidateEntity: null,
      entityGroundingState: 'none',
      entityGroundingAction: 'none',
      policyGroundingStatus: 'none',
      policyOperation: null,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: FALLBACK_RESPONSE, _rag: telemetry };
  }

  // 5. Policy Grounding Safety Layer (conservative deterministic numerical & conditional evaluation)
  const policyEval = evaluatePolicyGrounding(allChunks, message, systemPrompt);
  const policyGroundingStatus = policyEval.status;
  const policyOperation = policyEval.status !== 'indeterminate' ? policyEval.constraint.operation : null;

  if (policyEval.status !== 'indeterminate') {
    // Conclusive deterministic evaluation: bypass Granite completely!
    const telemetry: RagTelemetry = {
      ragStatus: 'policy_intercepted',
      retrievalMode,
      helperStatus,
      candidateCount,
      passedGuardCount: relevantChunks.length,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      promptChars: null,
      estimatedInputTokens: null,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      candidateEntity,
      entityGroundingState,
      entityGroundingAction,
      policyGroundingStatus,
      policyOperation,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: sanitizeFinalAnswer(policyEval.boundedAnswer), _rag: telemetry };
  }

  // 5b. Answer cache lookup (after all security & grounding gates)
  //     Cache key: botId + botUpdatedAt + sha256(normalizedMessage)
  //     Only successful ai_called answers are stored — see answer_cache.ts.
  const cacheKey = await buildCacheKey(botId, botUpdatedAt, message);
  const cachedAnswer = await getCachedAnswer(env.DB, cacheKey);
  if (cachedAnswer !== null) {
    const telemetry: RagTelemetry = {
      ragStatus: 'cache_hit',
      retrievalMode,
      helperStatus,
      candidateCount,
      passedGuardCount: relevantChunks.length,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      promptChars: null,
      estimatedInputTokens: null,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      candidateEntity,
      entityGroundingState,
      entityGroundingAction,
      policyGroundingStatus,
      policyOperation,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return { status: 200, answer: cachedAnswer, _rag: telemetry };
  }

  // 6. Global AI Quota check
  //    Returns HTTP 200 so the widget shows the fallback menu gracefully —
  //    the widget/caller inspects ragStatus === 'fallback_ai_quota' to render menu UI.
  const aiDailyLimit = Math.max(1, parseInt(env.PREBASE_AI_DAILY_LIMIT, 10) || 100);
  const currentAiCalls = await readGlobalAiUsage(env.DB, today);
  if (currentAiCalls >= aiDailyLimit) {
    const telemetry: RagTelemetry = {
      ragStatus: 'fallback_ai_quota',
      retrievalMode,
      helperStatus,
      candidateCount,
      passedGuardCount: relevantChunks.length,
      topScore: null,
      aiCalled: false,
      neuronsUsed: null,
      promptChars: null,
      estimatedInputTokens: null,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      candidateEntity,
      entityGroundingState,
      entityGroundingAction,
      policyGroundingStatus,
      policyOperation,
    };
    console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));
    return {
      status: 429,
      error: 'ai_quota_exhausted',
      message: "Today's AI limit has been reached. You can still use Quick Answers below, or contact support.",
      _rag: telemetry,
    };
  }

  // 5. Build system prompt with full KB context
  // CRITICAL INVARIANT: Granite receives ONLY original kb_chunks.content from DB.
  // Context-level operation isolation prevents outbound shipping fees from bleeding into return inquiries.
  // Relevance prioritization places query-relevant chunks first to prevent loss-in-the-middle.
  const contextChunks = prioritizeChunksForContext(
    isolateOperationContext(relevantChunks, message),
    message
  );
  const contextText = contextChunks.map(r => r.content).join('\n\n');

  const messages = buildPrompt({
    ownerInstructions: systemPrompt ?? '',
    knowledge: contextText,
    userMessage: message,
  });

  const promptChars = messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
  const estimatedInputTokens = Math.ceil(promptChars / 4);

  // 6. Call AI (Granite)
  let answer: string;
  let neuronsUsed: number | null = null;
  try {
    const response = await env.AI.run(env.PREBASE_AI_MODEL, {
      messages,
      temperature: 0.0,
      seed: 42,
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
          /\s*(?:For (?:any )?(?:further|additional|specific|more|other)?\s*(?:assistance|help|questions|information|details|inquiries|shipping options|options)[^]*?|\bTo discuss[^]*?|\bFeel free to[^]*?|\bIf you (?:have|need)[^]*?|\bPlease contact[^]*?|\bYou can contact[^]*?|\bTo initiate a return[^]*?)\s+[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^.]*\.?/gi,
          ''
        )
        .replace(/\s+(?:for (?:further |additional )?assistance|for help)\.?$/i, '.')
        .trim();
    }

    neuronsUsed = null;

    // 7. Increment global AI usage on success
    await incrementGlobalAiUsage(env.DB, today);

    // 8. Write to answer cache (fire-and-forget via waitUntil if available)
    const cacheWrite = setCachedAnswer(env.DB, cacheKey, sanitizeFinalAnswer(answer));
    if (waitUntil) {
      waitUntil(cacheWrite);
    } else {
      await cacheWrite;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[widget] AI inference failed for bot ${botId}:`, msg);

    const telemetry: RagTelemetry = {
      ragStatus: 'ai_error',
      retrievalMode,
      helperStatus,
      candidateCount,
      passedGuardCount: relevantChunks.length,
      topScore: null,
      aiCalled: true,
      neuronsUsed: null,
      promptChars,
      estimatedInputTokens,
      guardStatus: guardResult.status,
      guardScore: guardResult.score,
      guardLatencyMs: guardResult.latencyMs,
      guardAction: guardResult.action,
      candidateEntity,
      entityGroundingState,
      entityGroundingAction,
      policyGroundingStatus,
      policyOperation,
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
    helperStatus,
    candidateCount,
    passedGuardCount: relevantChunks.length,
    topScore: null,
    aiCalled: true,
    neuronsUsed,
    promptChars,
    estimatedInputTokens,
    guardStatus: guardResult.status,
    guardScore: guardResult.score,
    guardLatencyMs: guardResult.latencyMs,
    guardAction: guardResult.action,
    candidateEntity,
    entityGroundingState,
    entityGroundingAction,
    policyGroundingStatus,
    policyOperation,
  };
  console.log('[rag:telemetry]', JSON.stringify({ botId, ...telemetry }));

  return { status: 200, answer: sanitizeFinalAnswer(answer), _rag: telemetry };
}

/**
 * Isolates knowledge base context between mutually exclusive operations.
 *
 * Invariant: Forward outbound delivery/shipping policies (e.g. delivery fees,
 * new-order shipping thresholds) must NEVER bleed into reverse-logistics
 * inquiries (returns, exchanges, return shipping) unless the chunk explicitly
 * mentions returns or exchanges.
 */
export function isolateOperationContext(
  chunks: RetrievalResult[],
  message: string
): RetrievalResult[] {
  const msg = message.toLowerCase();

  // 1. Reverse logistics inquiry (returns, return shipping, exchanges, sending items back)
  const isReverseLogisticsQuery =
    /\b(?:return shipping|cost to return|fee to return|pay for return|send(?:ing)? (?:it |my (?:item|order) )?back|returns? policy|returning)\b/i.test(msg) ||
    (/\breturn(?:ing|s)?\b/i.test(msg) && /\b(?:shipping|fee|cost|charge|pay)\b/i.test(msg));

  if (isReverseLogisticsQuery) {
    // Filter out chunks that are purely about forward outbound delivery/shipping
    // (chunks that discuss outbound shipping / delivery thresholds / delivery charges
    // WITHOUT mentioning return, exchange, or reverse logistics).
    return chunks.filter(chunk => {
      const content = chunk.content.toLowerCase();
      const isOutboundShippingChunk =
        /\b(?:domestic shipping|express domestic|standard delivery time|orders? below|orders? above|shipping charge|delivery time)\b/i.test(content) &&
        !/\b(?:return|returned|returns|exchange|exchanges|reverse)\b/i.test(content);

      // If it is purely an outbound delivery chunk with no mention of returns, exclude it
      return !isOutboundShippingChunk;
    });
  }

  return chunks;
}

/**
 * Prioritizes chunks by keyword relevance to the user message while retaining
 * whole-KB context. Chunks with keyword matches appear first so that the model's
 * self-attention focuses on the most relevant policy sentences, preventing
 * loss-in-the-middle degradation on long multi-chunk KBs.
 */
export function prioritizeChunksForContext(
  chunks: RetrievalResult[],
  message: string
): RetrievalResult[] {
  const stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from',
    'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'my', 'no', 'not', 'of',
    'on', 'or', 'so', 'that', 'the', 'then', 'this', 'to', 'was', 'we', 'what',
    'when', 'where', 'which', 'who', 'will', 'with', 'would', 'you', 'your'
  ]);

  const queryTerms = message
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !stopWords.has(t));

  if (queryTerms.length === 0) return chunks;

  const scored = chunks.map((chunk, idx) => {
    const text = chunk.content.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) {
        score += 1;
      }
    }
    return { chunk, score, originalIndex: idx };
  });

  // Stable sort: higher score first, preserving original order on tie
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  return scored.map(s => s.chunk);
}
