import { handleEnrichmentBatch, enrichChunk } from './enrichment';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock the network fetch for Gemini
global.fetch = jest.fn() as any;

describe('enrichChunk', () => {
  beforeEach(() => {
    (global.fetch as any).mockClear();
  });

  it('handles missing API key', async () => {
    const res = await enrichChunk('', 'model', 'text');
    expect(res).toBeNull();
  });

  it('returns parsed structured data on success', async () => {
    const mockGeminiResponse = {
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              questions: ['Q1'],
              aliases: ['A1'],
              keywords: ['K1'],
              topics: ['T1'],
              entities: ['E1'],
              negative_constraints: ['NC1']
            })
          }]
        }
      }]
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockGeminiResponse
    });

    const res = await enrichChunk('key', 'model', 'text');
    expect(res).toEqual({
      questions: ['Q1'],
      aliases: ['A1'],
      keywords: ['K1'],
      topics: ['T1'],
      entities: ['E1'],
      negative_constraints: ['NC1']
    });
  });

  it('returns null on fetch failure', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request'
    });

    const res = await enrichChunk('key', 'model', 'text');
    expect(res).toBeNull();
  });
});

describe('handleEnrichmentBatch', () => {
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = {
      GEMINI_API_KEY: 'test-key',
      PREBASE_GEMINI_MODEL: 'test-model',
      PREBASE_ENRICH_MAX_RETRIES: '1',
      DB: {
        prepare: jest.fn().mockReturnThis(),
        bind: jest.fn().mockReturnThis(),
        first: (jest.fn() as any).mockResolvedValue({ content: 'test-content' }),
        run: (jest.fn() as any).mockResolvedValue({ success: true })
      }
    };
    (global.fetch as any).mockClear();
  });

  it('processes messages and inserts into DB', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ questions: ['Q1'] }) }] }
        }]
      })
    });

    await handleEnrichmentBatch([{
      body: { version: 1, chunkId: 1, botId: 'b1', sourceId: 1 },
      attempts: 1,
      id: 'msg-1',
      timestamp: new Date()
    } as any], mockEnv);

    expect(mockEnv.DB.prepare).toHaveBeenCalledTimes(4); // processing, select chunk, insert enrichment, update completed
    expect(mockEnv.DB.prepare().bind).toHaveBeenCalledWith(
      1,
      '["Q1"]', '[]', '[]', '[]', '[]', '[]',
      'test-model',
      expect.any(Number),
      expect.any(Number)
    );
  });

  it('throws error if enrichment fails after retries', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false, status: 500, text: async () => 'Error'
    });

    await expect(handleEnrichmentBatch([{
      body: { version: 1, chunkId: 1, botId: 'b1', sourceId: 1 },
      attempts: 3, // Simulate final attempt
      id: 'msg-1',
      timestamp: new Date()
    } as any], mockEnv)).rejects.toThrow('Failed to enrich chunk 1');

    // processing, select chunk, failed
    expect(mockEnv.DB.prepare).toHaveBeenCalledTimes(3);
  });
});
