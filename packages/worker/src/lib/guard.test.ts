import { filterByRelevance } from './guard';
import type { RetrievalResult } from './retrieval';

function makeChunk(score: number): RetrievalResult {
  return { content: 'test content', score, sourceFilename: 'test.md', chunkIndex: 0 };
}

describe('filterByRelevance', () => {
  const THRESHOLD = -0.5; // Default configured value

  // --- Strong hits (should pass) ---
  it('passes a strong match (score well below threshold)', () => {
    const chunks = [makeChunk(-2.5)];
    expect(filterByRelevance(chunks, THRESHOLD)).toHaveLength(1);
  });

  it('passes a chunk at exactly the threshold boundary', () => {
    const chunks = [makeChunk(-0.5)];
    expect(filterByRelevance(chunks, THRESHOLD)).toHaveLength(1);
  });

  it('passes multiple strong chunks', () => {
    const chunks = [makeChunk(-3.0), makeChunk(-1.5), makeChunk(-0.5)];
    expect(filterByRelevance(chunks, THRESHOLD)).toHaveLength(3);
  });

  // --- Weak hits (should be rejected) ---
  it('rejects a weak match (score above threshold, less negative)', () => {
    const chunks = [makeChunk(-0.1)];
    expect(filterByRelevance(chunks, THRESHOLD)).toHaveLength(0);
  });

  it('rejects a nearly-zero score', () => {
    const chunks = [makeChunk(-0.01)];
    expect(filterByRelevance(chunks, THRESHOLD)).toHaveLength(0);
  });

  it('rejects a score just above threshold', () => {
    const chunks = [makeChunk(-0.49)];
    expect(filterByRelevance(chunks, THRESHOLD)).toHaveLength(0);
  });

  // --- Mixed results ---
  it('keeps strong chunks and discards weak ones in a mixed set', () => {
    const chunks = [
      makeChunk(-3.0),  // strong → pass
      makeChunk(-0.2),  // weak   → fail
      makeChunk(-1.0),  // strong → pass
      makeChunk(-0.4),  // weak   → fail
    ];
    const result = filterByRelevance(chunks, THRESHOLD);
    expect(result).toHaveLength(2);
    expect(result.map(c => c.score)).toEqual([-3.0, -1.0]);
  });

  // --- Zero-result fallback case ---
  it('returns empty array when all chunks are weak → caller uses deterministic fallback', () => {
    const chunks = [makeChunk(-0.1), makeChunk(-0.2), makeChunk(-0.4)];
    expect(filterByRelevance(chunks, THRESHOLD)).toHaveLength(0);
  });

  it('returns empty array when input is empty', () => {
    expect(filterByRelevance([], THRESHOLD)).toHaveLength(0);
  });

  // --- Threshold configurability ---
  it('uses the configured threshold, not a hardcoded value', () => {
    const chunks = [makeChunk(-1.0)];
    // At threshold -2.0, a score of -1.0 is too weak (above threshold)
    expect(filterByRelevance(chunks, -2.0)).toHaveLength(0);
    // At threshold -0.5, a score of -1.0 passes
    expect(filterByRelevance(chunks, -0.5)).toHaveLength(1);
  });

  it('threshold configurability: all chunks pass a very permissive threshold', () => {
    // At threshold -0.005, only scores <= -0.005 pass.
    // -0.01 <= -0.005 → true (passes)
    // -0.1  <= -0.005 → true (passes)
    // -5.0  <= -0.005 → true (passes)
    const chunks = [makeChunk(-0.01), makeChunk(-0.1), makeChunk(-5.0)];
    expect(filterByRelevance(chunks, -0.005)).toHaveLength(3);
    // At threshold -0.1, scores must be <= -0.1:
    // -0.01 <= -0.1  → false (rejected)
    // -0.1  <= -0.1  → true  (passes, exactly at boundary)
    // -5.0  <= -0.1  → true  (passes)
    expect(filterByRelevance(chunks, -0.1)).toHaveLength(2);
  });

  it('rejects everything with a very strict threshold (very negative)', () => {
    const chunks = [makeChunk(-1.0), makeChunk(-2.0), makeChunk(-0.5)];
    expect(filterByRelevance(chunks, -10.0)).toHaveLength(0);
  });
});
