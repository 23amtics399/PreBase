-- Migration number: 0006 	 2026-09-07T00:00:00.000Z

-- Revert ON DELETE CASCADE on the usage table because the bot_id column 
-- is also used to store sentinel values like '__GLOBAL__' for tracking 
-- cross-bot IP usage, which causes foreign key constraint violations.

PRAGMA foreign_keys=OFF;

CREATE TABLE usage_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL,
  day         TEXT NOT NULL,          -- 'YYYY-MM-DD' UTC
  ip_hash     TEXT,                   -- SHA-256 hash of IP — not the raw IP
  msg_count   INTEGER DEFAULT 0,
  UNIQUE(bot_id, day, ip_hash)
);

INSERT INTO usage_new (id, bot_id, day, ip_hash, msg_count)
SELECT id, bot_id, day, ip_hash, msg_count FROM usage;

DROP TABLE usage;

ALTER TABLE usage_new RENAME TO usage;

CREATE INDEX idx_usage_bot_day ON usage(bot_id, day);
CREATE INDEX idx_usage_day ON usage(day);

PRAGMA foreign_keys=ON;
