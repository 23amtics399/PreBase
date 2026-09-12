import { Hono } from 'hono';
import type { Bindings, Variables } from '../lib/types';
import { authMiddleware } from '../middleware/auth';
import { checkPreviewLimit } from '../lib/ratelimit';
import { executeRagPipeline } from '../lib/rag';
import { chunkText } from '../lib/chunker';

const bots = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All routes under /api/bots are protected by authentication
bots.use('*', authMiddleware);

/**
 * Regex for valid bot IDs (UUIDv4 pattern: hex + hyphens, or alphanumeric/underscore).
 * Also valid for newly created bots which will use crypto.randomUUID().
 */
const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateBotId(botId: string | undefined): boolean {
  return typeof botId === 'string' && BOT_ID_RE.test(botId);
}

// ---------------------------------------------------------------------------
// POST /
// Create a bot
// ---------------------------------------------------------------------------
bots.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'invalid_body', message: 'Request body must be a JSON object.' }, 400);
  }

  const { name, description, system_prompt } = body as Record<string, unknown>;

  if (typeof name !== 'string' || name.trim().length === 0) {
    return c.json({ error: 'invalid_name', message: 'Name is required.' }, 400);
  }
  if (name.length > 100) {
    return c.json({ error: 'invalid_name', message: 'Name must not exceed 100 characters.' }, 400);
  }

  const desc = typeof description === 'string' ? description.trim() : '';
  if (desc.length > 500) {
    return c.json({ error: 'invalid_description', message: 'Description must not exceed 500 characters.' }, 400);
  }

  const prompt = typeof system_prompt === 'string' ? system_prompt.trim() : '';
  const maxInstructionsChars = Math.max(1, parseInt(c.env.PREBASE_MAX_INSTRUCTIONS_CHARS ?? '2000', 10));
  if (prompt.length > maxInstructionsChars) {
    return c.json({ error: 'invalid_system_prompt', message: `Bot owner instructions must not exceed ${maxInstructionsChars} characters.` }, 400);
  }

  const id = crypto.randomUUID();
  const ownerId = c.get('userId');
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `INSERT INTO bots (id, owner_id, name, description, system_prompt, is_public, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(id, ownerId, name.trim(), desc, prompt, now, now).run();

  return c.json({ id, name: name.trim(), description: desc, system_prompt: prompt, is_public: 0, created_at: now, updated_at: now }, 201);
});

// ---------------------------------------------------------------------------
// GET /
// List my bots
// ---------------------------------------------------------------------------
bots.get('/', async (c) => {
  const ownerId = c.get('userId');

  const { results } = await c.env.DB.prepare(
    `SELECT id, name, description, is_public, created_at, updated_at
     FROM bots
     WHERE owner_id = ?
     ORDER BY created_at DESC`
  ).bind(ownerId).all();

  return c.json({ bots: results });
});

// ---------------------------------------------------------------------------
// GET /:id
// Get my bot detail
// ---------------------------------------------------------------------------
bots.get('/:id', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);

  const ownerId = c.get('userId');

  const bot = await c.env.DB.prepare(
    `SELECT id, name, description, system_prompt, is_public, created_at, updated_at
     FROM bots
     WHERE id = ? AND owner_id = ?`
  ).bind(botId, ownerId).first();

  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  return c.json(bot);
});

// ---------------------------------------------------------------------------
// PATCH /:id
// Update my bot
// ---------------------------------------------------------------------------
bots.patch('/:id', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'invalid_body', message: 'Request body must be a JSON object.' }, 400);
  }

  const { name, description, system_prompt } = body as Record<string, unknown>;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return c.json({ error: 'invalid_name', message: 'Name must be a non-empty string.' }, 400);
    }
    if (name.length > 100) {
      return c.json({ error: 'invalid_name', message: 'Name must not exceed 100 characters.' }, 400);
    }
    updates.push('name = ?');
    params.push(name.trim());
  }

  if (description !== undefined) {
    if (typeof description !== 'string') {
      return c.json({ error: 'invalid_description', message: 'Description must be a string.' }, 400);
    }
    if (description.length > 500) {
      return c.json({ error: 'invalid_description', message: 'Description must not exceed 500 characters.' }, 400);
    }
    updates.push('description = ?');
    params.push(description.trim());
  }

  if (system_prompt !== undefined) {
    if (typeof system_prompt !== 'string') {
      return c.json({ error: 'invalid_system_prompt', message: 'System prompt must be a string.' }, 400);
    }
    const maxInstructionsChars = Math.max(1, parseInt(c.env.PREBASE_MAX_INSTRUCTIONS_CHARS ?? '2000', 10));
    if (system_prompt.length > maxInstructionsChars) {
      return c.json({ error: 'invalid_system_prompt', message: `Bot owner instructions must not exceed ${maxInstructionsChars} characters.` }, 400);
    }
    updates.push('system_prompt = ?');
    params.push(system_prompt.trim());
  }

  if (updates.length === 0) {
    return c.json({ error: 'no_updates', message: 'No fields provided to update.' }, 400);
  }

  const ownerId = c.get('userId');
  const now = Math.floor(Date.now() / 1000);

  updates.push('updated_at = ?');
  params.push(now);

  params.push(botId);
  params.push(ownerId);

  const result = await c.env.DB.prepare(
    `UPDATE bots SET ${updates.join(', ')} WHERE id = ? AND owner_id = ?`
  ).bind(...params).run();

  if (!result.success || result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }

  return c.json({ success: true, updated_at: now });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// Delete my bot
// ---------------------------------------------------------------------------
bots.delete('/:id', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);
  const ownerId = c.get('userId');

  const result = await c.env.DB.prepare(
    `DELETE FROM bots WHERE id = ? AND owner_id = ?`
  ).bind(botId, ownerId).run();

  if (!result.success || result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /:id/publish
// Publish my bot
// ---------------------------------------------------------------------------
bots.post('/:id/publish', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
  }

  const { confirmed } = body as Record<string, unknown>;
  if (confirmed !== true) {
    return c.json({ error: 'unconfirmed', message: 'Publishing requires explicit confirmation.' }, 400);
  }

  const ownerId = c.get('userId');
  const now = Math.floor(Date.now() / 1000);

  const result = await c.env.DB.prepare(
    `UPDATE bots SET is_public = 1, updated_at = ? WHERE id = ? AND owner_id = ?`
  ).bind(now, botId, ownerId).run();

  if (!result.success || result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /:id/unpublish
// Unpublish my bot
// ---------------------------------------------------------------------------
bots.post('/:id/unpublish', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);

  const ownerId = c.get('userId');
  const now = Math.floor(Date.now() / 1000);

  const result = await c.env.DB.prepare(
    `UPDATE bots SET is_public = 0, updated_at = ? WHERE id = ? AND owner_id = ?`
  ).bind(now, botId, ownerId).run();

  if (!result.success || result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /:id/knowledge
// List knowledge sources
// ---------------------------------------------------------------------------
bots.get('/:id/knowledge', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);

  const ownerId = c.get('userId');

  // Verify ownership
  const bot = await c.env.DB.prepare('SELECT id FROM bots WHERE id = ? AND owner_id = ?')
    .bind(botId, ownerId).first();
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, filename, byte_size, chunk_count, uploaded_at, enrichment_status, source_type
     FROM kb_sources
     WHERE bot_id = ?
     ORDER BY uploaded_at DESC`
  ).bind(botId).all();

  const maxSources = Math.max(1, parseInt(c.env.PREBASE_MAX_SOURCES_PER_BOT ?? '2', 10));
  return c.json({ sources: results, slots_used: results.length, slots_total: maxSources });
});

// ---------------------------------------------------------------------------
// POST /:id/knowledge
// Upload knowledge
// ---------------------------------------------------------------------------
bots.post('/:id/knowledge', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);
  const ownerId = c.get('userId');

  // Verify ownership
  const bot = await c.env.DB.prepare('SELECT id FROM bots WHERE id = ? AND owner_id = ?')
    .bind(botId, ownerId).first();
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  // Parse multipart form data
  let formData: Record<string, string | File | (string | File)[]>;
  try {
    formData = await c.req.parseBody();
  } catch {
    return c.json({ error: 'invalid_form', message: 'Invalid form data.' }, 400);
  }

  const file = formData['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'invalid_file', message: 'Missing or invalid file.' }, 400);
  }

  // Validate filename
  const filename = file.name.trim();
  if (!filename || filename.length > 255) {
    return c.json({ error: 'invalid_filename', message: 'Invalid filename.' }, 400);
  }

  // Validate file type
  if (!filename.toLowerCase().endsWith('.txt') && !filename.toLowerCase().endsWith('.md')) {
    return c.json({ error: 'unsupported_type', message: 'Only .txt and .md files are supported.' }, 400);
  }

  // Validate single file size limit (new architecture: 10 KB per file)
  const maxFileSizeBytes = Math.max(1, parseInt(c.env.PREBASE_MAX_KB_FILE_BYTES ?? '10240', 10));
  if (file.size > maxFileSizeBytes) {
    return c.json({
      error: 'payload_too_large',
      message: `File exceeds the maximum size of ${Math.round(maxFileSizeBytes / 1024)} KB per knowledge source.`
    }, 413);
  }

  // Check slot count against the 2-slot limit
  const maxSources = Math.max(1, parseInt(c.env.PREBASE_MAX_SOURCES_PER_BOT ?? '2', 10));

  const { results: existingSources } = await c.env.DB.prepare(
    'SELECT id FROM kb_sources WHERE bot_id = ?'
  ).bind(botId).all<{ id: number }>();

  if (existingSources.length >= maxSources) {
    return c.json({ error: 'too_many_sources', message: `Maximum of ${maxSources} knowledge source slots reached. Delete an existing source to upload a new one.` }, 409);
  }

  // Decode text
  let text: string;
  try {
    text = await file.text();
  } catch {
    return c.json({ error: 'invalid_encoding', message: 'Failed to read file as text.' }, 400);
  }

  const textBytes = new TextEncoder().encode(text).byteLength;

  // Chunk text
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return c.json({ error: 'empty_file', message: 'File contains no usable text.' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  // D1 Batch transaction to guarantee atomic insertion of source + chunks
  // 1. Insert kb_sources and RETURNING id
  const enrichmentOptIn = formData['enrichment'] === 'true' || formData['enrichment'] === '1';

  const sourceResult = await c.env.DB.prepare(
    `INSERT INTO kb_sources (bot_id, filename, byte_size, chunk_count, uploaded_at, enrichment_status, source_type)
     VALUES (?, ?, ?, ?, ?, ?, 'file')
     RETURNING id`
  ).bind(botId, filename, textBytes, chunks.length, now, enrichmentOptIn ? 'queued' : 'not_requested').first<{ id: number }>();

  if (!sourceResult) {
    return c.json({ error: 'insert_failed', message: 'Failed to create knowledge source.' }, 500);
  }
  const sourceId = sourceResult.id;

  // 2. Insert kb_chunks
  const chunkStmts = chunks.map(chunk => 
    c.env.DB.prepare(
      `INSERT INTO kb_chunks (bot_id, source_id, chunk_index, content) VALUES (?, ?, ?, ?) RETURNING id`
    ).bind(botId, sourceId, chunk.chunkIndex, chunk.content)
  );

  // Execute chunk insertions in batch. The triggers on kb_chunks will sync kb_fts.
  const batchResults = await c.env.DB.batch(chunkStmts);

  // Dispatch to Smart Enrichment Queue (Explicit Opt-in ONLY)
  

  if (enrichmentOptIn) {
    const maxChunksPerJob = parseInt(c.env.PREBASE_ENRICH_MAX_CHUNKS_PER_JOB || '25', 10);
    
    // Build queue messages using the returned chunk IDs
    const queueMessages: { body: any }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkIdResult = batchResults[i].results[0] as { id: number } | undefined;
      if (chunkIdResult) {
        queueMessages.push({
          body: {
            version: 1,
            chunkId: chunkIdResult.id,
            botId,
            sourceId
          }
        });
      }
    }

    // Send messages in batches to respect Queue batch limits
    for (let i = 0; i < queueMessages.length; i += maxChunksPerJob) {
      const batch = queueMessages.slice(i, i + maxChunksPerJob);
      await c.env.ENRICHMENT_QUEUE.sendBatch(batch);
    }
  }

  return c.json({ id: sourceId, filename, byte_size: textBytes, chunk_count: chunks.length, uploaded_at: now, enrichment_status: enrichmentOptIn ? 'queued' : 'not_requested', source_type: 'file' }, 201);
});

// ---------------------------------------------------------------------------
// POST /:id/knowledge/text
// Add a direct text knowledge source (whole-KB architecture)
// ---------------------------------------------------------------------------
bots.post('/:id/knowledge/text', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);
  const ownerId = c.get('userId');

  // Verify ownership
  const bot = await c.env.DB.prepare('SELECT id FROM bots WHERE id = ? AND owner_id = ?')
    .bind(botId, ownerId).first();
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'invalid_body', message: 'Request body must be a JSON object.' }, 400);
  }

  const { text, label } = body as Record<string, unknown>;

  if (typeof text !== 'string' || text.trim().length === 0) {
    return c.json({ error: 'invalid_text', message: 'text is required and must be a non-empty string.' }, 400);
  }

  const maxTextChars = Math.max(1, parseInt(c.env.PREBASE_MAX_KB_TEXT_CHARS ?? '2000', 10));
  if (text.length > maxTextChars) {
    return c.json({ error: 'text_too_long', message: `Knowledge text must not exceed ${maxTextChars} characters.` }, 400);
  }

  // Label is an optional display name for this text source (e.g. 'FAQ', 'Policy')
  const displayLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 100) : 'text-input';

  // Check slot count against limit
  const maxSources = Math.max(1, parseInt(c.env.PREBASE_MAX_SOURCES_PER_BOT ?? '2', 10));
  const { results: existingSources } = await c.env.DB.prepare(
    'SELECT id FROM kb_sources WHERE bot_id = ?'
  ).bind(botId).all<{ id: number }>();

  if (existingSources.length >= maxSources) {
    return c.json({ error: 'too_many_sources', message: `Maximum of ${maxSources} knowledge source slots reached. Delete an existing source to add new knowledge.` }, 409);
  }

  const trimmedText = text.trim();
  const textBytes = new TextEncoder().encode(trimmedText).byteLength;
  const chunks = chunkText(trimmedText);

  if (chunks.length === 0) {
    return c.json({ error: 'empty_text', message: 'Text contains no usable content.' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  // Filename for text sources uses the label + .txt extension for traceability
  const filename = `${displayLabel}.txt`;

  const sourceResult = await c.env.DB.prepare(
    `INSERT INTO kb_sources (bot_id, filename, byte_size, chunk_count, uploaded_at, enrichment_status, source_type)
     VALUES (?, ?, ?, ?, ?, 'not_requested', 'text')
     RETURNING id`
  ).bind(botId, filename, textBytes, chunks.length, now).first<{ id: number }>();

  if (!sourceResult) {
    return c.json({ error: 'insert_failed', message: 'Failed to create knowledge source.' }, 500);
  }
  const sourceId = sourceResult.id;

  // Insert chunks in batch
  const chunkStmts = chunks.map(chunk =>
    c.env.DB.prepare(
      `INSERT INTO kb_chunks (bot_id, source_id, chunk_index, content) VALUES (?, ?, ?, ?)`
    ).bind(botId, sourceId, chunk.chunkIndex, chunk.content)
  );
  await c.env.DB.batch(chunkStmts);

  return c.json({
    id: sourceId,
    filename,
    label: displayLabel,
    byte_size: textBytes,
    chunk_count: chunks.length,
    uploaded_at: now,
    source_type: 'text',
  }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /:id/knowledge/:sourceId
// Delete a knowledge source
// ---------------------------------------------------------------------------
bots.delete('/:id/knowledge/:sourceId', async (c) => {
  const botId = c.req.param('id');
  const sourceId = parseInt(c.req.param('sourceId'), 10);
  
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);
  if (isNaN(sourceId)) return c.json({ error: 'invalid_source_id', message: 'Invalid source ID' }, 400);

  const ownerId = c.get('userId');

  // Verify ownership
  const bot = await c.env.DB.prepare('SELECT id FROM bots WHERE id = ? AND owner_id = ?')
    .bind(botId, ownerId).first();
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  const result = await c.env.DB.prepare(
    `DELETE FROM kb_sources WHERE id = ? AND bot_id = ?`
  ).bind(sourceId, botId).run();

  if (!result.success || result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Source not found.' }, 404);
  }

  // Deletion cascades to kb_chunks, which fires trigger to clean up kb_fts.
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /:id/chat
// Private preview chat
// ---------------------------------------------------------------------------
bots.post('/:id/chat', async (c) => {
  const botId = c.req.param('id');
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'invalid_body', message: 'Request body must be a JSON object.' }, 400);
  }

  const { message } = body as Record<string, unknown>;

  if (message === undefined || message === null) {
    return c.json({ error: 'missing_message', message: 'message is required.' }, 400);
  }
  if (typeof message !== 'string') {
    return c.json({ error: 'invalid_message', message: 'message must be a string.' }, 400);
  }
  if (message.trim().length === 0) {
    return c.json({ error: 'empty_message', message: 'message must not be empty.' }, 400);
  }
  
  const maxLen = Math.max(1, parseInt(c.env.PREBASE_MAX_MESSAGE_LEN ?? '2000', 10));
  if (message.length > maxLen) {
    return c.json({ error: 'message_too_long', message: `message must not exceed ${maxLen} characters.` }, 400);
  }

  const ownerId = c.get('userId');

  // Verify ownership
  const bot = await c.env.DB.prepare('SELECT id, system_prompt FROM bots WHERE id = ? AND owner_id = ?')
    .bind(botId, ownerId).first<{ id: string; system_prompt: string }>();
    
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  const today = new Date().toISOString().slice(0, 10);

  // Authenticated preview limit
  const previewLimit = Math.max(1, parseInt(c.env.PREBASE_PREVIEW_LIMIT ?? '100', 10));
  const previewCheck = await checkPreviewLimit(c.env.DB, ownerId, today, previewLimit);
  if (!previewCheck.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        message: 'Daily preview limit reached. Please try again tomorrow.',
      },
      429
    );
  }

  const ragResult = await executeRagPipeline(
    c.env,
    botId,
    bot.system_prompt,
    message,
    today
  );

  if (ragResult.status !== 200) {
    return c.json(
      { error: ragResult.error, message: ragResult.message },
      ragResult.status as any
    );
  }

  return c.json({ answer: ragResult.answer });
});

export default bots;
