-- Migration 0002: Global daily AI usage counter
-- Separate from the per-bot/per-IP usage table so we can increment it
-- atomically with a single-row-per-day upsert (no SELECT needed).
CREATE TABLE IF NOT EXISTS global_usage (
  day      TEXT PRIMARY KEY,   -- 'YYYY-MM-DD' UTC
  ai_calls INTEGER DEFAULT 0   -- successful AI calls only
);
