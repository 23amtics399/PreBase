import { Hono } from 'hono';
import type { Bindings } from '../lib/types';
import { executeRagPipeline } from '../lib/rag';
import { hashToken as hashIp } from '../lib/crypto';
import {
  checkIpGlobalLimit,
  checkBotIpLimit,
  checkBotGlobalLimit,
  checkVisitorBurstLimit,
} from '../lib/ratelimit';

const widget = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex for valid bot IDs (UUIDv4 pattern: hex + hyphens, or alphanumeric/underscore).
 * Prevents arbitrary strings from reaching the DB query.
 */
const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BURST_LIMIT = 10; // max 10 messages per visitor per bot per minute

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns current Unix minute bucket (floor of Unix timestamp / 60).
 * Used as the key for the visitor burst rate limiter.
 */
function currentMinuteBucket(): number {
  return Math.floor(Date.now() / 1000 / 60);
}

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

  const { botId, message, visitorId } = body as Record<string, unknown>;

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
  // 2. Derive rate-limit keys
  // CF-Connecting-IP is set by Cloudflare's edge; absent in local dev.
  // visitorId is a browser-generated UUID from localStorage (optional).
  // Falls back to IP when absent or invalid.
  // ------------------------------------------------------------------
  const rawIp = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
  const ipHash = await hashIp(c.env.RATE_LIMIT_SECRET + rawIp);
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' UTC

  // Visitor hash: prefer browser visitorId, fall back to IP hash
  const rawVisitorId =
    typeof visitorId === 'string' && visitorId.trim().length > 0 && visitorId.length <= 128
      ? visitorId.trim()
      : rawIp;
  const visitorHash = await hashIp(c.env.RATE_LIMIT_SECRET + rawVisitorId);

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
      `SELECT id, name, system_prompt, updated_at, quick_answers_enabled
       FROM bots WHERE id = ? AND is_public = 1`
    )
    .bind(botId)
    .first<{ id: string; name: string; system_prompt: string; updated_at: number; quick_answers_enabled: number }>();

  if (!bot) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }

  // ------------------------------------------------------------------
  // 5. Visitor burst limit (dedicated table, per-visitor per-bot per-minute)
  //    Runs before KB load and before AI quota. Returns 429 immediately.
  //    No AI quota consumed. No KB load.
  // ------------------------------------------------------------------
  const minuteBucket = currentMinuteBucket();
  const burstCheck = await checkVisitorBurstLimit(
    c.env.DB,
    botId,
    visitorHash,
    minuteBucket,
    BURST_LIMIT
  );
  if (!burstCheck.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        message: 'Too many messages. Please wait a moment before sending more.',
      },
      429
    );
  }

  // ------------------------------------------------------------------
  // 6. Per-bot-per-IP limit
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
  // 7. Per-bot global daily limit
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
  // 8. Call shared RAG pipeline
  //    Pass botUpdatedAt so the answer cache key is version-locked.
  // ------------------------------------------------------------------
  const ragResult = await executeRagPipeline(
    c.env,
    botId,
    bot.system_prompt,
    message,
    today,
    bot.updated_at ?? 0
    // Note: no waitUntil in widget route — we await the cache write inline.
    // This is acceptable for the widget since the sync cost is negligible
    // (a single D1 INSERT after successful AI inference).
  );

  // ------------------------------------------------------------------
  // 9. Handle AI quota exhaustion gracefully (HTTP 200 with fallback menu)
  // ------------------------------------------------------------------
  if (ragResult._rag.ragStatus === 'fallback_ai_quota') {
    const menuItems = await loadMenuItems(c.env.DB, botId);
    const supportContact = extractSupportContact(bot.system_prompt);

    return c.json({
      answer: null,
      quota_exhausted: true,
      fallback_message: ragResult.message,
      menu: menuItems.length > 0 ? menuItems : null,
      support_contact: menuItems.length === 0 ? supportContact : null,
    });
  }

  // ------------------------------------------------------------------
  // 10. Normal response
  // ------------------------------------------------------------------
  if (ragResult.status !== 200) {
    return c.json(
      { error: ragResult.error, message: ragResult.message },
      ragResult.status as any
    );
  }

  // If quick answers are enabled, include them in the response for the widget
  const quickAnswers =
    bot.quick_answers_enabled === 1 ? await loadMenuItems(c.env.DB, botId) : [];

  return c.json({
    answer: ragResult.answer,
    quick_answers: quickAnswers.length > 0 ? quickAnswers : undefined,
  });
});

// ---------------------------------------------------------------------------
// POST /chat/menu-respond
// Submit a quick-answer selection — returns the owner-authored response
// without consuming any AI quota.
// ---------------------------------------------------------------------------

widget.post('/chat/menu-respond', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const { botId, itemId, visitorId } = body as Record<string, unknown>;

  if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) {
    return c.json({ error: 'invalid_bot_id' }, 400);
  }
  if (typeof itemId !== 'number' && typeof itemId !== 'string') {
    return c.json({ error: 'invalid_item_id' }, 400);
  }
  const parsedItemId = typeof itemId === 'number' ? itemId : parseInt(String(itemId), 10);
  if (isNaN(parsedItemId) || parsedItemId <= 0) {
    return c.json({ error: 'invalid_item_id' }, 400);
  }

  // Bot must be public
  const bot = await c.env.DB
    .prepare('SELECT id FROM bots WHERE id = ? AND is_public = 1')
    .bind(botId)
    .first<{ id: string }>();
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  // Visitor burst limit applies to menu-respond too (no AI quota consumed)
  const rawIp = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
  const rawVisitorId =
    typeof visitorId === 'string' && visitorId.trim().length > 0 && visitorId.length <= 128
      ? visitorId.trim()
      : rawIp;
  const visitorHash = await hashIp(c.env.RATE_LIMIT_SECRET + rawVisitorId);
  const burstCheck = await checkVisitorBurstLimit(
    c.env.DB, botId, visitorHash, currentMinuteBucket(), BURST_LIMIT
  );
  if (!burstCheck.allowed) {
    return c.json({ error: 'rate_limited', message: 'Too many messages. Please wait.' }, 429);
  }

  // Fetch the specific menu item
  const item = await c.env.DB
    .prepare('SELECT label, response FROM bot_menu_items WHERE id = ? AND bot_id = ?')
    .bind(parsedItemId, botId)
    .first<{ label: string; response: string }>();

  if (!item) {
    return c.json({ error: 'not_found', message: 'Menu item not found.' }, 404);
  }

  return c.json({ answer: item.response, label: item.label });
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
    .prepare('SELECT id, name, quick_answers_enabled FROM bots WHERE id = ? AND is_public = 1')
    .bind(botId)
    .first<{ id: string; name: string; quick_answers_enabled: number }>();

  if (!bot) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }

  const quickAnswers =
    bot.quick_answers_enabled === 1 ? await loadMenuItems(c.env.DB, botId) : [];

  return c.json({
    id: bot.id,
    name: bot.name,
    quick_answers_enabled: bot.quick_answers_enabled === 1,
    quick_answers: quickAnswers.length > 0 ? quickAnswers : undefined,
  });
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

import type { D1Database } from '@cloudflare/workers-types';

async function loadMenuItems(db: D1Database, botId: string) {
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    const stmt = db.prepare(
      `SELECT id, label, response, display_order
       FROM bot_menu_items WHERE bot_id = ?
       ORDER BY display_order ASC, id ASC
       LIMIT 8`
    );
    if (!stmt || typeof stmt.bind !== 'function') return [];
    const bound = stmt.bind(botId);
    if (!bound || typeof bound.all !== 'function') return [];
    const { results } = await bound.all<{ id: number; label: string; response: string; display_order: number }>();
    return results ?? [];
  } catch {
    return [];
  }
}

/**
 * Extracts a support contact (email or URL) from the bot's system prompt.
 * Prefers email. Falls back to a URL. Returns null if not found.
 * This intentionally NEVER fabricates a contact.
 */
function extractSupportContact(systemPrompt: string | undefined | null): string | null {
  if (!systemPrompt) return null;
  const emailMatch = systemPrompt.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
  if (emailMatch) return emailMatch[0];
  const urlMatch = systemPrompt.match(/https?:\/\/[^\s"'>]+/);
  if (urlMatch) return urlMatch[0];
  return null;
}

export default widget;
