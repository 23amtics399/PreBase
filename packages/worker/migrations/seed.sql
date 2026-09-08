-- Seed data for testing FTS5 and retrieval in local D1

-- 1. Create a dummy user
INSERT INTO users (id, email, password_hash, created_at)
VALUES ('user_123', 'test@prebase.sji.one', 'DISABLED:development-only', strftime('%s', 'now'));

-- 2. Create a public bot
INSERT INTO bots (id, owner_id, name, description, system_prompt, is_public, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000456',
  'user_123',
  'FAQ Bot',
  'Answers questions about returns and shipping',
  'You are the customer support assistant for the PreBase Test Store. 

Your strict instructions:
1. Answer the user''s question using ONLY the information provided in the Source Text snippet.
2. If the Source Text does not contain the exact answer, you MUST say: "I''m sorry, I couldn''t find that specific information. Please contact our human support team at support@teststore.example."
3. Keep your answers brief, friendly, and direct (under 3 sentences).
4. Never guess, assume, or make up information.
5. Never ask the user for passwords, OTPs, or banking credentials.',
  1,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- 3. Create a knowledge source
INSERT INTO kb_sources (id, bot_id, filename, byte_size, chunk_count, uploaded_at)
VALUES (1, '00000000-0000-4000-8000-000000000456', 'policy.md', 1000, 4, strftime('%s', 'now'));

-- 4. Insert chunks
INSERT INTO kb_chunks (id, bot_id, source_id, chunk_index, content)
VALUES (
  1,
  '00000000-0000-4000-8000-000000000456', 
  1, 
  0, 
  'We ship internationally to over 50 countries. International shipping takes 10-15 business days. Customs and import duties are the responsibility of the customer.'
);

INSERT INTO kb_chunks (id, bot_id, source_id, chunk_index, content)
VALUES (
  2,
  '00000000-0000-4000-8000-000000000456', 
  1, 
  1, 
  'Water damage (including drops in the pool or ocean) voids the hardware warranty immediately.'
);

INSERT INTO kb_chunks (id, bot_id, source_id, chunk_index, content)
VALUES (
  3,
  '00000000-0000-4000-8000-000000000456', 
  1, 
  2, 
  'Our operating hours are Monday to Friday, 9am to 5pm EST. Contact support@teststore.example.'
);

-- 5. Insert mock enrichment
INSERT INTO knowledge_enrichment (chunk_id, questions, aliases, keywords, topics, entities, negative_constraints, model, created_at, updated_at)
VALUES (
  1,
  '["Do you deliver overseas?"]',
  '["overseas", "abroad", "outside country"]',
  '["international shipping", "customs"]',
  '["shipping"]',
  '[]',
  '[]',
  'mock-model',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

INSERT INTO knowledge_enrichment (chunk_id, questions, aliases, keywords, topics, entities, negative_constraints, model, created_at, updated_at)
VALUES (
  2,
  '["Does warranty cover dropping in pool?"]',
  '["pool", "water damage", "ocean", "liquid"]',
  '["warranty void", "hardware"]',
  '["warranty"]',
  '[]',
  '["does not cover water damage"]',
  'mock-model',
  strftime('%s', 'now'),
  strftime('%s', 'now')
);
