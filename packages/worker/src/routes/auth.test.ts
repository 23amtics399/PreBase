import { Hono } from 'hono';
import authRouter from './auth';
import { hashPassword } from '../lib/crypto';
import type { Bindings, Variables } from '../lib/types';

jest.mock('../lib/crypto', () => {
  const original = jest.requireActual('../lib/crypto');
  return {
    ...original,
    // We can mock functions if needed, but for auth we want to test the actual crypto logic
  };
});

function buildEnv(overrides: Partial<Bindings> = {}): { DB: { prepare: jest.Mock }; RATE_LIMIT_SECRET: string; mockStmt: any } {
  const mockStmt = {
    bind: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    all: jest.fn().mockResolvedValue({ results: [] }),
    run: jest.fn().mockResolvedValue({ success: true }),
  };
  const mockDb = { prepare: jest.fn().mockReturnValue(mockStmt) };

  return {
    DB: mockDb,
    RATE_LIMIT_SECRET: 'test-secret',
    mockStmt,
    ...overrides,
  } as any;
}

function buildApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route('/api/auth', authRouter);
  return app;
}

async function post(env: any, path: string, body: any, headers: any = {}) {
  const app = buildApp();
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
  return app.fetch(req, env, ctx);
}

async function get(env: any, path: string, headers: any = {}) {
  const app = buildApp();
  const req = new Request(`http://localhost${path}`, {
    method: 'GET',
    headers,
  });
  const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
  return app.fetch(req, env, ctx);
}



describe('Auth API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user successfully', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;
      // first call is checkAuthRateLimit (COUNT)
      // second call is check email (SELECT id FROM users)
      stmt.first
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce(null);

      const res = await post(env, '/api/auth/register', { email: 'test@prebase.sji.one', password: 'Password123!' });
      expect(res.status).toBe(201);
      
      // INSERT INTO auth_attempts, INSERT INTO users
      expect(stmt.run).toHaveBeenCalledTimes(2);
    });

    it('should reject weak passwords', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;
      stmt.first.mockResolvedValueOnce({ count: 0 }); // rate limit

      const res = await post(env, '/api/auth/register', { email: 'test@prebase.sji.one', password: 'short' });
      expect(res.status).toBe(400);
    });

    it('should reject duplicate emails', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;
      stmt.first
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ id: 'existing_user' });

      const res = await post(env, '/api/auth/register', { email: 'test@prebase.sji.one', password: 'Password123!' });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBe('Email already in use');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login successfully and return cookie', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;
      
      const pHash = await hashPassword('Password123!');

      stmt.first
        .mockResolvedValueOnce({ count: 0 }) // rate limit
        .mockResolvedValueOnce({ id: 'user_123', password_hash: pHash }); // get user

      const res = await post(env, '/api/auth/login', { email: 'test@prebase.sji.one', password: 'Password123!' });
      expect(res.status).toBe(200);

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('session_id=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Strict');

      expect(stmt.run).toHaveBeenCalledTimes(2); // insert rate limit, insert session
    });

    it('should fail with wrong password', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;
      
      const pHash = await hashPassword('Password123!');

      stmt.first
        .mockResolvedValueOnce({ count: 0 }) // rate limit
        .mockResolvedValueOnce({ id: 'user_123', password_hash: pHash }); // get user

      const res = await post(env, '/api/auth/login', { email: 'test@prebase.sji.one', password: 'WrongPassword!' });
      expect(res.status).toBe(401);
    });

    it('should enforce rate limits', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;
      stmt.first.mockResolvedValueOnce({ count: 20 }); // rate limit hit

      const res = await post(env, '/api/auth/login', { email: 'test@prebase.sji.one', password: 'Password123!' });
      expect(res.status).toBe(429);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return user profile if authenticated', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;

      // first call is get session
      stmt.first.mockResolvedValueOnce({ user_id: 'user_123', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      // second call is get user
      stmt.first.mockResolvedValueOnce({ id: 'user_123', email: 'test@prebase.sji.one', created_at: 1000000 });

      const res = await get(env, '/api/auth/me', { Cookie: 'session_id=fake_token' });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.user.id).toBe('user_123');
    });

    it('should fail if session expired', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;

      // get session (expired)
      stmt.first.mockResolvedValueOnce({ user_id: 'user_123', expires_at: 0 });

      const res = await get(env, '/api/auth/me', { Cookie: 'session_id=fake_token' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should clear cookie and delete session', async () => {
      const env = buildEnv();
      const stmt = env.mockStmt;

      const res = await post(env, '/api/auth/logout', {}, { Cookie: 'session_id=fake_token' });
      expect(res.status).toBe(200);

      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('session_id=;'); // Should clear
      
      expect(stmt.run).toHaveBeenCalledTimes(1); // delete session
    });
  });
});
