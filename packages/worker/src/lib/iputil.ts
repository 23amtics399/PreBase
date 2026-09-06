/**
 * IP address hashing for rate-limit identifiers.
 *
 * WHY NOT PLAIN SHA-256?
 * IPv4 has only ~4.3 billion addresses and large chunks of that space are
 * held by ISPs in known ranges. A plain SHA-256(IP) lookup table could be
 * pre-computed in minutes with commodity hardware, making it trivially
 * reversible — providing no meaningful privacy guarantee.
 *
 * WHY HMAC-SHA256?
 * A keyed HMAC(secret, IP) is only reversible if the attacker knows the
 * secret key. With a 256-bit secret, brute-forcing the key is infeasible.
 * The identifier is safe to store in D1 for rate limiting without exposing
 * the raw IP address.
 *
 * TRADEOFF:
 * This requires a RATE_LIMIT_SECRET to be provisioned and rotated.
 * If the secret is rotated, all existing rate-limit counters effectively
 * reset (old ip_hash values will not match the new HMAC outputs).
 * This is acceptable for an MVP — it means limits could be briefly bypassed
 * after a key rotation, not permanently. A migration strategy can be added later.
 *
 * In production: `wrangler secret put RATE_LIMIT_SECRET`
 * In local dev: a dummy value in wrangler.toml [vars] is acceptable.
 */

/**
 * Derives a rate-limit identifier from a raw IP address using HMAC-SHA256.
 *
 * @param secret  The RATE_LIMIT_SECRET from env — must be non-empty.
 * @param rawIp   The IP address string (e.g., "1.2.3.4" or "::1").
 * @returns A 32-char hex string (128-bit HMAC prefix) suitable for storage.
 */
export async function hashIp(secret: string, rawIp: string): Promise<string> {
  const enc = new TextEncoder();

  // Normalize the IP to prevent trivial bypasses (e.g., "1.2.3.4 " vs "1.2.3.4")
  const normalizedIp = rawIp.trim().toLowerCase();

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,     // not extractable
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(normalizedIp));

  // Convert to hex and take first 32 chars (128 bits).
  // 128-bit HMAC prefix is more than sufficient for rate-limit bucketing
  // while keeping the stored value compact.
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
