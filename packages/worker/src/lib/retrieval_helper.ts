import type { Bindings } from './types';
import { atomicReserveGroqQuota, updateGroqTokenLedger } from './ratelimit';
import { QWEN_CEILING_MODEL_ID } from './provider_config';

export interface HelperOutput {
  queries: string[];
  keywords: string[];
}

export type HelperStatus =
  | 'skipped_strong_match'
  | 'success'
  | 'budget_exhausted'
  | 'unavailable'
  | 'validation_failed';

export interface RetrievalHelperResult {
  invoked: boolean;
  status: HelperStatus;
  output: HelperOutput | null;
  latencyMs: number;
  parseOk: boolean;
  errorCategory?: string;
}

const HELPER_MODEL = 'qwen/qwen3.8-27b';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const HELPER_TIMEOUT_MS = 2500;
const DEFAULT_RUNTIME_BUDGET = 300;

const HELPER_SYSTEM_PROMPT = `You are a search query expansion assistant.
Your job is to transform the user's inquiry into alternative search queries and vocabulary terms that preserve the exact intent and domain of the inquiry.

RULES:
1. Output ONLY a valid JSON object with exactly two keys: "queries" and "keywords".
2. "queries": Array of 2 to 4 concise alternative search phrasings (synonyms, technical/policy equivalents, translated terms, or corrected spellings).
3. "keywords": Array of 3 to 8 individual search keywords or short keyphrases directly related to the user's inquiry.
4. NEVER attempt to answer the user's question.
5. NEVER invent facts, dates, warranty periods, or policy details.
6. NEVER summarize or provide conversational text.
7. NEVER invent generic store or customer support keywords (such as "support", "help", "customer", "store", "FAQ", "policy", "information") unless the user explicitly asks about them. Strictly preserve the specific topic of the inquiry.
8. Output strictly raw JSON.`;

// Blacklisted tokens for strict security validation against malicious helper output
const INJECTION_PATTERNS = [
  /<system\b/i,
  /<\/system>/i,
  /<bot_owner_instructions\b/i,
  /<\/bot_owner_instructions>/i,
  /<untrusted_knowledge\b/i,
  /<\/untrusted_knowledge>/i,
  /<user_input\b/i,
  /<\/user_input>/i,
  /ignore\s+(all\s+)?(previous\s+)?instructions/i,
  /disregard\s+(all\s+)?(previous\s+)?instructions/i,
  /system\s+prompt/i,
  /reveal\s+.*prompt/i,
  /you\s+are\s+now\b/i,
  /dan\s+mode/i,
  /jailbreak/i,
];

// Patterns detecting attempts to answer the question directly rather than generating search vocabulary
const ANSWER_PATTERNS = [
  /^(yes|no|sorry|unfortunately|sure|certainly|here is|here are|based on|according to)\b/i,
  /\b(lasts?|valid for)\s+\d+\s+(days?|months?|years?)\b/i,
  /^(the|our)\s+(warranty|policy|guarantee|refund)\s+(is|covers|does not cover|lasts|provides|expires)\b/i,
  /\bwe\s+(do not|cannot|can|will|offer|provide)\s+/i,
];

/**
 * Strips a single surrounding markdown JSON code block fence (```json ... ```).
 */
export function stripMarkdownFences(raw: string): string {
  const cleaned = raw.trim();
  const match = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (match) {
    return match[1].trim();
  }
  return cleaned;
}

/**
 * Validates untrusted output from the retrieval helper.
 * Enforces schema integrity, bounds, and security invariants.
 */
export function validateHelperOutput(rawText: string): { valid: true; data: HelperOutput } | { valid: false; reason: string } {
  const cleaned = stripMarkdownFences(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { valid: false, reason: 'json_parse_error' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, reason: 'not_an_object' };
  }

  const obj = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['queries', 'keywords']);
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.has(k)) {
      return { valid: false, reason: `unexpected_field_${k}` };
    }
  }

  if (!Array.isArray(obj.queries) || !Array.isArray(obj.keywords)) {
    return { valid: false, reason: 'fields_must_be_arrays' };
  }

  // Enforce item counts: 1..5 queries, 1..10 keywords
  if (obj.queries.length === 0 && obj.keywords.length === 0) {
    return { valid: false, reason: 'empty_output' };
  }
  if (obj.queries.length > 5) {
    return { valid: false, reason: 'too_many_queries' };
  }
  if (obj.keywords.length > 10) {
    return { valid: false, reason: 'too_many_keywords' };
  }

  // Validate queries
  const validatedQueries: string[] = [];
  for (const q of obj.queries) {
    if (typeof q !== 'string') return { valid: false, reason: 'query_not_string' };
    const trimmed = q.trim();
    if (trimmed.length < 2 || trimmed.length > 100) return { valid: false, reason: 'query_length_out_of_bounds' };

    // Security check: reject injection attempts
    for (const pat of INJECTION_PATTERNS) {
      if (pat.test(trimmed)) {
        return { valid: false, reason: 'malicious_content_in_query' };
      }
    }

    // Security check: reject attempts to answer rather than generate vocabulary
    for (const pat of ANSWER_PATTERNS) {
      if (pat.test(trimmed)) {
        return { valid: false, reason: 'conversational_answer_in_query' };
      }
    }
    validatedQueries.push(trimmed);
  }

  // Validate keywords
  const validatedKeywords: string[] = [];
  for (const kw of obj.keywords) {
    if (typeof kw !== 'string') return { valid: false, reason: 'keyword_not_string' };
    const trimmed = kw.trim();
    if (trimmed.length < 1 || trimmed.length > 40) return { valid: false, reason: 'keyword_length_out_of_bounds' };

    // Security check: reject injection attempts
    for (const pat of INJECTION_PATTERNS) {
      if (pat.test(trimmed)) {
        return { valid: false, reason: 'malicious_content_in_keyword' };
      }
    }

    // Security check: reject attempts to answer rather than generate vocabulary
    for (const pat of ANSWER_PATTERNS) {
      if (pat.test(trimmed)) {
        return { valid: false, reason: 'conversational_answer_in_keyword' };
      }
    }
    validatedKeywords.push(trimmed);
  }

  return {
    valid: true,
    data: {
      queries: validatedQueries,
      keywords: validatedKeywords,
    },
  };
}

/**
 * Invokes Groq qwen/qwen3.8-27b as an untrusted search vocabulary generator.
 * Protected by D1 atomic runtime daily rate limit (PREBASE_GROQ_RUNTIME_BUDGET).
 */
export async function generateAlternativeQueries(
  env: Bindings,
  userMessage: string,
  today: string
): Promise<RetrievalHelperResult> {
  const startTime = Date.now();

  if (!env.GROQ_API_KEY) {
    const res: RetrievalHelperResult = {
      invoked: true,
      status: 'unavailable',
      output: null,
      latencyMs: 0,
      parseOk: false,
      errorCategory: 'missing_key',
    };
    logHelperTelemetry(res);
    return res;
  }

  // 1. Check & reserve atomic daily runtime quota in D1
  const runtimeBudget = Math.max(
    1,
    parseInt(env.PREBASE_GROQ_RUNTIME_BUDGET || '', 10) || DEFAULT_RUNTIME_BUDGET
  );
  // PREBASE_GROQ_RUNTIME_BUDGET = PreBase's internal allocation. NOT Groq's quota.
  // PREBASE_GROQ_QWEN_DAILY_CEILING = PreBase's combined ceiling. NOT Groq's limit.
  const qwenCeiling = HELPER_MODEL === QWEN_CEILING_MODEL_ID
    ? Math.max(1, parseInt(env.PREBASE_GROQ_QWEN_DAILY_CEILING || '950', 10))
    : undefined;

  const reservation = await atomicReserveGroqQuota(
    env.DB,
    today,
    HELPER_MODEL,
    'runtime',
    runtimeBudget,
    qwenCeiling
  );
  if (!reservation.allowed) {
    const res: RetrievalHelperResult = {
      invoked: true,
      status: 'budget_exhausted',
      output: null,
      latencyMs: Date.now() - startTime,
      parseOk: false,
      errorCategory: reservation.reason === 'model_ceiling' ? 'model_ceiling_exhausted' : 'budget_exhausted',
    };
    logHelperTelemetry(res);
    return res;
  }

  // 2. Call Groq API with 2500ms timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HELPER_TIMEOUT_MS);

  try {
    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: HELPER_MODEL,
        messages: [
          { role: 'system', content: HELPER_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 256,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (response.status === 429) {
      const res: RetrievalHelperResult = {
        invoked: true,
        status: 'unavailable',
        output: null,
        latencyMs,
        parseOk: false,
        errorCategory: 'rate_limit',
      };
      logHelperTelemetry(res);
      return res;
    }

    if (!response.ok) {
      const res: RetrievalHelperResult = {
        invoked: true,
        status: 'unavailable',
        output: null,
        latencyMs,
        parseOk: false,
        errorCategory: `http_${response.status}`,
      };
      logHelperTelemetry(res);
      return res;
    }

    const data = (await response.json()) as any;
    const rawContent = data?.choices?.[0]?.message?.content ?? '';

    // Token observability (Layer 3 advisory — not enforcement)
    const responseUsage = data?.usage;
    updateGroqTokenLedger(env.DB, today, HELPER_MODEL, 'runtime', {
      estInput: Math.ceil(userMessage.length / 4),
      estOutput: 256, // max_tokens for this call
      actInput: responseUsage?.prompt_tokens ? Number(responseUsage.prompt_tokens) : undefined,
      actOutput: responseUsage?.completion_tokens ? Number(responseUsage.completion_tokens) : undefined,
    }).catch(e => console.warn('[RetrievalHelper] Token ledger update failed:', e));

    // 3. Strict schema and security validation
    const validation = validateHelperOutput(rawContent);
    if (!validation.valid) {
      const res: RetrievalHelperResult = {
        invoked: true,
        status: 'validation_failed',
        output: null,
        latencyMs,
        parseOk: false,
        errorCategory: validation.reason,
      };
      logHelperTelemetry(res);
      return res;
    }

    const res: RetrievalHelperResult = {
      invoked: true,
      status: 'success',
      output: validation.data,
      latencyMs,
      parseOk: true,
    };
    logHelperTelemetry(res);
    return res;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isTimeout =
      (err instanceof Error && err.name === 'AbortError') ||
      (typeof err === 'object' && err !== null && (err as any).name === 'AbortError');

    const res: RetrievalHelperResult = {
      invoked: true,
      status: 'unavailable',
      output: null,
      latencyMs,
      parseOk: false,
      errorCategory: isTimeout ? 'timeout' : 'network_error',
    };
    logHelperTelemetry(res);
    return res;
  }
}

/**
 * Emits privacy-safe server telemetry.
 * Strictly avoids logging user messages, helper text, or IP addresses.
 */
function logHelperTelemetry(result: RetrievalHelperResult): void {
  console.log(
    '[helper:telemetry]',
    JSON.stringify({
      helper_invoked: result.invoked,
      helper_status: result.status,
      helper_latency: result.latencyMs,
      helper_parse_ok: result.parseOk,
      ...(result.errorCategory ? { errorCategory: result.errorCategory } : {}),
    })
  );
}
