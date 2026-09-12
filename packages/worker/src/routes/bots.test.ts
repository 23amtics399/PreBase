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
    it('should create a bot successfully when user has 0 bots', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce(null); // No existing bot for user
      const res = await post(env, '/api/bots', { name: 'Test Bot', description: 'desc', system_prompt: 'prompt' });
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.name).toBe('Test Bot');
      expect(data.id).toBeDefined();
      expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO bots'));
    });

    it('should reject bot creation with 403 bot_limit_reached when user already has 1 bot', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000001' }); // Existing bot found
      const res = await post(env, '/api/bots', { name: 'Second Bot', description: 'desc' });
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toBe('bot_limit_reached');
      expect(data.message).toContain('limit of 1 chatbot per account');
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
        results: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Bot 1' }]
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
      env.mockStmt.first.mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000001', name: 'Bot 1' });
      const res = await get(env, '/api/bots/00000000-0000-4000-8000-000000000001');
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.name).toBe('Bot 1');
    });

    it('should return 404 if not found or not owner', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce(null);
      const res = await get(env, '/api/bots/00000000-0000-4000-8000-000000000001');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/bots/:id', () => {
    it('should update bot fields', async () => {
      const env = buildEnv();
      const res = await patch(env, '/api/bots/00000000-0000-4000-8000-000000000001', { name: 'New Name' });
      expect(res.status).toBe(200);
      expect(env.mockStmt.bind).toHaveBeenCalledWith('New Name', expect.any(Number), '00000000-0000-4000-8000-000000000001', 'user_123');
    });
  });

  describe('DELETE /api/bots/:id', () => {
    it('should delete a bot', async () => {
      const env = buildEnv();
      const res = await del(env, '/api/bots/00000000-0000-4000-8000-000000000001');
      expect(res.status).toBe(200);
      expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM bots'));
    });
  });

  describe('POST /api/bots/:id/publish', () => {
    it('should require explicit confirmation to publish', async () => {
      const env = buildEnv();
      const res = await post(env, '/api/bots/00000000-0000-4000-8000-000000000001/publish', { confirmed: true });
      expect(res.status).toBe(200);
      expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('is_public = 1'));
    });
    
    it('should reject without confirmation', async () => {
      const env = buildEnv();
      const res = await post(env, '/api/bots/00000000-0000-4000-8000-000000000001/publish', {});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/bots/:id/knowledge', () => {
    it('should upload knowledge without enrichment by default', async () => {
      const env = buildEnv({ PREBASE_MAX_KB_SIZE: '10000', PREBASE_MAX_UPLOAD_SIZE: '5000', ENRICHMENT_QUEUE: { sendBatch: jest.fn() } as any });
      env.mockStmt.first
        .mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000001' }) // Verify ownership
        .mockResolvedValueOnce({ id: 99 }); // source id
      env.mockStmt.all.mockResolvedValueOnce({ results: [] }); // Current byte_size

      const app = buildApp('user_123');
      const formData = new FormData();
      
      const fileContent = "This is a test document. ".repeat(10);
      const file = new File([fileContent], "test.txt", { type: "text/plain" });
      formData.append("file", file);

      const req = new Request('http://localhost/api/bots/00000000-0000-4000-8000-000000000001/knowledge', {
        method: 'POST',
        body: formData,
      });
      const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
      const res = await app.fetch(req, env, ctx);
      
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.id).toBe(99);
      expect(data.enrichment_status).toBe('not_requested');
      expect(env.DB.batch).toHaveBeenCalled();
      expect((env as any).ENRICHMENT_QUEUE.sendBatch).not.toHaveBeenCalled();
    });

    it('should upload knowledge and queue enrichment when requested', async () => {
      const env = buildEnv({ PREBASE_MAX_KB_SIZE: '10000', PREBASE_MAX_UPLOAD_SIZE: '5000', ENRICHMENT_QUEUE: { sendBatch: jest.fn() } as any });
      env.mockStmt.first
        .mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000001' }) // Verify ownership
        .mockResolvedValueOnce({ id: 99 }); // source id
      env.mockStmt.all.mockResolvedValueOnce({ results: [] }); // Current byte_size

      const app = buildApp('user_123');
      const formData = new FormData();
      
      const fileContent = "This is a test document. ".repeat(10);
      const file = new File([fileContent], "test.txt", { type: "text/plain" });
      formData.append("file", file);
      formData.append("enrichment", "true");

      // Mock the batch results that returns chunk IDs
      env.DB.batch = jest.fn().mockResolvedValue([{ results: [{ id: 101 }] }]);

      const req = new Request('http://localhost/api/bots/00000000-0000-4000-8000-000000000001/knowledge', {
        method: 'POST',
        body: formData,
      });
      const ctx = { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any;
      const res = await app.fetch(req, env, ctx);
      
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.id).toBe(99);
      expect(data.enrichment_status).toBe('queued');
      expect(env.DB.batch).toHaveBeenCalled();
      expect((env as any).ENRICHMENT_QUEUE.sendBatch).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({
          body: { version: 1, chunkId: 101, botId: '00000000-0000-4000-8000-000000000001', sourceId: 99 }
        })
      ]));
    });

    it('should reject uploads exceeding limits', async () => {
      const env = buildEnv({ PREBASE_MAX_KB_FILE_BYTES: '10' });
      env.mockStmt.first.mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000001' }); // Verify ownership

      const app = buildApp('user_123');
      const formData = new FormData();
      
      const fileContent = "This is a test document that is larger than 5 bytes.";
      const file = new File([fileContent], "test.txt", { type: "text/plain" });
      formData.append("file", file);

      const req = new Request('http://localhost/api/bots/00000000-0000-4000-8000-000000000001/knowledge', {
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

  describe('KB Input Constraints & Instruction Limits (New Architecture)', () => {
    const botId = '00000000-0000-4000-8000-000000000001';

    it('enforces maximum 2,000 characters for bot instructions on creation', async () => {
      const env = buildEnv({ PREBASE_MAX_INSTRUCTIONS_CHARS: '2000' });
      // Valid instructions (<= 2,000 chars)
      const validRes = await post(env, '/api/bots', {
        name: 'Test Bot',
        system_prompt: 'A'.repeat(2000)
      });
      expect(validRes.status).toBe(201);

      // Over 2,000 chars rejected
      const invalidRes = await post(env, '/api/bots', {
        name: 'Too Long Bot',
        system_prompt: 'A'.repeat(2001)
      });
      expect(invalidRes.status).toBe(400);
      const data = await invalidRes.json() as any;
      expect(data.error).toBe('invalid_system_prompt');
      expect(data.message).toContain('2000');
    });

    it('enforces maximum 2,000 characters for bot instructions on update (PATCH)', async () => {
      const env = buildEnv({ PREBASE_MAX_INSTRUCTIONS_CHARS: '2000' });
      env.mockStmt.run.mockResolvedValueOnce({ success: true, meta: { changes: 1 } });

      const validPatch = await patch(env, `/api/bots/${botId}`, {
        system_prompt: 'B'.repeat(2000)
      });
      expect(validPatch.status).toBe(200);

      const invalidPatch = await patch(env, `/api/bots/${botId}`, {
        system_prompt: 'B'.repeat(2001)
      });
      expect(invalidPatch.status).toBe(400);
      const data = await invalidPatch.json() as any;
      expect(data.error).toBe('invalid_system_prompt');
    });

    it('enforces maximum 10 KB per uploaded file', async () => {
      const env = buildEnv({ PREBASE_MAX_KB_FILE_BYTES: '10240' });
      env.mockStmt.first.mockResolvedValue({ id: botId });
      env.mockStmt.all.mockResolvedValue({ results: [] }); // 0 sources currently

      const app = buildApp('user_123');

      // 10240 bytes (10 KB) -> allowed
      const validFile = new File(['A'.repeat(10240)], 'valid.txt', { type: 'text/plain' });
      const validForm = new FormData();
      validForm.append('file', validFile);
      const req1 = new Request(`http://localhost/api/bots/${botId}/knowledge`, {
        method: 'POST',
        body: validForm,
      });
      const res1 = await app.fetch(req1, env, { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any);
      expect(res1.status).toBe(201);

      // 10241 bytes -> rejected
      const invalidFile = new File(['A'.repeat(10241)], 'toolarge.txt', { type: 'text/plain' });
      const invalidForm = new FormData();
      invalidForm.append('file', invalidFile);
      const req2 = new Request(`http://localhost/api/bots/${botId}/knowledge`, {
        method: 'POST',
        body: invalidForm,
      });
      const res2 = await app.fetch(req2, env, { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any);
      expect(res2.status).toBe(413);
      const data2 = await res2.json() as any;
      expect(data2.error).toBe('payload_too_large');
    });

    it('enforces maximum 2,000 characters per direct-text knowledge source', async () => {
      const env = buildEnv({ PREBASE_MAX_KB_TEXT_CHARS: '2000' });
      env.mockStmt.first
        .mockResolvedValueOnce({ id: botId }) // ownership check
        .mockResolvedValueOnce({ id: 101 });   // RETURNING id
      env.mockStmt.all.mockResolvedValueOnce({ results: [] }); // 0 sources

      // 2000 characters -> allowed
      const validRes = await post(env, `/api/bots/${botId}/knowledge/text`, {
        text: 'C'.repeat(2000),
        label: 'Policy'
      });
      expect(validRes.status).toBe(201);

      // 2001 characters -> rejected
      env.mockStmt.first.mockResolvedValueOnce({ id: botId });
      const invalidRes = await post(env, `/api/bots/${botId}/knowledge/text`, {
        text: 'C'.repeat(2001),
        label: 'Policy'
      });
      expect(invalidRes.status).toBe(400);
      const data = await invalidRes.json() as any;
      expect(data.error).toBe('text_too_long');
    });

    it('allows 2 files (max 2 slots)', async () => {
      const env = buildEnv({ PREBASE_MAX_SOURCES_PER_BOT: '2' });
      env.mockStmt.first
        .mockResolvedValueOnce({ id: botId }) // ownership check
        .mockResolvedValueOnce({ id: 201 });   // RETURNING id
      // When 1 source exists, 2nd file upload succeeds
      env.mockStmt.all.mockResolvedValueOnce({ results: [{ id: 1 }] });

      const app = buildApp('user_123');
      const file = new File(['This is the second knowledge base document with sufficient text length.'], 'second.txt', { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', file);
      const req = new Request(`http://localhost/api/bots/${botId}/knowledge`, {
        method: 'POST',
        body: formData,
      });
      const res = await app.fetch(req, env, { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any);
      expect(res.status).toBe(201);
    });

    it('allows 1 direct-text source + 1 file', async () => {
      const env = buildEnv({ PREBASE_MAX_SOURCES_PER_BOT: '2' });
      env.mockStmt.first
        .mockResolvedValueOnce({ id: botId }) // ownership check
        .mockResolvedValueOnce({ id: 202 });   // RETURNING id
      // 1 existing file source, adding direct-text source -> allowed
      env.mockStmt.all.mockResolvedValueOnce({ results: [{ id: 1 }] });

      const res = await post(env, `/api/bots/${botId}/knowledge/text`, {
        text: 'This is direct text knowledge content with sufficient text length to be indexed.',
        label: 'FAQ'
      });
      expect(res.status).toBe(201);
    });

    it('allows 2 direct-text sources (max 2 slots)', async () => {
      const env = buildEnv({ PREBASE_MAX_SOURCES_PER_BOT: '2' });
      env.mockStmt.first
        .mockResolvedValueOnce({ id: botId }) // ownership check
        .mockResolvedValueOnce({ id: 203 });   // RETURNING id
      // 1 existing text source, adding 2nd direct-text source -> allowed
      env.mockStmt.all.mockResolvedValueOnce({ results: [{ id: 1 }] });

      const res = await post(env, `/api/bots/${botId}/knowledge/text`, {
        text: 'Second direct text knowledge content with sufficient length.',
        label: 'Policy'
      });
      expect(res.status).toBe(201);
    });

    it('rejects a 3rd knowledge source when 2 already exist (too_many_sources)', async () => {
      const env = buildEnv({ PREBASE_MAX_SOURCES_PER_BOT: '2' });
      env.mockStmt.first.mockResolvedValue({ id: botId });
      // 2 sources already exist
      env.mockStmt.all.mockResolvedValue({ results: [{ id: 1 }, { id: 2 }] });

      // Attempt 3rd via file
      const app = buildApp('user_123');
      const file = new File(['Third source content'], 'third.txt', { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', file);
      const reqFile = new Request(`http://localhost/api/bots/${botId}/knowledge`, {
        method: 'POST',
        body: formData,
      });
      const resFile = await app.fetch(reqFile, env, { waitUntil: jest.fn(), passThroughOnException: jest.fn() } as any);
      expect(resFile.status).toBe(409);
      const dataFile = await resFile.json() as any;
      expect(dataFile.error).toBe('too_many_sources');

      // Attempt 3rd via direct-text
      const resText = await post(env, `/api/bots/${botId}/knowledge/text`, {
        text: 'Third text source.',
        label: 'Extra'
      });
      expect(resText.status).toBe(409);
      const dataText = await resText.json() as any;
      expect(dataText.error).toBe('too_many_sources');
    });

    it('confirms instructions do not consume a knowledge-source slot', async () => {
      const env = buildEnv({ PREBASE_MAX_SOURCES_PER_BOT: '2' });
      // Even if 2 knowledge sources exist, updating bot instructions still succeeds
      env.mockStmt.run.mockResolvedValueOnce({ success: true, meta: { changes: 1 } });

      const patchRes = await patch(env, `/api/bots/${botId}`, {
        system_prompt: 'Updated instructions that do not touch knowledge slots.'
      });
      expect(patchRes.status).toBe(200);
    });
  });

  describe('POST /api/bots/:id/chat', () => {
    it('should handle private preview chat successfully', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000001', system_prompt: 'prompt' });
      
      (ratelimit.checkPreviewLimit as jest.Mock).mockResolvedValueOnce({ allowed: true });
      (rag.executeRagPipeline as jest.Mock).mockResolvedValueOnce({ status: 200, answer: 'Preview AI response' });

      const res = await post(env, '/api/bots/00000000-0000-4000-8000-000000000001/chat', { message: 'hello' });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.answer).toBe('Preview AI response');
    });

    it('should enforce preview rate limits', async () => {
      const env = buildEnv();
      env.mockStmt.first.mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000001', system_prompt: 'prompt' });
      
      (ratelimit.checkPreviewLimit as jest.Mock).mockResolvedValueOnce({ allowed: false });

      const res = await post(env, '/api/bots/00000000-0000-4000-8000-000000000001/chat', { message: 'hello' });
      expect(res.status).toBe(429);
      const data = await res.json() as any;
      expect(data.error).toBe('rate_limited');
    });
  });
});
