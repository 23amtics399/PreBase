import type { D1Database, Ai, Queue } from '@cloudflare/workers-types';

/**
 * Cloudflare Worker environment bindings for PreBase.
 * All [vars] values arrive as strings — parse with parseInt/parseFloat as needed.
 */
export type Bindings = {
  // Cloudflare service bindings
  DB: D1Database;
  AI: Ai;

  // AI model (do not hardcode in business logic)
  PREBASE_AI_MODEL: string;

  // Global AI daily quota
  PREBASE_AI_DAILY_LIMIT: string;   // e.g. "7954"

  // Rate limits
  PREBASE_PER_BOT_DAILY: string;    // e.g. "500"
  PREBASE_PER_BOT_IP_DAILY: string; // e.g. "20"
  PREBASE_IP_DAILY: string;         // e.g. "100"

  // Retrieval
  PREBASE_CHAR_BUDGET: string;      // e.g. "3600"

  // Relevance guard — BM25 score threshold (negative float)
  PREBASE_MIN_BM25_SCORE: string;   // e.g. "-0.5"

  // Input validation
  PREBASE_MAX_MESSAGE_LEN: string;  // e.g. "2000"

  // HMAC secret for IP hashing — set via `wrangler secret put` in production
  RATE_LIMIT_SECRET: string;

  // Bot Knowledge Limits
  PREBASE_MAX_KB_SIZE?: string;
  PREBASE_MAX_SOURCES_PER_BOT?: string;
  PREBASE_MAX_UPLOAD_SIZE?: string;

  // Preview Limits
  PREBASE_PREVIEW_LIMIT?: string;

  // Smart Enrichment — Phase 1: Groq replaces Gemini
  ENRICHMENT_QUEUE: Queue<any>;

  // Groq API (Phase 1: ingestion enrichment)
  GROQ_API_KEY: string;
  PREBASE_INGESTION_MODEL: string;   // e.g. "qwen/qwen3.8-27b"
  PREBASE_ENRICH_MAX_RETRIES: string;
  // Inter-chunk pacing delay in ms. Default: 8500ms (set in wrangler.toml).
  // Set to '0' in unit tests to skip the delay.
  PREBASE_ENRICH_PACE_MS?: string;
  // Groq enrichment API timeout in ms. Default: 10000ms.
  PREBASE_ENRICH_TIMEOUT_MS?: string;

  // Groq daily quota management
  // PreBase combined application ceiling for all qwen/qwen3.8-27b use cases.
  // It is NOT Groq's quota. Provider reference RPD for qwen3.8-27b: 1,000.
  PREBASE_GROQ_QWEN_DAILY_CEILING?: string;  // e.g. "950"
  PREBASE_GROQ_INGESTION_BUDGET: string;     // e.g. "650" (max Groq calls/day for ingestion)

  // Prompt Guard circuit breaker budget
  // Provider reference RPD for llama-prompt-guard-2-86m: 14,400 (independent pool)
  PREBASE_GROQ_GUARD_BUDGET?: string;        // default: "5000"

  // Fallback model env vars — all empty (disabled) in current pass
  PREBASE_GUARD_FALLBACK_MODEL?: string;     // default: ""
  PREBASE_HELPER_FALLBACK_MODEL?: string;    // default: ""
  PREBASE_INGESTION_FALLBACK_MODEL?: string; // default: ""

  // Fallback budgets — only active when corresponding model var is non-empty
  PREBASE_GROQ_GUARD_FALLBACK_BUDGET?: string;     // default: "1000"
  PREBASE_GROQ_RUNTIME_FALLBACK_BUDGET?: string;   // default: "100"
  PREBASE_GROQ_INGESTION_FALLBACK_BUDGET?: string; // default: "200"

  // Gemini — kept temporarily for rollback, UNUSED in Phase 1.
  // Remove after Groq ingestion is verified in production.
  GEMINI_API_KEY?: string;
  PREBASE_GEMINI_MODEL?: string;
  PREBASE_ENRICH_MAX_CHUNKS_PER_JOB?: string;

  // Prompt Guard — Phase 2: Pre-RAG security signal (Groq meta-llama/llama-prompt-guard-2-86m)
  PREBASE_GUARD_PROVIDER?: string;
  PREBASE_GUARD_MODEL?: string;
  PREBASE_GUARD_THRESHOLD?: string;

  // Retrieval Helper — Phase 3: Runtime query expansion (Groq qwen/qwen3.8-27b)
  PREBASE_GROQ_RUNTIME_BUDGET?: string; // e.g. "300" (max Groq calls/day for runtime retrieval)
};
export type Variables = {
  userId: string;
};
