-- Seed data for testing FTS5 and retrieval in local D1

-- 1. Create a dummy user
INSERT INTO users (id, email, password_hash, created_at)
VALUES ('user_123', 'test@prebase.sji.one', 'DISABLED:development-only', strftime('%s', 'now'));

-- 2. Create a public bot
INSERT INTO bots (id, owner_id, name, description, system_prompt, is_public, created_at, updated_at)
VALUES (
  'bot_456',
  'user_123',
  'FAQ Bot',
  'Answers questions about returns and shipping',
  'You are a helpful assistant.',
  1,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- 2b. Create a PRIVATE bot (is_public=0) for testing the 404 behaviour.
--     Hitting /api/widget/chat with bot_private should return 404,
--     not 403 — callers must not learn that this bot exists.
INSERT INTO bots (id, owner_id, name, description, system_prompt, is_public, created_at, updated_at)
VALUES (
  'bot_private',
  'user_123',
  'Private Bot',
  'This bot is in draft mode and must not be accessible via the widget.',
  'You are a private assistant.',
  0,
  strftime('%s', 'now'),
  strftime('%s', 'now')
);

-- 3. Create a knowledge source
INSERT INTO kb_sources (id, bot_id, filename, byte_size, chunk_count, uploaded_at)
VALUES (1, 'bot_456', 'policy.md', 1000, 4, strftime('%s', 'now'));

-- 4. Insert chunks (triggers will automatically sync this to kb_fts)

-- Chunk 0: Return Policy (Heading)
INSERT INTO kb_chunks (bot_id, source_id, chunk_index, content)
VALUES (
  'bot_456', 
  1, 
  0, 
  '# Return Policy
We accept returns within 30 days of purchase. The item must be in original condition with tags attached.
To start a return, please email returns@example.com with your order number. Refunds take 5-7 business days to process after we receive the item.'
);

-- Chunk 1: International Shipping
INSERT INTO kb_chunks (bot_id, source_id, chunk_index, content)
VALUES (
  'bot_456', 
  1, 
  1, 
  '# Shipping
We ship internationally to over 50 countries. International shipping takes 10-15 business days.
Customs and import duties are the responsibility of the customer and are not included in the shipping cost at checkout.'
);

-- Chunk 2: Domestic Shipping
INSERT INTO kb_chunks (bot_id, source_id, chunk_index, content)
VALUES (
  'bot_456', 
  1, 
  2, 
  'Domestic shipping within the US is free for orders over $50. Standard domestic shipping takes 3-5 business days. Expedited 2-day shipping is available for $15.'
);

-- Chunk 3: Contact Info
INSERT INTO kb_chunks (bot_id, source_id, chunk_index, content)
VALUES (
  'bot_456', 
  1, 
  3, 
  '## Contact Us
You can reach our support team at support@example.com or call us at 1-800-555-0199.
Our operating hours are Monday to Friday, 9am to 5pm EST. We are closed on all major holidays.'
);
