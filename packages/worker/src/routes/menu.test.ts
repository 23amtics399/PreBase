import { Hono } from 'hono';
import menuRouter from './menu';
import type { Bindings, Variables } from '../lib/types';

jest.mock('../middleware/auth', () => ({
  authMiddleware: jest.fn(async (_c, next) => {
    await next();
  }),
}));

const VALID_BOT_ID = '00000000-0000-4000-8000-000000000456';

function buildApp(userId: string = 'user_123') {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/api/bots/:botId/menu', menuRouter);
  return app;
}

function buildEnv(mockStmtOverrides: Partial<{
  first: jest.Mock;
  all: jest.Mock;
  run: jest.Mock;
}> = {}) {
  const mockStmt = {
    bind: jest.fn().mockReturnThis(),
    first: mockStmtOverrides.first ?? jest.fn().mockResolvedValue({ id: VALID_BOT_ID, quick_answers_enabled: 1 }),
    all: mockStmtOverrides.all ?? jest.fn().mockResolvedValue({ results: [] }),
    run: mockStmtOverrides.run ?? jest.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  const mockDb = {
    prepare: jest.fn().mockReturnValue(mockStmt),
  };
  return { DB: mockDb as any, mockStmt };
}

describe('Menu Router (/api/bots/:botId/menu)', () => {
  describe('GET /', () => {
    it('returns 400 for invalid bot ID format', async () => {
      const app = buildApp();
      const { DB } = buildEnv();
      const res = await app.fetch(
        new Request('http://localhost/api/bots/invalid-bot/menu', { method: 'GET' }),
        { DB }
      );
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe('invalid_bot_id');
    });

    it('returns 404 if bot is not found or not owned by user', async () => {
      const app = buildApp();
      const { DB } = buildEnv({ first: jest.fn().mockResolvedValue(null) });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu`, { method: 'GET' }),
        { DB }
      );
      expect(res.status).toBe(404);
      expect((await res.json() as any).error).toBe('not_found');
    });

    it('returns menu items and quick_answers_enabled flag', async () => {
      const app = buildApp();
      const mockItems = [
        { id: 1, label: 'Shipping', response: '3-5 business days', display_order: 0 },
        { id: 2, label: 'Returns', response: '30-day policy', display_order: 1 },
      ];
      const { DB } = buildEnv({
        first: jest.fn().mockResolvedValue({ id: VALID_BOT_ID, quick_answers_enabled: 1 }),
        all: jest.fn().mockResolvedValue({ results: mockItems }),
      });

      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu`, { method: 'GET' }),
        { DB }
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.quick_answers_enabled).toBe(true);
      expect(data.items).toEqual(mockItems);
    });
  });

  describe('POST /', () => {
    it('returns 400 if label is missing or empty', async () => {
      const app = buildApp();
      const { DB } = buildEnv({ first: jest.fn().mockResolvedValue({ id: VALID_BOT_ID }) });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: '', response: 'Some response' }),
        }),
        { DB }
      );
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe('invalid_label');
    });

    it('returns 400 if label exceeds 40 characters', async () => {
      const app = buildApp();
      const { DB } = buildEnv({ first: jest.fn().mockResolvedValue({ id: VALID_BOT_ID }) });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'A'.repeat(41), response: 'Some response' }),
        }),
        { DB }
      );
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe('label_too_long');
    });

    it('returns 400 if response is missing or exceeds 1000 characters', async () => {
      const app = buildApp();
      const { DB } = buildEnv({ first: jest.fn().mockResolvedValue({ id: VALID_BOT_ID }) });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Label', response: 'R'.repeat(1001) }),
        }),
        { DB }
      );
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe('response_too_long');
    });

    it('returns 409 if maximum 8 menu items already exist', async () => {
      const app = buildApp();
      // First call is bot ownership, second call is count
      let callCount = 0;
      const firstMock = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ id: VALID_BOT_ID });
        return Promise.resolve({ cnt: 8 });
      });
      const { DB } = buildEnv({ first: firstMock });

      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Extra', response: 'Extra info' }),
        }),
        { DB }
      );
      expect(res.status).toBe(409);
      expect((await res.json() as any).error).toBe('menu_full');
    });

    it('creates menu item and returns 201 on success', async () => {
      const app = buildApp();
      let callCount = 0;
      const firstMock = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ id: VALID_BOT_ID });
        if (callCount === 2) return Promise.resolve({ cnt: 2 });
        return Promise.resolve({ id: 42 });
      });
      const { DB } = buildEnv({ first: firstMock });

      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Support', response: 'support@example.com', display_order: 2 }),
        }),
        { DB }
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.id).toBe(42);
      expect(data.label).toBe('Support');
      expect(data.response).toBe('support@example.com');
    });
  });

  describe('PATCH /:itemId', () => {
    it('returns 400 for invalid item ID', async () => {
      const app = buildApp();
      const { DB } = buildEnv();
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu/abc`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Updated' }),
        }),
        { DB }
      );
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe('invalid_params');
    });

    it('returns 404 if menu item is not found or not owned', async () => {
      const app = buildApp();
      const { DB } = buildEnv({
        first: jest.fn().mockResolvedValue({ id: VALID_BOT_ID }),
        run: jest.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu/99`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Updated' }),
        }),
        { DB }
      );
      expect(res.status).toBe(404);
      expect((await res.json() as any).error).toBe('not_found');
    });

    it('updates item and returns 200 on success', async () => {
      const app = buildApp();
      const { DB } = buildEnv({
        first: jest.fn().mockResolvedValue({ id: VALID_BOT_ID }),
        run: jest.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu/1`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Updated FAQ', response: 'New response' }),
        }),
        { DB }
      );
      expect(res.status).toBe(200);
      expect((await res.json() as any).success).toBe(true);
    });
  });

  describe('DELETE /:itemId', () => {
    it('returns 404 if item does not exist', async () => {
      const app = buildApp();
      const { DB } = buildEnv({
        first: jest.fn().mockResolvedValue({ id: VALID_BOT_ID }),
        run: jest.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu/99`, { method: 'DELETE' }),
        { DB }
      );
      expect(res.status).toBe(404);
    });

    it('deletes item and returns 200 on success', async () => {
      const app = buildApp();
      const { DB } = buildEnv({
        first: jest.fn().mockResolvedValue({ id: VALID_BOT_ID }),
        run: jest.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu/1`, { method: 'DELETE' }),
        { DB }
      );
      expect(res.status).toBe(200);
      expect((await res.json() as any).success).toBe(true);
    });
  });

  describe('PATCH /settings', () => {
    it('validates quick_answers_enabled must be a boolean', async () => {
      const app = buildApp();
      const { DB } = buildEnv();
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quick_answers_enabled: 'true' }),
        }),
        { DB }
      );
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe('invalid_param');
    });

    it('updates quick_answers_enabled to true or false', async () => {
      const app = buildApp();
      const { DB } = buildEnv({
        run: jest.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      });
      const res = await app.fetch(
        new Request(`http://localhost/api/bots/${VALID_BOT_ID}/menu/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quick_answers_enabled: true }),
        }),
        { DB }
      );
      expect(res.status).toBe(200);
      expect((await res.json() as any).quick_answers_enabled).toBe(true);
    });
  });
});
