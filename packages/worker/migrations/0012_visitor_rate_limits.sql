-- Migration number: 0012   2026-09-12T00:00:00.000Z
--
-- Visitor short-burst rate limiting table.
--
-- PURPOSE:
--   Protects the per-bot AI quota from scripted abuse and accidental flooding
--   before any KB load or AI synthesis occurs.
--
-- DESIGN:
--   Key: (bot_id, visitor_hash, minute_bucket)
--   visitor_hash — SHA-256( RATE_LIMIT_SECRET + visitorId ) where visitorId is
--     a browser-generated UUID stored in localStorage. Falls back to
--     SHA-256( RATE_LIMIT_SECRET + CF-Connecting-IP ) when absent.
--   minute_bucket — Unix timestamp floored to the nearest 60-second boundary
--     (Math.floor(Date.now() / 1000 / 60)).
--
--   Because the bucket is minute-scoped, counters reset automatically each
--   minute without any background cleanup job. Old rows accumulate slowly
--   (one row per visitor per bot per minute of activity) and can be purged
--   periodically with DELETE WHERE minute_bucket < (now/60 - 1440).
--
-- SEPARATION FROM EXISTING TABLES:
--   * `usage`        — daily visitor-per-bot-per-IP analytics and rate limiting
--   * `global_usage` — successful AI synthesis quota accounting
--   * `visitor_rate_limits` — sub-minute burst protection (this table)
--
-- ATOMICITY:
--   Same ON CONFLICT / RETURNING pattern as the `usage` table:
--   INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count
--   Rollback on over-limit to keep the counter accurate.

CREATE TABLE IF NOT EXISTS visitor_rate_limits (
  bot_id         TEXT    NOT NULL,
  visitor_hash   TEXT    NOT NULL,
  minute_bucket  INTEGER NOT NULL,   -- Unix minute (floor(unixtime / 60))
  request_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, visitor_hash, minute_bucket)
);

-- Index for periodic cleanup queries (sweep old minute buckets)
CREATE INDEX IF NOT EXISTS idx_vrl_bucket ON visitor_rate_limits(minute_bucket);
