import { executeRagPipeline } from './rag';
import { PREBASE_CORE_POLICY } from './corePrompt';
// Mock retrieval
jest.mock('./retrieval', () => {
  return {
    FTS5Engine: jest.fn().mockImplementation(() => {
      return {
        search: jest.fn().mockResolvedValue([{ content: 'MOCK_KNOWLEDGE_CHUNK', score: -1.0 }]),
      };
    }),
  };
});

// Mock ratelimit
jest.mock('./ratelimit', () => ({
  readGlobalAiUsage: jest.fn().mockResolvedValue({ usage: 0, isExhausted: false }),
  incrementGlobalAiUsage: jest.fn().mockResolvedValue(undefined),
}));

describe('RAG Pipeline Integration', () => {
  let mockRun: jest.Mock;

  beforeEach(() => {
    mockRun = jest.fn().mockResolvedValue({ response: 'Mock Answer' });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('constructs and sends the Trust-Layered prompt exactly to the AI', async () => {
    const mockDb = {} as any;
    const mockEnv = {
      DB: mockDb,
      AI: { run: mockRun },
      PREBASE_AI_MODEL: '@cf/meta/llama-2-7b-chat-int8',
      PREBASE_CHAR_BUDGET: '1000',
      PREBASE_MIN_BM25_SCORE: '-0.5',
    } as any;

    await executeRagPipeline(
      mockEnv,
      'bot-123',
      'Mock owner instructions',
      'Mock user message',
      '2023-01-01'
    );

    expect(mockRun).toHaveBeenCalledTimes(1);

    const callArgs = mockRun.mock.calls[0];
    const model = callArgs[0];
    const payload = callArgs[1];

    expect(model).toBe('@cf/meta/llama-2-7b-chat-int8');
    expect(payload.messages).toBeDefined();
    expect(payload.messages.length).toBe(2);

    const systemMessage = payload.messages[0];
    const userMessage = payload.messages[1];

    expect(systemMessage.role).toBe('system');
    expect(userMessage.role).toBe('user');

    // T0
    expect(systemMessage.content).toContain(PREBASE_CORE_POLICY);
    
    // T1
    expect(systemMessage.content).toContain('<BOT_OWNER_INSTRUCTIONS>');
    expect(systemMessage.content).toContain('Mock owner instructions');

    // T2
    expect(systemMessage.content).toContain('<UNTRUSTED_KNOWLEDGE>');
    expect(systemMessage.content).toContain('MOCK_KNOWLEDGE_CHUNK');

    // T3
    expect(userMessage.content).toContain('<USER_INPUT>');
    expect(userMessage.content).toContain('Mock user message');

    // Ordering validation: T0 -> T1 -> T2
    const t0Index = systemMessage.content.indexOf('CORE RULES:');
    const t1Index = systemMessage.content.indexOf('<BOT_OWNER_INSTRUCTIONS>');
    const t2Index = systemMessage.content.indexOf('<UNTRUSTED_KNOWLEDGE>');

    expect(t0Index).toBeGreaterThan(-1);
    expect(t1Index).toBeGreaterThan(t0Index);
    expect(t2Index).toBeGreaterThan(t1Index);
  });
});
