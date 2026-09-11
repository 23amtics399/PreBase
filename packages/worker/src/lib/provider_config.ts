/**
 * provider_config.ts
 *
 * Model allow-list and provider reference values for PreBase.
 *
 * IMPORTANT: Provider reference values (RPD, RPM, TPM, TPD) are recorded here
 * for planning and documentation purposes ONLY. They are external constraints
 * that can change without notice. PreBase has no real-time visibility into
 * provider-side counters. These values are NOT enforced by code.
 *
 * PreBase application budgets are enforced separately in D1 (groq_quota_ledger).
 * Do not confuse provider reference values with PreBase application budgets.
 */

export type UseCase = 'guard' | 'runtime' | 'ingestion';

export interface ModelConfig {
  modelId: string;
  provider: 'groq';
  /** Provider reference values — external, may change, NOT enforced by PreBase */
  providerRef: {
    rpm: number;
    rpd: number;
    tpm: number;
    tpd: number;
    note: string;
  };
  /** PreBase application budget env var name for this (model, use_case) pair */
  budgetEnvVar: string;
  /** Default budget if env var is not set */
  defaultBudget: number;
}

/**
 * Hardcoded allow-list of approved models per use case.
 * A model MUST appear in this list to be eligible for use.
 * Setting an env var alone is not sufficient — the model must be listed here.
 *
 * Primary models are index 0. Fallback models are index 1+ (all disabled by default).
 */
export const MODEL_REGISTRY: Record<UseCase, ModelConfig[]> = {
  guard: [
    {
      modelId: 'meta-llama/llama-prompt-guard-2-86m',
      provider: 'groq',
      providerRef: {
        rpm: 30, rpd: 14400, tpm: 15000, tpd: 500000,
        note: 'Model-specific pool. Organization/account scoped. May change.',
      },
      budgetEnvVar: 'PREBASE_GROQ_GUARD_BUDGET',
      defaultBudget: 5000,
    },
    {
      modelId: 'meta-llama/llama-prompt-guard-2-22m',
      provider: 'groq',
      providerRef: {
        rpm: 30, rpd: 14400, tpm: 15000, tpd: 500000,
        note: 'Model-specific pool. Independent from 86M pool. May change.',
      },
      budgetEnvVar: 'PREBASE_GROQ_GUARD_FALLBACK_BUDGET',
      defaultBudget: 1000,
    },
  ],
  runtime: [
    {
      modelId: 'qwen/qwen3.8-27b',
      provider: 'groq',
      providerRef: {
        rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000,
        note: 'Model-specific pool shared with ingestion use case. May change.',
      },
      budgetEnvVar: 'PREBASE_GROQ_RUNTIME_BUDGET',
      defaultBudget: 300,
    },
    {
      modelId: 'qwen/qwen3.6-27b',
      provider: 'groq',
      providerRef: {
        rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000,
        note: 'Independent model-specific pool. Separate from qwen3.8 pool. May change.',
      },
      budgetEnvVar: 'PREBASE_GROQ_RUNTIME_FALLBACK_BUDGET',
      defaultBudget: 100,
    },
  ],
  ingestion: [
    {
      modelId: 'qwen/qwen3.8-27b',
      provider: 'groq',
      providerRef: {
        rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000,
        note: 'Model-specific pool shared with runtime use case. May change.',
      },
      budgetEnvVar: 'PREBASE_GROQ_INGESTION_BUDGET',
      defaultBudget: 650,
    },
    {
      modelId: 'qwen/qwen3.6-27b',
      provider: 'groq',
      providerRef: {
        rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000,
        note: 'Independent model-specific pool. Separate from qwen3.8 pool. May change.',
      },
      budgetEnvVar: 'PREBASE_GROQ_INGESTION_FALLBACK_BUDGET',
      defaultBudget: 200,
    },
  ],
};

/**
 * Single constant for the Qwen model that is subject to the combined ceiling.
 */
export const QWEN_CEILING_MODEL_ID = 'qwen/qwen3.8-27b';

/**
 * The Groq model IDs whose combined daily request_count is subject to the
 * Qwen shared model ceiling (PREBASE_GROQ_QWEN_DAILY_CEILING).
 * These models share the same Groq provider-side model pool.
 * Add to this list only when a new model is confirmed to share a provider pool
 * with an existing entry.
 */
export const QWEN_SHARED_POOL_MODEL_IDS = new Set(['qwen/qwen3.8-27b']);

/** Returns true if modelId is on the allow-list for the given use case. */
export function isModelAllowed(useCase: UseCase, modelId: string): boolean {
  return MODEL_REGISTRY[useCase]?.some(m => m.modelId === modelId) ?? false;
}

/** Returns the ModelConfig for a model+use_case pair, or null if not allowed. */
export function getModelConfig(
  useCase: UseCase,
  modelId: string
): ModelConfig | null {
  return MODEL_REGISTRY[useCase]?.find(m => m.modelId === modelId) ?? null;
}
