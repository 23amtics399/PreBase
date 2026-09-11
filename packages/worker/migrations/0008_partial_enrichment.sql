-- Migration number: 0008 	 2026-09-10T00:00:00.000Z

-- 1. Create groq_usage table for tracking daily Groq API calls (C3 budget enforcement)
CREATE TABLE IF NOT EXISTS groq_usage (
  day TEXT PRIMARY KEY,          -- 'YYYY-MM-DD' UTC
  ingestion_calls INTEGER DEFAULT 0
);

-- 2. Create knowledge_enrichment_failures table for tracking permanent chunk failures (C2 partial state)
CREATE TABLE IF NOT EXISTS knowledge_enrichment_failures (
  chunk_id INTEGER PRIMARY KEY REFERENCES kb_chunks(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
