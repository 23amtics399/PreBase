-- Migration number: 0007 	 2026-09-08T00:00:00.000Z

-- 1. Add enrichment_status to kb_sources
-- Valid values: 'not_requested', 'queued', 'processing', 'completed', 'failed'
ALTER TABLE kb_sources ADD COLUMN enrichment_status TEXT DEFAULT 'not_requested' NOT NULL;

-- 2. Create knowledge_enrichment table
CREATE TABLE knowledge_enrichment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id INTEGER NOT NULL UNIQUE REFERENCES kb_chunks(id) ON DELETE CASCADE,
  questions TEXT NOT NULL,
  aliases TEXT NOT NULL,
  keywords TEXT NOT NULL,
  topics TEXT NOT NULL,
  entities TEXT NOT NULL,
  negative_constraints TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 3. Recreate kb_fts as a standard FTS5 table
DROP TABLE kb_fts;

CREATE VIRTUAL TABLE kb_fts USING fts5(
  bot_id UNINDEXED,            
  source_id UNINDEXED,          
  chunk_index UNINDEXED,
  content                     
);

-- Repopulate kb_fts from kb_chunks
INSERT INTO kb_fts(rowid, bot_id, source_id, chunk_index, content)
SELECT id, bot_id, source_id, chunk_index, content FROM kb_chunks;

-- 4. Replace triggers to keep kb_fts synced with both kb_chunks and knowledge_enrichment
DROP TRIGGER IF EXISTS kb_chunks_ai;
DROP TRIGGER IF EXISTS kb_chunks_ad;
DROP TRIGGER IF EXISTS kb_chunks_au;

-- When a chunk is inserted, it has no enrichment yet.
CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_fts(rowid, bot_id, source_id, chunk_index, content)
  VALUES (new.id, new.bot_id, new.source_id, new.chunk_index, new.content);
END;

-- When a chunk is deleted, its FTS row is deleted. 
CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  DELETE FROM kb_fts WHERE rowid = old.id;
END;

-- When a chunk is updated, its FTS row must include the new content PLUS any existing enrichment.
CREATE TRIGGER kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
  UPDATE kb_fts 
  SET content = new.content || 
      IFNULL(
        (SELECT ' ' || questions || ' ' || aliases || ' ' || keywords || ' ' || topics || ' ' || entities || ' ' || negative_constraints 
         FROM knowledge_enrichment WHERE chunk_id = new.id), 
        ''
      )
  WHERE rowid = new.id;
END;

-- Enrichment triggers
-- When enrichment is inserted, append metadata to the existing FTS content.
CREATE TRIGGER kb_enrich_ai AFTER INSERT ON knowledge_enrichment BEGIN
  UPDATE kb_fts 
  SET content = (SELECT content FROM kb_chunks WHERE id = new.chunk_id) || 
                ' ' || new.questions || ' ' || new.aliases || ' ' || new.keywords || 
                ' ' || new.topics || ' ' || new.entities || ' ' || new.negative_constraints
  WHERE rowid = new.chunk_id;
END;

-- When enrichment is updated, replace the appended metadata with the new metadata.
CREATE TRIGGER kb_enrich_au AFTER UPDATE ON knowledge_enrichment BEGIN
  UPDATE kb_fts 
  SET content = (SELECT content FROM kb_chunks WHERE id = new.chunk_id) || 
                ' ' || new.questions || ' ' || new.aliases || ' ' || new.keywords || 
                ' ' || new.topics || ' ' || new.entities || ' ' || new.negative_constraints
  WHERE rowid = new.chunk_id;
END;

-- When enrichment is deleted, remove the metadata, reverting FTS to just the original content.
CREATE TRIGGER kb_enrich_ad AFTER DELETE ON knowledge_enrichment BEGIN
  UPDATE kb_fts 
  SET content = (SELECT content FROM kb_chunks WHERE id = old.chunk_id)
  WHERE rowid = old.chunk_id;
END;
