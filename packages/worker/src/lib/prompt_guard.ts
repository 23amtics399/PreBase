import type { Bindings } from './types';
import { atomicReserveGroqQuota } from './ratelimit';

export type GuardStatus = 'passed' | 'blocked' | 'unavailable';
export type GuardAction = 'passed' | 'blocked' | 'fallback_to_t0';
export type GuardErrorCategory =
  | 'timeout'
  | 'rate_limit'
  | 'server_error'
  | 'malformed_output'
  | 'missing_key'
  | 'network_error';

export interface PromptGuardResult {
  status: GuardStatus;
  score: number | null;
  latencyMs: number;
  action: GuardAction;
  provider: string;
  model: string;
  errorCategory?: GuardErrorCategory;
}

const DEFAULT_GUARD_MODEL = 'meta-llama/llama-prompt-guard-2-86m';
const DEFAULT_GUARD_PROVIDER = 'groq';
const DEFAULT_GUARD_THRESHOLD = 0.75;
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GUARD_TIMEOUT_MS = 2500;

/**
 * Checks a user message against Groq Prompt Guard 86M.
 *
 * IMPORTANT SECURITY ARCHITECTURE:
 * - Prompt Guard is purely an auxiliary classification/routing signal, NOT the security authority.
 * - The PreBase immutable T0 system prompt remains the ultimate authority.
 * - If Prompt Guard is unavailable (network error, timeout, 429, 500, or missing key),
 *   the system falls back to T0 + FTS5 + Granite (action: 'fallback_to_t0').
 *   An outage must NEVER take down the entire chatbot.
 * - If Prompt Guard produces a false negative (misses an attack), T0 still prevents
 *   system prompt disclosure, persona takeover, and instruction overrides.
 *
 * PRIVACY GUARANTEE:
 * - Server telemetry logged via [guard:telemetry] NEVER contains raw user text,
 *   system prompts, knowledge content, API keys, or IP addresses.
 */
export async function checkPromptGuard(
  env: Bindings,
  userMessage: string
): Promise<PromptGuardResult> {
  const provider = env.PREBASE_GUARD_PROVIDER || DEFAULT_GUARD_PROVIDER;
  const model = env.PREBASE_GUARD_MODEL || DEFAULT_GUARD_MODEL;
  const threshold = parseFloat(env.PREBASE_GUARD_THRESHOLD || '') || DEFAULT_GUARD_THRESHOLD;

  if (!env.GROQ_API_KEY) {
    const res: PromptGuardResult = {
      status: 'unavailable',
      score: null,
      latencyMs: 0,
      action: 'fallback_to_t0',
      provider,
      model,
      errorCategory: 'missing_key',
    };
    logGuardTelemetry(res);
    return res;
  }

  // Application budget check — circuit breaker only.
  // PREBASE_GROQ_GUARD_BUDGET is PreBase's internal allocation. NOT Groq's quota.
  // Groq provider reference RPD for this model: 14,400 (independent model pool).
  if (env.DB && typeof env.DB.prepare === 'function') {
    const today = new Date().toISOString().slice(0, 10);
    const guardBudget = Math.max(1, parseInt(env.PREBASE_GROQ_GUARD_BUDGET || '5000', 10));
    const reservation = await atomicReserveGroqQuota(
      env.DB,
      today,
      model,
      'guard',
      guardBudget
    );
    if (!reservation.allowed) {
      console.warn(`[PromptGuard] Application budget exhausted. Continuing under T0.`);
      const res: PromptGuardResult = {
        status: 'unavailable',
        score: null,
        latencyMs: 0,
        action: 'fallback_to_t0',
        provider,
        model,
        errorCategory: 'rate_limit',
      };
      logGuardTelemetry(res);
      return res;
    }
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GUARD_TIMEOUT_MS);

  try {
    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.0,
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (response.status === 429) {
      const res: PromptGuardResult = {
        status: 'unavailable',
        score: null,
        latencyMs,
        action: 'fallback_to_t0',
        provider,
        model,
        errorCategory: 'rate_limit',
      };
      logGuardTelemetry(res);
      return res;
    }

    if (response.status >= 500) {
      const res: PromptGuardResult = {
        status: 'unavailable',
        score: null,
        latencyMs,
        action: 'fallback_to_t0',
        provider,
        model,
        errorCategory: 'server_error',
      };
      logGuardTelemetry(res);
      return res;
    }

    if (!response.ok) {
      const res: PromptGuardResult = {
        status: 'unavailable',
        score: null,
        latencyMs,
        action: 'fallback_to_t0',
        provider,
        model,
        errorCategory: 'server_error',
      };
      logGuardTelemetry(res);
      return res;
    }

    const json = (await response.json()) as any;
    const rawContent = json?.choices?.[0]?.message?.content?.trim() ?? '';
    const score = parseFloat(rawContent);

    // Probability float must be a valid number between 0.0 and 1.0
    if (isNaN(score) || score < 0.0 || score > 1.0) {
      const res: PromptGuardResult = {
        status: 'unavailable',
        score: null,
        latencyMs,
        action: 'fallback_to_t0',
        provider,
        model,
        errorCategory: 'malformed_output',
      };
      logGuardTelemetry(res);
      return res;
    }

    const isBlocked = score > threshold;
    const res: PromptGuardResult = {
      status: isBlocked ? 'blocked' : 'passed',
      score,
      latencyMs,
      action: isBlocked ? 'blocked' : 'passed',
      provider,
      model,
    };
    logGuardTelemetry(res);
    return res;
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const isTimeout =
      (err instanceof Error && err.name === 'AbortError') ||
      (typeof err === 'object' && err !== null && (err as any).name === 'AbortError');

    const res: PromptGuardResult = {
      status: 'unavailable',
      score: null,
      latencyMs,
      action: 'fallback_to_t0',
      provider,
      model,
      errorCategory: isTimeout ? 'timeout' : 'network_error',
    };
    logGuardTelemetry(res);
    return res;
  }
}

/**
 * Emits privacy-safe server telemetry.
 * Strictly avoids logging user messages, system prompts, or IP addresses.
 */
function logGuardTelemetry(result: PromptGuardResult): void {
  console.log(
    '[guard:telemetry]',
    JSON.stringify({
      guard_status: result.status,
      guard_score: result.score,
      guard_action: result.action,
      provider: result.provider,
      model: result.model,
      latency: result.latencyMs,
      ...(result.errorCategory ? { errorCategory: result.errorCategory } : {}),
    })
  );
}
