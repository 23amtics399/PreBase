import { FTS5Engine } from './retrieval';
import type { D1Database } from '@cloudflare/workers-types';

describe('FTS5Engine — two-pass retrieval', () => {
  it('stops accumulating chunks when character budget is reached', async () => {
    const engine = new FTS5Engine();

    const mockResults = [
      { content: 'chunk 1 text which is 40 chars', chunkIndex: 0, sourceFilename: 'test.md', score: -2.5 },
      { content: 'chunk 2 text which is 40 chars', chunkIndex: 1, sourceFilename: 'test.md', score: -1.5 },
      { content: 'chunk 3 text which is 40 chars', chunkIndex: 2, sourceFilename: 'test.md', score: -0.5 },
    ];

    const mockDb = {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          all: jest.fn().mockResolvedValue({ results: mockResults }),
        }),
      }),
    } as unknown as D1Database;

    // Budget of 89 characters → fits chunk1 (30) + chunk2 (30) = 60 chars.
    // Chunk3 (30 chars) would push to 90, exceeds 89 → skipped.
    const results = await engine.search(mockDb, 'bot123', 'search query', 89);
    expect(results.length).toBe(2);
    expect(results[0].chunkIndex).toBe(0);
    expect(results[1].chunkIndex).toBe(1);
  });

  it('handles empty results correctly', async () => {
    const engine = new FTS5Engine();

    const mockDb = {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          all: jest.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot123', 'search query', 90);
    expect(results.length).toBe(0);
  });

  it('returns [] early without touching D1 for empty string query', async () => {
    const engine = new FTS5Engine();
    const prepareSpy = jest.fn();
    const mockDb = { prepare: prepareSpy } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot123', '   ', 90);
    expect(results).toHaveLength(0);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('returns [] early without touching D1 for punctuation-only query', async () => {
    const engine = new FTS5Engine();
    const prepareSpy = jest.fn();
    const mockDb = { prepare: prepareSpy } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot123', ' !@#$ %^&*() ', 90);
    expect(results).toHaveLength(0);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('uses AND-joined content tokens for a normal user query', async () => {
    const engine = new FTS5Engine();
    const mockBind = jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue({ results: [] }) });
    const mockStmt = { bind: mockBind };
    const mockDb = { prepare: jest.fn().mockReturnValue(mockStmt) } as unknown as D1Database;

    // "How" (stop), "must" (stop), "be" (stop) removed → "often", "passwords", "changed" remain
    await engine.search(mockDb, 'bot123', 'How often must passwords be changed?', 90);
    expect(mockBind).toHaveBeenCalledWith('often AND passwords AND changed', 'bot123');
  });

  it('falls back to OR query when AND returns empty results', async () => {
    const engine = new FTS5Engine();

    // First call (AND) returns empty; second call (OR fallback) returns one result
    const orResults = [
      { content: 'Password policy chunk', chunkIndex: 0, sourceFilename: 'policy.txt', score: -3.5 },
    ];

    let callCount = 0;
    const mockBind = jest.fn().mockImplementation(() => ({
      all: jest.fn().mockResolvedValue({ results: callCount++ === 0 ? [] : orResults }),
    }));
    const mockDb = {
      prepare: jest.fn().mockReturnValue({ bind: mockBind }),
    } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot123', 'often passwords changed', 500);

    // Should have returned the OR fallback result
    expect(results.length).toBe(1);
    expect(results[0].content).toBe('Password policy chunk');

    // First bind call should be AND, second should be OR
    expect(mockBind.mock.calls[0][0]).toContain('AND');
    expect(mockBind.mock.calls[1][0]).toContain('OR');
  });

  it('does NOT issue OR fallback if AND already returned results', async () => {
    const engine = new FTS5Engine();
    let prepareCallCount = 0;

    const andResults = [
      { content: 'Passwords must be changed every 90 days.', chunkIndex: 0, sourceFilename: 'policy.txt', score: -5.0 },
    ];

    const mockDb = {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          all: jest.fn().mockImplementation(() => {
            prepareCallCount++;
            return Promise.resolve({ results: andResults });
          }),
        }),
      }),
    } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot123', 'passwords changed', 500);
    expect(results.length).toBe(1);
    // Only one DB round-trip (the AND pass)
    expect(prepareCallCount).toBe(1);
  });

  it('[regression] short single-sentence bot_a docs are retrievable via broad query', async () => {
    // bot_a content: "Product A costs 999. It is a premium vacuum cleaner with 400W suction power."
    // Query: "How much does Product A cost?" → sanitised to "Product AND cost"
    // This tests that single-chunk small docs pass the char budget check.
    const engine = new FTS5Engine();
    const smallDocResults = [
      { content: 'Product A costs 999. It is a premium vacuum cleaner.', chunkIndex: 0, sourceFilename: 'bot_a.txt', score: -4.2 },
    ];

    const mockDb = {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          all: jest.fn().mockResolvedValue({ results: smallDocResults }),
        }),
      }),
    } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot-a-id', 'How much does Product A cost?', 3600);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('Product A');
  });
});
