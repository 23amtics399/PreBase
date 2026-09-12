/**
 * D1-backed answer cache for successful Granite synthesis responses.
 *
 * Cache key: `<botId>:<botUpdatedAt>:<sha256(normalizedMessage)>`
 *
 * Only `ai_called` responses are stored. Security refusals, grounding
 * answers, errors, and rate-limit responses are NEVER cached.
 *
 * TTL: 24 hours (86400 seconds). Best-effort async cleanup via executionCtx.waitUntil.
 */

import type { D1Database } from '@cloudflare/workers-types';

const CACHE_TTL_SECONDS = 86400; // 24 hours

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 hex digest of the given string using the Web Crypto API.
 */
async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Normalizes a user message for cache key computation.
 * Trims, lowercases, collapses whitespace.
 */
function normalizeMessage(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Builds the D1 cache key for a given (botId, botUpdatedAt, message) triple.
 * botUpdatedAt is the Unix timestamp from bots.updated_at and acts as the
 * cache invalidation signal — it changes whenever instructions or KB change.
 */
export async function buildCacheKey(
  botId: string,
  botUpdatedAt: number,
  message: string
): Promise<string> {
  const msgHash = await sha256Hex(normalizeMessage(message));
  return `${botId}:${botUpdatedAt}:${msgHash}`;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Looks up a cached answer. Returns null on miss, if entry is expired,
 * or if the database is uninitialized / unavailable.
 */
export async function getCachedAnswer(
  db: D1Database,
  cacheKey: string
): Promise<string | null> {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare('SELECT answer, expires_at FROM answer_cache WHERE cache_key = ?');
    if (!stmt || typeof stmt.bind !== 'function') return null;
    const bound = stmt.bind(cacheKey);
    if (!bound || typeof bound.first !== 'function') return null;
    const row = await bound.first<{ answer: string; expires_at: number }>();

    if (!row) return null;
    if (typeof row.expires_at !== 'number' || row.expires_at < now) return null; // Expired or invalid — treat as miss
    if (typeof row.answer !== 'string') return null;
    return row.answer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Stores a successful Granite answer in the cache.
 * Uses INSERT OR REPLACE to handle rare concurrent writes gracefully.
 * Fails silently if database is unavailable or write fails (caching is best-effort).
 */
export async function setCachedAnswer(
  db: D1Database,
  cacheKey: string,
  answer: string
): Promise<void> {
  if (!db || typeof db.prepare !== 'function') return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO answer_cache (cache_key, answer, created_at, expires_at)
       VALUES (?, ?, ?, ?)`
    );
    if (!stmt || typeof stmt.bind !== 'function') return;
    const bound = stmt.bind(cacheKey, answer, now, now + CACHE_TTL_SECONDS);
    if (!bound || typeof bound.run !== 'function') return;
    await bound.run();
  } catch {
    // Non-blocking write failure: caching is best-effort optimization
  }
}

// ---------------------------------------------------------------------------
// Cleanup (best-effort, run in waitUntil)
// ---------------------------------------------------------------------------

/**
 * Deletes expired cache entries. Call inside executionCtx.waitUntil()
 * to avoid blocking the response.
 */
export async function purgeExpiredCacheEntries(db: D1Database): Promise<void> {
  if (!db || typeof db.prepare !== 'function') return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare('DELETE FROM answer_cache WHERE expires_at < ?');
    if (!stmt || typeof stmt.bind !== 'function') return;
    const bound = stmt.bind(now);
    if (!bound || typeof bound.run !== 'function') return;
    await bound.run();
  } catch {
    // Non-blocking cleanup failure
  }
}
