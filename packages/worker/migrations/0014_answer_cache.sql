-- Migration number: 0014   2026-09-12T00:00:00.000Z
--
-- D1-backed answer cache for successful Granite synthesis responses.
--
-- PURPOSE:
--   Caches verbatim Granite synthesis answers so that identical repeated
--   questions from any visitor on any bot return the cached answer without
--   consuming AI quota or incurring inference latency.
--
-- CACHE KEY:
--   "<botId>:<botUpdatedAt>:<sha256(normalizedMessage)>"
--   where:
--     botUpdatedAt  = bots.updated_at (Unix timestamp, updated by every
--                     mutation that changes the effective answer: instructions
--                     edit, knowledge upload, source deletion, text-source add)
--     normalizedMessage = message.trim().toLowerCase().replace(/\s+/g, ' ')
--
--   The botUpdatedAt component auto-invalidates the cache whenever the bot
--   configuration or knowledge base changes. There is no manual flush needed.
--
-- WHAT IS CACHED:
--   ONLY successful Granite synthesis answers (ragStatus = 'ai_called').
--   NEVER cached:
--     - Security refusals (credential_intercepted, guard_blocked)
--     - Grounding answers (entity_intercepted, policy_intercepted)
--     - Deterministic responses (greeting_intercepted, short_intent_intercepted)
--     - Error responses (ai_error)
--     - Rate-limit responses (fallback_ai_quota)
--     - Fallback menu responses
--
-- TTL: 24 hours (86400 seconds). Checked on read; expired entries ignored.
--
-- CLEANUP:
--   Best-effort cleanup via DELETE WHERE expires_at < unixnow() in waitUntil.
--   The idx_answer_cache_expires index makes these sweeps fast.

CREATE TABLE IF NOT EXISTS answer_cache (
  cache_key  TEXT    PRIMARY KEY,
  answer     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL   -- Unix timestamp: created_at + 86400
);

CREATE INDEX IF NOT EXISTS idx_answer_cache_expires ON answer_cache(expires_at);
