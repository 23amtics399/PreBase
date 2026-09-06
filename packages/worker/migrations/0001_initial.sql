-- Migration number: 0001 	 2026-09-05T00:00:00.000Z

-- Users table
CREATE TABLE users (
  id         TEXT PRIMARY KEY,        -- UUIDv4
  email      TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,           -- bcrypt or argon2id
  created_at INTEGER NOT NULL         -- Unix timestamp
);

-- Sessions (replaces JWT; simpler and more revocable)
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,        -- 32-byte hex random
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Bots
CREATE TABLE bots (
  id            TEXT PRIMARY KEY,     -- UUIDv4 (also the public bot ID)
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  system_prompt TEXT DEFAULT '',      -- owner's instructions to the AI
  is_public     INTEGER DEFAULT 0,    -- 0=private/testing, 1=public/embeddable
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_bots_owner ON bots(owner_id);

-- Knowledge sources (file-level metadata)
CREATE TABLE kb_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX idx_kb_sources_bot ON kb_sources(bot_id);

-- Knowledge chunks (the actual text used for retrieval)
CREATE TABLE kb_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_id   INTEGER REFERENCES kb_sources(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL
);
CREATE INDEX idx_kb_chunks_bot ON kb_chunks(bot_id);

-- FTS5 virtual table for BM25 full-text search
-- Uses external content table (content='kb_chunks')
-- The columns in FTS5 must match the columns in kb_chunks (excluding the rowid)
CREATE VIRTUAL TABLE kb_fts USING fts5(
  bot_id UNINDEXED,            
  source_id UNINDEXED,          
  chunk_index UNINDEXED,
  content,                     
  content='kb_chunks',         
  content_rowid='id'
);

-- Triggers to keep FTS index in sync with kb_chunks
CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_fts(rowid, bot_id, source_id, chunk_index, content)
  VALUES (new.id, new.bot_id, new.source_id, new.chunk_index, new.content);
END;
CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, bot_id, source_id, chunk_index, content)
  VALUES ('delete', old.id, old.bot_id, old.source_id, old.chunk_index, old.content);
END;
CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, bot_id, source_id, chunk_index, content)
  VALUES ('delete', old.id, old.bot_id, old.source_id, old.chunk_index, old.content);
  INSERT INTO kb_fts(rowid, bot_id, source_id, chunk_index, content)
  VALUES (new.id, new.bot_id, new.source_id, new.chunk_index, new.content);
END;

-- Daily usage tracking (for rate limiting and monitoring)
CREATE TABLE usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL,
  day         TEXT NOT NULL,          -- 'YYYY-MM-DD' UTC
  ip_hash     TEXT,                   -- SHA-256 hash of IP — not the raw IP
  msg_count   INTEGER DEFAULT 0,
  UNIQUE(bot_id, day, ip_hash)
);
CREATE INDEX idx_usage_bot_day ON usage(bot_id, day);
CREATE INDEX idx_usage_day ON usage(day);    -- for global daily sum query
