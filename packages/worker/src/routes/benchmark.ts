import { Hono } from 'hono';

const benchmark = new Hono();

benchmark.get('/', async (c) => {
  const enc = new TextEncoder();
  const password = "SuperSecretPassword123!";
  const salt = crypto.getRandomValues(new Uint8Array(16));
  
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const results: Record<string, string> = {};
  const iterations = [100000, 300000, 600000];

  for (const iter of iterations) {
    const start = Date.now();
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: iter,
        hash: "SHA-256",
      },
      keyMaterial,
      256
    );
    const end = Date.now();
    results[iter] = `${end - start}ms`;
  }

  return c.json(results);
});

export default benchmark;
