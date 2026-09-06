export const PBKDF2_ITERATIONS = 100000;

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

/**
 * Hashes a password using PBKDF2-HMAC-SHA256 natively in Web Crypto.
 * Returns the hash encoded as: `pbkdf2-sha256:<iterations>:<saltHex>:<hashHex>`
 */
export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  const saltHex = bufferToHex(salt.buffer);
  const hashHex = bufferToHex(hashBuffer);

  return `pbkdf2-sha256:${PBKDF2_ITERATIONS}:${saltHex}:${hashHex}`;
}

/**
 * Constant-time comparison of two strings.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verifies a password against a stored hash string.
 */
export async function verifyPassword(password: string, storedHashString: string): Promise<boolean> {
  const parts = storedHashString.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') {
    return false; // Invalid format
  }

  const iterations = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const hashHex = parts[3];

  const enc = new TextEncoder();
  const saltBuffer = hexToBuffer(saltHex);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const testHashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  const testHashHex = bufferToHex(testHashBuffer);
  return constantTimeEqual(hashHex, testHashHex);
}

/**
 * Hashes a token securely for database storage (e.g. SHA-256).
 */
export async function hashToken(token: string): Promise<string> {
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return bufferToHex(hashBuffer);
}

/**
 * Generates a random session token.
 * Returns the raw token (to give to the user) and its hashed form (to store in D1).
 */
export async function generateSessionToken(): Promise<{ raw: string; hash: string }> {
  const rawBytes = crypto.getRandomValues(new Uint8Array(32));
  const rawToken = bufferToHex(rawBytes.buffer);
  const hash = await hashToken(rawToken);
  return { raw: rawToken, hash };
}
