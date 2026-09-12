/**
 * Menu (Quick Answers) CRUD router — authenticated owner routes.
 *
 * Mounted at /api/bots/:botId/menu
 *
 * Rules enforced here:
 *   - Max 8 items per bot
 *   - Label max 40 chars
 *   - Response max 1,000 chars
 *   - No nesting, no branching, no AI
 *   - quick_answers_enabled flag managed via PATCH /api/bots/:botId/menu/settings
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../lib/types';
import { authMiddleware } from '../middleware/auth';

const menu = new Hono<{ Bindings: Bindings; Variables: Variables }>();
menu.use('*', authMiddleware);

const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateBotId(id: string | undefined): boolean {
  return typeof id === 'string' && BOT_ID_RE.test(id);
}

const MAX_LABEL_CHARS = 40;
const MAX_RESPONSE_CHARS = 1000;
const MAX_ITEMS = 8;

// ---------------------------------------------------------------------------
// Helper: verify ownership and return bot row (or null)
// ---------------------------------------------------------------------------
async function verifyOwnership(env: Bindings, botId: string, ownerId: string) {
  return env.DB
    .prepare('SELECT id, quick_answers_enabled FROM bots WHERE id = ? AND owner_id = ?')
    .bind(botId, ownerId)
    .first<{ id: string; quick_answers_enabled: number }>();
}

// ---------------------------------------------------------------------------
// GET /api/bots/:botId/menu
// List all menu items for this bot
// ---------------------------------------------------------------------------
menu.get('/', async (c) => {
  const botId = c.req.param('botId') ?? '';
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id' }, 400);

  const ownerId = c.get('userId');
  const bot = await verifyOwnership(c.env, botId, ownerId);
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, label, response, display_order, created_at
     FROM bot_menu_items
     WHERE bot_id = ?
     ORDER BY display_order ASC, id ASC`
  ).bind(botId).all();

  return c.json({
    quick_answers_enabled: bot.quick_answers_enabled === 1,
    items: results,
  });
});

// ---------------------------------------------------------------------------
// POST /api/bots/:botId/menu
// Create a new menu item
// ---------------------------------------------------------------------------
menu.post('/', async (c) => {
  const botId = c.req.param('botId') ?? '';
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id' }, 400);

  const ownerId = c.get('userId');
  const bot = await verifyOwnership(c.env, botId, ownerId);
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  // Enforce max 8 items
  const countRow = await c.env.DB
    .prepare('SELECT COUNT(*) as cnt FROM bot_menu_items WHERE bot_id = ?')
    .bind(botId)
    .first<{ cnt: number }>();
  if ((countRow?.cnt ?? 0) >= MAX_ITEMS) {
    return c.json({ error: 'menu_full', message: `Maximum of ${MAX_ITEMS} Quick Answers allowed.` }, 409);
  }

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { label, response, display_order } = body as Record<string, unknown>;

  if (typeof label !== 'string' || label.trim().length === 0) {
    return c.json({ error: 'invalid_label', message: 'label is required.' }, 400);
  }
  if (label.trim().length > MAX_LABEL_CHARS) {
    return c.json({ error: 'label_too_long', message: `label must not exceed ${MAX_LABEL_CHARS} characters.` }, 400);
  }
  if (typeof response !== 'string' || response.trim().length === 0) {
    return c.json({ error: 'invalid_response', message: 'response is required.' }, 400);
  }
  if (response.trim().length > MAX_RESPONSE_CHARS) {
    return c.json({ error: 'response_too_long', message: `response must not exceed ${MAX_RESPONSE_CHARS} characters.` }, 400);
  }

  const order = typeof display_order === 'number' ? Math.max(0, Math.floor(display_order)) : 0;
  const now = Math.floor(Date.now() / 1000);

  const row = await c.env.DB
    .prepare(
      `INSERT INTO bot_menu_items (bot_id, label, response, display_order, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .bind(botId, label.trim(), response.trim(), order, now)
    .first<{ id: number }>();

  if (!row) return c.json({ error: 'insert_failed' }, 500);

  return c.json({ id: row.id, label: label.trim(), response: response.trim(), display_order: order, created_at: now }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /api/bots/:botId/menu/settings
// Enable or disable Quick Answers for this bot
// (Defined before /:itemId to avoid route parameter collision)
// ---------------------------------------------------------------------------
menu.patch('/settings', async (c) => {
  const botId = c.req.param('botId') ?? '';
  if (!validateBotId(botId)) return c.json({ error: 'invalid_bot_id' }, 400);

  const ownerId = c.get('userId');

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { quick_answers_enabled } = body as Record<string, unknown>;
  if (typeof quick_answers_enabled !== 'boolean') {
    return c.json({ error: 'invalid_param', message: 'quick_answers_enabled must be a boolean.' }, 400);
  }

  const result = await c.env.DB
  .prepare('UPDATE bots SET quick_answers_enabled = ? WHERE id = ? AND owner_id = ?')
    .bind(quick_answers_enabled ? 1 : 0, botId, ownerId)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);
  }
  return c.json({ success: true, quick_answers_enabled });
});

// ---------------------------------------------------------------------------
// PATCH /api/bots/:botId/menu/:itemId
// Edit an existing menu item
// ---------------------------------------------------------------------------
menu.patch('/:itemId', async (c) => {
  const botId = c.req.param('botId') ?? '';
  const itemId = parseInt(c.req.param('itemId') ?? '', 10);
  if (!validateBotId(botId) || isNaN(itemId)) return c.json({ error: 'invalid_params' }, 400);

  const ownerId = c.get('userId');
  const bot = await verifyOwnership(c.env, botId, ownerId);
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { label, response, display_order } = body as Record<string, unknown>;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (label !== undefined) {
    if (typeof label !== 'string' || label.trim().length === 0) return c.json({ error: 'invalid_label' }, 400);
    if (label.trim().length > MAX_LABEL_CHARS) return c.json({ error: 'label_too_long', message: `label must not exceed ${MAX_LABEL_CHARS} characters.` }, 400);
    updates.push('label = ?'); params.push(label.trim());
  }
  if (response !== undefined) {
    if (typeof response !== 'string' || response.trim().length === 0) return c.json({ error: 'invalid_response' }, 400);
    if (response.trim().length > MAX_RESPONSE_CHARS) return c.json({ error: 'response_too_long', message: `response must not exceed ${MAX_RESPONSE_CHARS} characters.` }, 400);
    updates.push('response = ?'); params.push(response.trim());
  }
  if (display_order !== undefined) {
    if (typeof display_order !== 'number') return c.json({ error: 'invalid_display_order' }, 400);
    updates.push('display_order = ?'); params.push(Math.max(0, Math.floor(display_order)));
  }

  if (updates.length === 0) return c.json({ error: 'no_updates', message: 'No fields provided.' }, 400);

  params.push(itemId, botId);
  const result = await c.env.DB
    .prepare(`UPDATE bot_menu_items SET ${updates.join(', ')} WHERE id = ? AND bot_id = ?`)
    .bind(...params)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Menu item not found.' }, 404);
  }
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/bots/:botId/menu/:itemId
// Delete a menu item
// ---------------------------------------------------------------------------
menu.delete('/:itemId', async (c) => {
  const botId = c.req.param('botId') ?? '';
  const itemId = parseInt(c.req.param('itemId') ?? '', 10);
  if (!validateBotId(botId) || isNaN(itemId)) return c.json({ error: 'invalid_params' }, 400);

  const ownerId = c.get('userId');
  const bot = await verifyOwnership(c.env, botId, ownerId);
  if (!bot) return c.json({ error: 'not_found', message: 'Bot not found.' }, 404);

  const result = await c.env.DB
    .prepare('DELETE FROM bot_menu_items WHERE id = ? AND bot_id = ?')
    .bind(itemId, botId)
    .run();

  if (!result.success || result.meta.changes === 0) {
    return c.json({ error: 'not_found', message: 'Menu item not found.' }, 404);
  }
  return c.json({ success: true });
});

export default menu;
