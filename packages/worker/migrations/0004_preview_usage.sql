-- Migration number: 0004 	 2026-09-06T00:00:00.000Z

-- Preview usage tracking (for authenticated preview rate limiting)
CREATE TABLE preview_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,          -- 'YYYY-MM-DD' UTC
  msg_count   INTEGER DEFAULT 0,
  UNIQUE(user_id, day)
);
CREATE INDEX idx_preview_usage_user_day ON preview_usage(user_id, day);
