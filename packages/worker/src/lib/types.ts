import type { D1Database, Ai } from '@cloudflare/workers-types';

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
};

export type Variables = {
  userId: string;
};
