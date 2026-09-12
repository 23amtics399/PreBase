/**
 * Intent Interceptor — pure TypeScript, zero LLM calls, zero external dependencies.
 *
 * Two detection passes:
 *
 *  1. Greeting detection (runs BEFORE KB load)
 *     Matches a whitelist of common greeting phrases.
 *     CRITICAL: only fires when the ENTIRE message is a greeting — a message
 *     like "hello, can I get a refund?" must NOT be intercepted.
 *
 *  2. Short-intent detection (runs AFTER KB load)
 *     Intercepts bare 1–2 word messages (e.g. "refund", "shipping costs")
 *     ONLY when the word can be confidently matched to a known topic/heading
 *     present in the bot's own KB.
 *     Conservative: if confidence is below threshold → return 'pass' and
 *     let the full pipeline handle it.
 *     NEVER invents policy details in the clarification response.
 */

import type { RetrievalResult } from './retrieval';

export type IntentResult =
  | { type: 'greeting' }
  | { type: 'short_intent'; topic: string }
  | { type: 'pass' };

// ---------------------------------------------------------------------------
// 1. Greeting detection
// ---------------------------------------------------------------------------

/**
 * Ordered list of greeting patterns.
 * Each entry is a regex that must match the ENTIRE trimmed message.
 * Only plain greetings with optional trailing punctuation qualify.
 */
const GREETING_PATTERNS: RegExp[] = [
  // Multi-word greetings first (longer match wins by ordering)
  /^good\s+morning[!\s?.,]*$/i,
  /^good\s+afternoon[!\s?.,]*$/i,
  /^good\s+evening[!\s?.,]*$/i,
  /^good\s+day[!\s?.,]*$/i,
  /^good\s+night[!\s?.,]*$/i,
  /^how\s+are\s+you[?\s.,!]*$/i,
  /^how\s+do\s+you\s+do[?\s.,!]*$/i,
  // Single-word / short greetings
  /^h+e+l+o+[!\s?.,]*$/i,       // hello, helo, helloo, etc.
  /^h+i+[!\s?.,]*$/i,            // hi, hii, hiii, etc.
  /^h+e+y+[!\s?.,]*$/i,          // hey, heyy, heyyy, etc.
  /^greetings[!\s?.,]*$/i,
  /^howdy[!\s?.,]*$/i,
  /^namaste[!\s?.,]*$/i,
  /^hola[!\s?.,]*$/i,
  /^yo[!\s?.,]*$/i,
  /^sup[!\s?.,]*$/i,
  /^salut[!\s?.,]*$/i,
  /^bonjour[!\s?.,]*$/i,
  /^ola[!\s?.,]*$/i,
];

/**
 * Returns true if the entire message (after trimming) is a greeting.
 * A message like "hello, can you help me with returns?" returns false.
 */
export function isGreeting(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  // Reject if too long — a real greeting should be very short
  if (trimmed.length > 30) return false;
  return GREETING_PATTERNS.some(re => re.test(trimmed));
}

// ---------------------------------------------------------------------------
// 2. Short-intent detection helpers
// ---------------------------------------------------------------------------

/**
 * English stop-words excluded from KB topic extraction.
 * Conservative: only the most common function words.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'do', 'for', 'from', 'get', 'has', 'have', 'how', 'i', 'if',
  'in', 'is', 'it', 'its', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'so', 'than', 'that', 'the', 'their', 'then', 'there', 'they', 'this',
  'to', 'us', 'was', 'we', 'what', 'when', 'where', 'which', 'who',
  'will', 'with', 'would', 'you', 'your',
]);

/**
 * Extracts high-confidence topic keywords from KB chunks.
 *
 * Strategy:
 *   1. Extract headings (lines starting with # or ALL CAPS words ≥ 3 chars).
 *   2. Also extract any word appearing ≥ 3 times across all chunks (frequency signal).
 *   3. Filter by minimum length (≥ 4 chars) and exclude stop words.
 *   4. Deduplicate and lowercase.
 *
 * This is intentionally conservative — only strong signal words qualify.
 * The result is used to match user short-intent queries. If no match,
 * the pipeline passes through normally.
 */
export function extractKbTopics(chunks: RetrievalResult[]): string[] {
  const headingWords = new Set<string>();
  const wordFreq = new Map<string, number>();

  for (const chunk of chunks) {
    const lines = chunk.content.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();

      // Extract from Markdown headings
      if (trimmedLine.startsWith('#')) {
        const heading = trimmedLine.replace(/^#+\s*/, '');
        for (const word of tokenize(heading)) {
          if (isTopicWord(word)) headingWords.add(word);
        }
      }

      // Extract from ALL-CAPS "headings" (common in plain text KB files)
      if (/^[A-Z][A-Z\s]{3,}$/.test(trimmedLine)) {
        for (const word of tokenize(trimmedLine)) {
          if (isTopicWord(word)) headingWords.add(word);
        }
      }
    }

    // Frequency counting across all content
    for (const word of tokenize(chunk.content)) {
      if (isTopicWord(word)) {
        wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
      }
    }
  }

  // Collect high-frequency words (≥ 3 occurrences)
  const freqWords = new Set<string>();
  for (const [word, count] of wordFreq) {
    if (count >= 3) freqWords.add(word);
  }

  // Union of heading words and high-freq words
  const topics = new Set<string>([...headingWords, ...freqWords]);
  return [...topics];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

function isTopicWord(word: string): boolean {
  return word.length >= 4 && !STOP_WORDS.has(word);
}

// ---------------------------------------------------------------------------
// 3. Short-intent detection
// ---------------------------------------------------------------------------

/**
 * Detects whether a message is a short, ambiguous bare topic (1–2 words,
 * no question mark) that matches a known topic in the bot's KB.
 *
 * Conservative rules:
 *   - Word count must be 1 or 2 (after stop-word removal of trivial words).
 *   - Message must NOT end with '?' (phrased as a question → let AI handle).
 *   - At least one word must appear in kbTopics (case-insensitive).
 *   - The word must be ≥ 4 characters (avoids intercepting "is", "ok", "no").
 *
 * Returns: { type: 'short_intent', topic } if matched, else { type: 'pass' }.
 */
export function detectShortIntent(message: string, kbTopics: string[]): IntentResult {
  const trimmed = message.trim();
  if (!trimmed) return { type: 'pass' };

  // If ends with '?' → treat as a proper question → pass through
  if (trimmed.endsWith('?')) return { type: 'pass' };

  // Strip punctuation, lowercase, split into words
  const words = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  // Must have 1–2 meaningful words
  if (words.length === 0 || words.length > 2) return { type: 'pass' };

  // Convert kbTopics to a set for fast lookup
  const topicSet = new Set(kbTopics.map(t => t.toLowerCase()));

  // Check if any word matches a KB topic
  for (const word of words) {
    if (topicSet.has(word)) {
      // Use the user's original word (from their message) as the echo topic
      // so the clarification response never invents terminology.
      const originalWord = trimmed
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .find(w => w === word) ?? word;
      return { type: 'short_intent', topic: originalWord };
    }
  }

  return { type: 'pass' };
}

/**
 * Main entry point. Combines greeting and short-intent detection.
 *
 * @param message  - raw user message
 * @param kbTopics - topics extracted from already-loaded KB chunks (pass [] before KB load)
 */
export function detectIntent(message: string, kbTopics: string[]): IntentResult {
  if (isGreeting(message)) return { type: 'greeting' };
  if (kbTopics.length > 0) return detectShortIntent(message, kbTopics);
  return { type: 'pass' };
}
