-- Migration number: 0005 	 2026-09-06T00:00:00.000Z

-- Add ON DELETE CASCADE to the usage table so deleting a bot cleans up its widget rate-limiting logs.
-- SQLite requires recreating the table to add a foreign key constraint.

PRAGMA foreign_keys=OFF;

CREATE TABLE usage_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,          -- 'YYYY-MM-DD' UTC
  ip_hash     TEXT,                   -- SHA-256 hash of IP — not the raw IP
  msg_count   INTEGER DEFAULT 0,
  UNIQUE(bot_id, day, ip_hash)
);

DELETE FROM usage WHERE bot_id NOT IN (SELECT id FROM bots);

INSERT INTO usage_new (id, bot_id, day, ip_hash, msg_count)
SELECT id, bot_id, day, ip_hash, msg_count FROM usage;

DROP TABLE usage;

ALTER TABLE usage_new RENAME TO usage;

CREATE INDEX idx_usage_bot_day ON usage(bot_id, day);
CREATE INDEX idx_usage_day ON usage(day);

PRAGMA foreign_keys=ON;
