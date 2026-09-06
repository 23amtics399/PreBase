import { Hono } from 'hono';
import botsRouter from './bots';
import type { Bindings, Variables } from '../lib/types';
import * as ratelimit from '../lib/ratelimit';
import * as rag from '../lib/rag';

jest.mock('../lib/ratelimit', () => ({
  ...jest.requireActual('../lib/ratelimit'),
  checkPreviewLimit: jest.fn(),
}));

jest.mock('../lib/rag', () => ({
  ...jest.requireActual('../lib/rag'),
  executeRagPipeline: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  authMiddleware: jest.fn(async (_c, next) => {
    await next();
  }),
}));

function buildEnv(overrides: Partial<Bindings> = {}): { DB: { prepare: jest.Mock; batch: jest.Mock }; mockStmt: any } {
  const mockStmt = {
    bind: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    all: jest.fn().mockResolvedValue({ results: [] }),
    run: jest.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  const mockDb = { 
    prepare: jest.fn().mockReturnValue(mockStmt),
    batch: jest.fn().mockResolvedValue([{ success: true }])
  };

  return {
    DB: mockDb,
    mockStmt,
    ...overrides,
  } as any;
}

function buildApp(userId: string = 'user_123') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  // Mock auth middleware
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/api/bots', botsRouter);
  return app;
}

async function post(env: any, path: string, body: any, headers: any = {}, userId: string = 'user_123') {
  const app = buildApp(userId);
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
  return app.fetch(req, env, ctx);
}

async function get(env: any, path: string, headers: any = {}, userId: string = 'user_123') {
  const app = buildApp(userId);
  const req = new Request(`http://localhost${path}`, {
    method: 'GET',
    headers,
  });
  const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
  return app.fetch(req, env, ctx);
}

async function patch(env: any, path: string, body: any, headers: any = {}, userId: string = 'user_123') {
  const app = buildApp(userId);
  const req = new Request(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
  return app.fetch(req, env, ctx);
}

async function del(env: any, path: string, headers: any = {}, userId: string = 'user_123') {
  const app = buildApp(userId);
  const req = new Request(`http://localhost${path}`, {
    method: 'DELETE',
    headers,
  });
  const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
  return app.fetch(req, env, ctx);
}

describe('Bots API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/bots', () => {
    it('should create a bot successfully', async () => {
      const env = buildEnv();
      const res = await post(env, '/api/bots', { name: 'Test Bot', description: 'desc', system_prompt: 'prompt' });
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.name).toBe('Test Bot');
      expect(data.id).toBeDefined();
      expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO bots'));
      expect(env.mockStmt.bind).toHaveBeenCalledWith(
        expect.any(String), 'user_123', 'Test Bot', 'desc', 'prompt', expect.any(Number), expect.any(Number)
      );
    });

    it('should reject invalid names', async () => {
      const env = buildEnv();
      const res = await post(env, '/api/bots', { name: '', description: 'desc' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/bots', () => {
    it('should list bots for owner', async () => {
      const env = buildEnv();
      env.mockStmt.all.mockResolvedValueOnce({
        results: [{ id: 'bot_1', name: 'Bot 1' }]
      });
      const res = await get(env, '/api/bots');
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.bots).toHaveLength(1);
      expect(data.bots[0].name).toBe('Bot 1');
    });
  });

  describe('GET /api/bots/:id', () => {
    it('should get bot details if owner', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce({ id: 'bot_1', name: 'Bot 1' });
      const res = await get(env, '/api/bots/bot_1');
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.name).toBe('Bot 1');
    });

    it('should return 404 if not found or not owner', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce(null);
      const res = await get(env, '/api/bots/bot_1');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/bots/:id', () => {
    it('should update bot fields', async () => {
      const env = buildEnv();
      const res = await patch(env, '/api/bots/bot_1', { name: 'New Name' });
      expect(res.status).toBe(200);
      expect(env.mockStmt.bind).toHaveBeenCalledWith('New Name', expect.any(Number), 'bot_1', 'user_123');
    });
  });

  describe('DELETE /api/bots/:id', () => {
    it('should delete a bot', async () => {
      const env = buildEnv();
      const res = await del(env, '/api/bots/bot_1');
      expect(res.status).toBe(200);
      expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM bots'));
    });
  });

  describe('POST /api/bots/:id/publish', () => {
    it('should require explicit confirmation to publish', async () => {
      const env = buildEnv();
      const res = await post(env, '/api/bots/bot_1/publish', { confirmed: true });
      expect(res.status).toBe(200);
      expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('is_public = 1'));
    });
    
    it('should reject without confirmation', async () => {
      const env = buildEnv();
      const res = await post(env, '/api/bots/bot_1/publish', {});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/bots/:id/knowledge', () => {
    it('should upload knowledge and chunk correctly', async () => {
      const env = buildEnv({ PREBASE_MAX_KB_SIZE: '10000', PREBASE_MAX_UPLOAD_SIZE: '5000' });
      env.mockStmt.first
        .mockResolvedValueOnce({ id: 'bot_1' }) // Verify ownership
        .mockResolvedValueOnce({ id: 99 }); // source id
      env.mockStmt.all.mockResolvedValueOnce({ results: [] }); // Current byte_size

      const app = buildApp('user_123');
      const formData = new FormData();
      
      const fileContent = "This is a test document. ".repeat(10);
      const file = new File([fileContent], "test.txt", { type: "text/plain" });
      formData.append("file", file);

      const req = new Request('http://localhost/api/bots/bot_1/knowledge', {
        method: 'POST',
        body: formData,
      });
      const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
      const res = await app.fetch(req, env, ctx);
      
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.id).toBe(99);
      expect(env.DB.batch).toHaveBeenCalled();
    });

    it('should reject uploads exceeding limits', async () => {
      const env = buildEnv({ PREBASE_MAX_KB_SIZE: '10', PREBASE_MAX_UPLOAD_SIZE: '5000' });
      env.mockStmt.first.mockResolvedValueOnce({ id: 'bot_1' }); // Verify ownership
      env.mockStmt.all.mockResolvedValueOnce({ results: [{ byte_size: 5 }] }); // Current byte_size

      const app = buildApp('user_123');
      const formData = new FormData();
      
      const fileContent = "This is a test document that is larger than 5 bytes.";
      const file = new File([fileContent], "test.txt", { type: "text/plain" });
      formData.append("file", file);

      const req = new Request('http://localhost/api/bots/bot_1/knowledge', {
        method: 'POST',
        body: formData,
      });
      const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
      const res = await app.fetch(req, env, ctx);
      
      expect(res.status).toBe(413);
      const data = await res.json() as any;
      expect(data.error).toBe('payload_too_large');
    });
  });

  describe('POST /api/bots/:id/chat', () => {
    it('should handle private preview chat successfully', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce({ id: 'bot_1', system_prompt: 'prompt' });
      
      (ratelimit.checkPreviewLimit as jest.Mock).mockResolvedValueOnce({ allowed: true });
      (rag.executeRagPipeline as jest.Mock).mockResolvedValueOnce({ status: 200, answer: 'Preview AI response' });

      const res = await post(env, '/api/bots/bot_1/chat', { message: 'hello' });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.answer).toBe('Preview AI response');
    });

    it('should enforce preview rate limits', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce({ id: 'bot_1', system_prompt: 'prompt' });
      
      (ratelimit.checkPreviewLimit as jest.Mock).mockResolvedValueOnce({ allowed: false });

      const res = await post(env, '/api/bots/bot_1/chat', { message: 'hello' });
      expect(res.status).toBe(429);
      const data = await res.json() as any;
      expect(data.error).toBe('rate_limited');
    });
  });
});
