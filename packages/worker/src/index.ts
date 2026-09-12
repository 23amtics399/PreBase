import { Hono } from 'hono';
import type { Bindings } from './lib/types';
import type { MessageBatch, ExecutionContext } from '@cloudflare/workers-types';
import widget from './routes/widget';
import auth from './routes/auth';
import bots from './routes/bots';
import menu from './routes/menu';
import { cors } from 'hono/cors';

const app = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Global Middleware (Security Headers)
// ---------------------------------------------------------------------------
app.use('*', async (c, next) => {
  await next();

  // Baseline security headers for all Worker responses
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Protect authenticated dashboard APIs against clickjacking/framing.
  // We explicitly EXEMPT /chat/* and /api/widget/* because they are 
  // designed to be embedded in external customer iframes.
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith('/chat/') && !path.startsWith('/api/widget')) {
    c.res.headers.set('X-Frame-Options', 'DENY');
    // For JSON APIs, CSP frame-ancestors is defense-in-depth
    c.res.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none';");
  }
});

// ---------------------------------------------------------------------------
// Global Error Handling
// ---------------------------------------------------------------------------
app.onError((err, c) => {
  // Log the internal error safely to Cloudflare (not exposed to user)
  console.error('[Global Error]:', err.message);
  // Return generic 500 without stack traces
  return c.json({ error: 'internal_error', message: 'An internal error occurred.' }, 500);
});

app.notFound((c) => {
  // Safe generic 404
  return c.json({ error: 'not_found', message: 'The requested resource was not found.' }, 404);
});


// ---------------------------------------------------------------------------
// Public widget API
// ---------------------------------------------------------------------------
app.use('/api/widget/*', cors({ origin: '*' }));
app.route('/api/widget', widget);

// ---------------------------------------------------------------------------
// Authentication API
// ---------------------------------------------------------------------------
app.route('/api/auth', auth);

// ---------------------------------------------------------------------------
// Bot Management API
// ---------------------------------------------------------------------------
app.route('/api/bots', bots);

// ---------------------------------------------------------------------------
// Menu / Quick Answers API (authenticated — nested under /api/bots/:botId/menu)
// ---------------------------------------------------------------------------
app.route('/api/bots/:botId/menu', menu);

// ---------------------------------------------------------------------------
// Public share page: /chat/:botId
// Serves the existing frame.html with the bot ID passed as a query parameter.
// The frame.html fetches public bot metadata from /api/widget/bot/:botId and
// handles the 404 case (private/nonexistent bot) gracefully.
// Bot ID validation prevents arbitrary strings from reaching the redirect.
// ---------------------------------------------------------------------------
const BOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

app.get('/chat/:botId', (c) => {
  const botId = c.req.param('botId');
  if (!BOT_ID_RE.test(botId)) {
    return c.text('Not found.', 404);
  }
  // Cloudflare Static Assets serves frame.html at /frame (clean URLs strip .html).
  // Redirecting to /frame?bot=<id> avoids the extra 307 hop from /frame.html.
  return c.redirect(`/frame?bot=${encodeURIComponent(botId)}`);
});


import { handleEnrichmentBatch, EnrichmentMessage } from './lib/enrichment';

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<EnrichmentMessage>, env: Bindings, _ctx: ExecutionContext) {
    // handleEnrichmentBatch manages per-message ack/retry internally.
    // We must NOT throw here — a batch-level throw would retry ALL messages.
    try {
      await handleEnrichmentBatch(batch.messages, env);
    } catch (err) {
      // Unexpected error in the batch runner itself (not a per-message failure).
      // Log safely and let Cloudflare Queue retry the batch.
      console.error('[Queue] Unexpected error in enrichment batch runner:', String(err));
      throw err;
    }
  }
};
