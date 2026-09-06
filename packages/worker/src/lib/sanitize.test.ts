import { sanitizeFtsQuery } from './sanitize';

describe('sanitizeFtsQuery', () => {
  // --- Normal inputs ---
  it('returns OR-joined tokens for a plain English question', () => {
    const result = sanitizeFtsQuery('What is your return policy?');
    expect(result).toBe('What OR is OR your OR return OR policy');
  });

  it('handles mixed alphanumeric text', () => {
    const result = sanitizeFtsQuery('Order ID 12345 failed');
    expect(result).toBe('Order OR ID OR 12345 OR failed');
  });

  it('returns meaningful tokens for a normal sentence', () => {
    const result = sanitizeFtsQuery('How long does international shipping take');
    expect(result).toBe('How OR long OR does OR international OR shipping OR take');
  });

  // --- Punctuation stripping ---
  it('strips punctuation', () => {
    const result = sanitizeFtsQuery('hello! @world, #test$ %query^');
    expect(result).toBe('hello OR world OR test OR query');
  });

  it('strips quotes and apostrophes', () => {
    const result = sanitizeFtsQuery("\"quoted phrase\" and it's fine");
    // "quoted", "phrase", "and", "it", "fine" — "it" < 2 chars? No, "it" is 2 chars
    // "it_s" → after stripping apostrophe becomes "it s" → "it" and "s"
    // Actually: "it's" → "it s" → tokens: "it", "s" — "s" filtered (len 1), "it" passes
    expect(result).toContain('quoted');
    expect(result).toContain('phrase');
    expect(result).toContain('fine');
  });

  it('strips parentheses', () => {
    const result = sanitizeFtsQuery('returns (30 days)');
    expect(result).toBe('returns OR 30 OR days');
  });

  it('strips asterisk wildcard', () => {
    const result = sanitizeFtsQuery('ship*');
    expect(result).toBe('ship');
  });

  // --- FTS5 operator keywords ---
  it('removes bare OR keyword', () => {
    const result = sanitizeFtsQuery('shipping OR returns');
    expect(result).toBe('shipping OR returns');
    // "OR" itself is removed as an operator, leaving shipping and returns
    const tokens = result!.split(' OR ');
    expect(tokens).toContain('shipping');
    expect(tokens).toContain('returns');
    expect(tokens).not.toContain('OR');
  });

  it('removes AND keyword', () => {
    const result = sanitizeFtsQuery('shipping AND returns');
    const tokens = result!.split(' OR ');
    expect(tokens).not.toContain('AND');
  });

  it('removes NOT keyword', () => {
    const result = sanitizeFtsQuery('NOT expensive');
    const tokens = result!.split(' OR ');
    expect(tokens).not.toContain('NOT');
    expect(tokens).toContain('expensive');
  });

  it('removes NEAR keyword', () => {
    const result = sanitizeFtsQuery('NEAR delivery address');
    const tokens = result!.split(' OR ');
    expect(tokens).not.toContain('NEAR');
    expect(tokens).toContain('delivery');
    expect(tokens).toContain('address');
  });

  it('removes operator keywords case-insensitively', () => {
    const result = sanitizeFtsQuery('or and not near free');
    const tokens = result!.split(' OR ');
    expect(tokens).not.toContain('or');
    expect(tokens).not.toContain('and');
    expect(tokens).not.toContain('not');
    expect(tokens).not.toContain('near');
    expect(tokens).toContain('free');
  });

  // --- Empty / whitespace / zero-result inputs ---
  it('returns null for empty string', () => {
    expect(sanitizeFtsQuery('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(sanitizeFtsQuery('   ')).toBeNull();
    expect(sanitizeFtsQuery('\t\n ')).toBeNull();
  });

  it('returns null for pure punctuation', () => {
    expect(sanitizeFtsQuery('!@#$%^&*()')).toBeNull();
  });

  it('returns null when only FTS5 operators remain', () => {
    expect(sanitizeFtsQuery('OR AND NOT NEAR')).toBeNull();
  });

  it('returns null when all tokens are single characters after stripping', () => {
    // "a b c" → each token is len 1, filtered out
    expect(sanitizeFtsQuery('a b c')).toBeNull();
  });

  // --- Repeated spaces ---
  it('handles repeated spaces', () => {
    const result = sanitizeFtsQuery('hello     world');
    expect(result).toBe('hello OR world');
  });

  // --- Numbers ---
  it('keeps numeric tokens >= 2 chars', () => {
    expect(sanitizeFtsQuery('order 45')).toBe('order OR 45');
  });

  it('filters single-digit tokens', () => {
    const result = sanitizeFtsQuery('order 5 items');
    expect(result).not.toContain(' OR 5 OR ');
    expect(result).toContain('order');
    expect(result).toContain('items');
  });

  // --- Regression: Milestone 1 empty-context hallucination ---
  it('regression: empty message should return null (no FTS5 query issued)', () => {
    expect(sanitizeFtsQuery('')).toBeNull();
  });

  // --- Non-string input guard ---
  it('returns null for non-string input', () => {
    // Cast to any for test purposes
    expect(sanitizeFtsQuery(null as unknown as string)).toBeNull();
    expect(sanitizeFtsQuery(undefined as unknown as string)).toBeNull();
    expect(sanitizeFtsQuery(42 as unknown as string)).toBeNull();
  });
});
