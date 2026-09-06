import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { hashPassword, verifyPassword, generateSessionToken, hashToken } from '../lib/crypto';
import { authMiddleware } from '../middleware/auth';
import type { Bindings, Variables } from '../lib/types';
import { Context } from 'hono';

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Simple rate limiter for auth (MVP)
async function checkAuthRateLimit(c: Context<{ Bindings: Bindings, Variables: Variables }>, endpoint: string): Promise<boolean> {
  const ip = c.req.header('CF-Connecting-IP') || '127.0.0.1';
  const encoder = new TextEncoder();
  const secret = c.env.RATE_LIMIT_SECRET || 'dev-secret';
  
  // Basic SHA-256 for IP hashing
  const data = encoder.encode(ip + secret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const ipHash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 3600; // 1 hour

  // Check how many attempts in last hour
  const attempts = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM auth_attempts WHERE ip_hash = ? AND endpoint = ? AND attempt_time > ?`
  ).bind(ipHash, endpoint, cutoff).first<{ count: number }>();

  if (attempts && attempts.count >= 20) {
    return false; // Rate limited (20 attempts per hour)
  }

  // Record this attempt
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO auth_attempts (ip_hash, endpoint, attempt_time) VALUES (?, ?, ?)`
    ).bind(ipHash, endpoint, now).run()
  );

  return true;
}

auth.post('/register', async (c) => {
  if (!(await checkAuthRateLimit(c, 'register'))) {
    return c.json({ error: 'Too many attempts' }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  if (!body.email || !body.password || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'Invalid input' }, 400);
  }

  const email = body.email.trim().toLowerCase();
  if (email.length < 5 || body.password.length < 8) {
    return c.json({ error: 'Email or password too short' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM users WHERE email = ?`
  ).bind(email).first();

  if (existing) {
    return c.json({ error: 'Email already in use' }, 400);
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const hashed = await hashPassword(body.password);

  await c.env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`
  ).bind(id, email, hashed, now).run();

  return c.json({ success: true }, 201);
});

auth.post('/login', async (c) => {
  if (!(await checkAuthRateLimit(c, 'login'))) {
    return c.json({ error: 'Too many attempts' }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  if (!body.email || !body.password || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'Invalid input' }, 400);
  }

  const email = body.email.trim().toLowerCase();

  const user = await c.env.DB.prepare(
    `SELECT id, password_hash FROM users WHERE email = ?`
  ).bind(email).first<{ id: string; password_hash: string }>();

  if (!user) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  // Generate session
  const { raw, hash } = await generateSessionToken();
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days

  await c.env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  ).bind(hash, user.id, expiresAt).run();

  // Set cookie
  setCookie(c, 'session_id', raw, {
    httpOnly: true,
    secure: true, // Requires HTTPS (or localhost in dev)
    sameSite: 'Strict',
    maxAge: 7 * 24 * 3600,
    path: '/',
  });

  return c.json({ success: true });
});

auth.post('/logout', async (c) => {
  const sessionId = getCookie(c, 'session_id');
  if (sessionId) {
    const hashedSessionId = await hashToken(sessionId);
    c.executionCtx.waitUntil(
      c.env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(hashedSessionId).run()
    );
  }

  deleteCookie(c, 'session_id', {
    path: '/',
  });

  return c.json({ success: true });
});

auth.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  
  const user = await c.env.DB.prepare(
    `SELECT id, email, created_at FROM users WHERE id = ?`
  ).bind(userId).first();

  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({ user });
});

export default auth;
