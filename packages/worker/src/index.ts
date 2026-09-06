import { Hono } from 'hono';
import type { Bindings } from './lib/types';
import widget from './routes/widget';
import auth from './routes/auth';
import bots from './routes/bots';

const app = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Public widget API
// ---------------------------------------------------------------------------
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
// Public share page: /chat/:botId
// Serves the existing frame.html with the bot ID passed as a query parameter.
// The frame.html fetches public bot metadata from /api/widget/bot/:botId and
// handles the 404 case (private/nonexistent bot) gracefully.
// Bot ID validation prevents arbitrary strings from reaching the redirect.
// ---------------------------------------------------------------------------
const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

app.get('/chat/:botId', (c) => {
  const botId = c.req.param('botId');
  if (!BOT_ID_RE.test(botId)) {
    return c.text('Not found.', 404);
  }
  // Cloudflare Static Assets serves frame.html at /frame (clean URLs strip .html).
  // Redirecting to /frame?bot=<id> avoids the extra 307 hop from /frame.html.
  return c.redirect(`/frame?bot=${encodeURIComponent(botId)}`);
});


export default app;
