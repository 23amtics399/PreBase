import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { hashToken } from '../lib/crypto';
import type { Bindings, Variables } from '../lib/types';

export async function authMiddleware(c: Context<{ Bindings: Bindings, Variables: Variables }>, next: Next) {
  const sessionId = getCookie(c, 'session_id');

  if (!sessionId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Hash the incoming session token to look it up in D1
  const hashedSessionId = await hashToken(sessionId);

  const session = await c.env.DB.prepare(
    `SELECT user_id, expires_at FROM sessions WHERE token = ?`
  ).bind(hashedSessionId).first<{ user_id: string; expires_at: number }>();

  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Check if session has expired
  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at < now) {
    // Optionally delete expired session immediately
    c.executionCtx.waitUntil(
      c.env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(hashedSessionId).run()
    );
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Set userId on context
  c.set('userId', session.user_id);
  
  await next();
}
