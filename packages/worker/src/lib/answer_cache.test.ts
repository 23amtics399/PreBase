import {
  buildCacheKey,
  getCachedAnswer,
  setCachedAnswer,
  purgeExpiredCacheEntries,
} from './answer_cache';
import type { D1Database } from '@cloudflare/workers-types';

describe('Answer Cache (D1 backed)', () => {
  describe('buildCacheKey', () => {
    it('produces consistent keys for the same bot, timestamp, and message', async () => {
      const key1 = await buildCacheKey('bot-1', 1700000000, 'What is the return policy?');
      const key2 = await buildCacheKey('bot-1', 1700000000, 'What is the return policy?');
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^bot-1:1700000000:[a-f0-9]{64}$/);
    });

    it('normalizes messages (case and whitespace invariant)', async () => {
      const key1 = await buildCacheKey('bot-1', 1700000000, '  What  is the return policy?  ');
      const key2 = await buildCacheKey('bot-1', 1700000000, 'what is the return policy?');
      expect(key1).toBe(key2);
    });

    it('invalidates cache when botUpdatedAt changes', async () => {
      const key1 = await buildCacheKey('bot-1', 1700000000, 'question');
      const key2 = await buildCacheKey('bot-1', 1700000001, 'question');
      expect(key1).not.toBe(key2);
    });

    it('isolates cache between different bots', async () => {
      const keyA = await buildCacheKey('bot-A', 1700000000, 'question');
      const keyB = await buildCacheKey('bot-B', 1700000000, 'question');
      expect(keyA).not.toBe(keyB);
    });
  });

  describe('getCachedAnswer', () => {
    it('returns null if db is null or missing prepare', async () => {
      expect(await getCachedAnswer(null as any, 'key')).toBeNull();
      expect(await getCachedAnswer({} as any, 'key')).toBeNull();
    });

    it('returns null on cache miss', async () => {
      const db = {
        prepare: jest.fn().mockReturnValue({
          bind: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue(null),
        }),
      } as unknown as D1Database;

      const result = await getCachedAnswer(db, 'nonexistent-key');
      expect(result).toBeNull();
    });

    it('returns null if entry has expired', async () => {
      const past = Math.floor(Date.now() / 1000) - 100;
      const db = {
        prepare: jest.fn().mockReturnValue({
          bind: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({ answer: 'old answer', expires_at: past }),
        }),
      } as unknown as D1Database;

      const result = await getCachedAnswer(db, 'expired-key');
      expect(result).toBeNull();
    });

    it('returns cached answer if entry is valid and unexpired', async () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      const db = {
        prepare: jest.fn().mockReturnValue({
          bind: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({ answer: 'Valid cached answer', expires_at: future }),
        }),
      } as unknown as D1Database;

      const result = await getCachedAnswer(db, 'valid-key');
      expect(result).toBe('Valid cached answer');
    });

    it('returns null if db throws an error', async () => {
      const db = {
        prepare: jest.fn().mockImplementation(() => {
          throw new Error('D1 connection failed');
        }),
      } as unknown as D1Database;

      const result = await getCachedAnswer(db, 'error-key');
      expect(result).toBeNull();
    });
  });

  describe('setCachedAnswer', () => {
    it('executes INSERT OR REPLACE with 24-hour TTL', async () => {
      const runMock = jest.fn().mockResolvedValue({ success: true });
      const bindMock = jest.fn().mockReturnValue({ run: runMock });
      const prepareMock = jest.fn().mockReturnValue({ bind: bindMock });
      const db = { prepare: prepareMock } as unknown as D1Database;

      await setCachedAnswer(db, 'cache-key-1', 'Granite synthesized answer');

      expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('INSERT OR REPLACE INTO answer_cache'));
      expect(bindMock).toHaveBeenCalledWith(
        'cache-key-1',
        'Granite synthesized answer',
        expect.any(Number),
        expect.any(Number)
      );
      const createdAt = bindMock.mock.calls[0][2];
      const expiresAt = bindMock.mock.calls[0][3];
      expect(expiresAt - createdAt).toBe(86400); // 24 hours TTL
      expect(runMock).toHaveBeenCalled();
    });

    it('fails silently without throwing if db write fails', async () => {
      const db = {
        prepare: jest.fn().mockReturnValue({
          bind: jest.fn().mockReturnValue({
            run: jest.fn().mockRejectedValue(new Error('D1 write error')),
          }),
        }),
      } as unknown as D1Database;

      await expect(setCachedAnswer(db, 'key', 'ans')).resolves.not.toThrow();
    });

    it('safely handles missing or incomplete db object', async () => {
      await expect(setCachedAnswer(null as any, 'key', 'ans')).resolves.not.toThrow();
      await expect(setCachedAnswer({} as any, 'key', 'ans')).resolves.not.toThrow();
    });
  });

  describe('purgeExpiredCacheEntries', () => {
    it('deletes entries where expires_at < now', async () => {
      const runMock = jest.fn().mockResolvedValue({ success: true });
      const bindMock = jest.fn().mockReturnValue({ run: runMock });
      const prepareMock = jest.fn().mockReturnValue({ bind: bindMock });
      const db = { prepare: prepareMock } as unknown as D1Database;

      await purgeExpiredCacheEntries(db);

      expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM answer_cache WHERE expires_at < ?'));
      expect(bindMock).toHaveBeenCalledWith(expect.any(Number));
      expect(runMock).toHaveBeenCalled();
    });

    it('fails silently if purge statement fails', async () => {
      const db = {
        prepare: jest.fn().mockImplementation(() => {
          throw new Error('Table does not exist');
        }),
      } as unknown as D1Database;

      await expect(purgeExpiredCacheEntries(db)).resolves.not.toThrow();
    });
  });
});
