import { FTS5Engine } from './retrieval';
import type { D1Database } from '@cloudflare/workers-types';

describe('FTS5Engine', () => {
  it('stops accumulating chunks when character budget is reached', async () => {
    const engine = new FTS5Engine();
    
    // Mock D1 response
    const mockResults = [
      { content: 'chunk 1 text which is 40 chars', chunkIndex: 0, sourceFilename: 'test.md', score: -2.5 },
      { content: 'chunk 2 text which is 40 chars', chunkIndex: 1, sourceFilename: 'test.md', score: -1.5 },
      { content: 'chunk 3 text which is 40 chars', chunkIndex: 2, sourceFilename: 'test.md', score: -0.5 },
    ];
    
    const mockDb = {
      prepare: jest.fn().mockReturnThis(),
      bind: jest.fn().mockReturnThis(),
      all: jest.fn().mockResolvedValue({ results: mockResults })
    } as unknown as D1Database;

    // Budget of 89 characters -> should fit chunk 1 (30) and chunk 2 (30) = 60 chars.
    // Chunk 3 (30 chars) would put it at 90, which exceeds 89, so it should be skipped.
    const results = await engine.search(mockDb, 'bot123', 'search query', 89);
    
    expect(results.length).toBe(2);
    expect(results[0].chunkIndex).toBe(0);
    expect(results[1].chunkIndex).toBe(1);
  });

  it('handles empty results correctly', async () => {
    const engine = new FTS5Engine();
    
    const mockDb = {
      prepare: jest.fn().mockReturnThis(),
      bind: jest.fn().mockReturnThis(),
      all: jest.fn().mockResolvedValue({ results: [] })
    } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot123', 'search query', 90);
    expect(results.length).toBe(0);
  });

  it('returns [] early without touching D1 for an empty string query', async () => {
    // sanitizeFtsQuery('   ') returns null → search() returns [] immediately.
    // No DB round-trip should happen.
    const engine = new FTS5Engine();
    const prepareSpy = jest.fn();
    const mockDb = { prepare: prepareSpy } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot123', '   ', 90);
    expect(results).toHaveLength(0);
    // Critical: D1 was NOT called (prevents wasteful or unsafe queries)
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('returns [] early without touching D1 for a punctuation-only query', async () => {
    const engine = new FTS5Engine();
    const prepareSpy = jest.fn();
    const mockDb = { prepare: prepareSpy } as unknown as D1Database;

    const results = await engine.search(mockDb, 'bot123', ' !@#$ %^&*() ', 90);
    expect(results).toHaveLength(0);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('builds a sanitized OR-joined FTS5 query for normal user input', async () => {
    const engine = new FTS5Engine();
    const mockStmt = {
      bind: jest.fn().mockReturnThis(),
      all:  jest.fn().mockResolvedValue({ results: [] }),
    };
    const mockDb = { prepare: jest.fn().mockReturnValue(mockStmt) } as unknown as D1Database;

    await engine.search(mockDb, 'bot123', 'hello! @world, #test$ %query^', 90);
    // Punctuation stripped → tokens: hello, world, test, query
    expect(mockStmt.bind).toHaveBeenCalledWith('hello OR world OR test OR query', 'bot123');
  });
});
