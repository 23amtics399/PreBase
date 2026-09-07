import { Hono } from 'hono';
import type { Bindings } from '../lib/types';
import { executeRagPipeline } from '../lib/rag';
import { hashToken as hashIp } from '../lib/crypto';
import { checkIpGlobalLimit, checkBotIpLimit, checkBotGlobalLimit } from '../lib/ratelimit';

const widget = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex for valid bot IDs (UUIDv4 pattern: hex + hyphens, or alphanumeric/underscore).
 * Prevents arbitrary strings from reaching the DB query.
 */
const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// POST /chat
// ---------------------------------------------------------------------------

widget.post('/chat', async (c) => {
  // ------------------------------------------------------------------
  // 1. Parse and validate request body
  // ------------------------------------------------------------------
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_json', message: 'Request body must be valid JSON.' },
      400
    );
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json(
      { error: 'invalid_body', message: 'Request body must be a JSON object.' },
      400
    );
  }

  const { botId, message } = body as Record<string, unknown>;

  // Validate botId
  if (botId === undefined || botId === null) {
    return c.json({ error: 'missing_bot_id', message: 'botId is required.' }, 400);
  }
  if (typeof botId !== 'string') {
    return c.json({ error: 'invalid_bot_id', message: 'botId must be a string.' }, 400);
  }
  if (!BOT_ID_RE.test(botId)) {
    return c.json(
      { error: 'invalid_bot_id', message: 'botId contains invalid characters.' },
      400
    );
  }

  // Validate message
  if (message === undefined || message === null) {
    return c.json({ error: 'missing_message', message: 'message is required.' }, 400);
  }
  if (typeof message !== 'string') {
    return c.json({ error: 'invalid_message', message: 'message must be a string.' }, 400);
  }
  if (message.trim().length === 0) {
    return c.json({ error: 'empty_message', message: 'message must not be empty.' }, 400);
  }
  const maxLen = Math.max(1, parseInt(c.env.PREBASE_MAX_MESSAGE_LEN, 10) || 2000);
  if (message.length > maxLen) {
    return c.json(
      {
        error: 'message_too_long',
        message: `message must not exceed ${maxLen} characters.`,
      },
      400
    );
  }

  // ------------------------------------------------------------------
  // 2. Derive rate-limit key from IP
  // CF-Connecting-IP is set by Cloudflare's edge; absent in local dev.
  // ------------------------------------------------------------------
  const rawIp = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
  const ipHash = await hashIp(c.env.RATE_LIMIT_SECRET + rawIp);
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC

  // ------------------------------------------------------------------
  // 3. Per-IP global rate limit (counts all requests, including fallbacks)
  // ------------------------------------------------------------------
  const ipDailyLimit = Math.max(1, parseInt(c.env.PREBASE_IP_DAILY, 10) || 100);
  const ipCheck = await checkIpGlobalLimit(c.env.DB, today, ipHash, ipDailyLimit);
  if (!ipCheck.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        message: 'Daily request limit reached. Please try again tomorrow.',
      },
      429
    );
  }

  // ------------------------------------------------------------------
  // 4. Bot lookup — 404 for BOTH nonexistent and private bots.
  //    We intentionally do not distinguish the two cases to prevent
  //    unauthenticated callers from enumerating private bot IDs.
  // ------------------------------------------------------------------
  const bot = await c.env.DB
    .prepare(
      'SELECT id, name, system_prompt FROM bots WHERE id = ? AND is_public = 1'
    )
    .bind(botId)
    .first<{ id: string; name: string; system_prompt: string }>();

  if (!bot) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }

  // ------------------------------------------------------------------
  // 5. Per-bot-per-IP limit
  // ------------------------------------------------------------------
  const botIpLimit = Math.max(1, parseInt(c.env.PREBASE_PER_BOT_IP_DAILY, 10) || 20);
  const botIpCheck = await checkBotIpLimit(
    c.env.DB, botId, today, ipHash, botIpLimit
  );
  if (!botIpCheck.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        message: 'Daily limit reached for this bot. Please try again tomorrow.',
      },
      429
    );
  }

  // ------------------------------------------------------------------
  // 6. Per-bot global daily limit
  // ------------------------------------------------------------------
  const botGlobalLimit = Math.max(1, parseInt(c.env.PREBASE_PER_BOT_DAILY, 10) || 500);
  const botGlobalCheck = await checkBotGlobalLimit(
    c.env.DB, botId, today, botGlobalLimit
  );
  if (!botGlobalCheck.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        message: 'This bot has reached its daily message limit. Please try again tomorrow.',
      },
      429
    );
  }

  // ------------------------------------------------------------------
  // 7. Call shared RAG pipeline
  // ------------------------------------------------------------------
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

  return c.json({ answer: ragResult.answer, _rag: ragResult._rag });
});

// ---------------------------------------------------------------------------
// GET /bot/:botId
// ---------------------------------------------------------------------------
widget.get('/bot/:botId', async (c) => {
  const botId = c.req.param('botId');
  if (!BOT_ID_RE.test(botId)) {
    return c.json({ error: 'invalid_bot_id', message: 'Invalid bot ID' }, 400);
  }

  const bot = await c.env.DB
    .prepare('SELECT id, name FROM bots WHERE id = ? AND is_public = 1')
    .bind(botId)
    .first<{ id: string; name: string }>();

  if (!bot) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }

  return c.json({ id: bot.id, name: bot.name });
});

export default widget;
