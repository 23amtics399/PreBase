import {
  isGreeting,
  extractKbTopics,
  detectShortIntent,
  detectIntent,
} from './intent_interceptor';
import type { RetrievalResult } from './retrieval';

describe('Intent Interceptor', () => {
  describe('Greeting detection (isGreeting)', () => {
    it('detects common single-word greetings', () => {
      expect(isGreeting('hello')).toBe(true);
      expect(isGreeting('hi')).toBe(true);
      expect(isGreeting('hey')).toBe(true);
      expect(isGreeting('howdy')).toBe(true);
      expect(isGreeting('namaste')).toBe(true);
      expect(isGreeting('hola')).toBe(true);
      expect(isGreeting('bonjour')).toBe(true);
    });

    it('detects greetings with elongated vowels', () => {
      expect(isGreeting('hellooo')).toBe(true);
      expect(isGreeting('hiiii')).toBe(true);
      expect(isGreeting('heyyy')).toBe(true);
    });

    it('detects multi-word greetings', () => {
      expect(isGreeting('good morning')).toBe(true);
      expect(isGreeting('good afternoon')).toBe(true);
      expect(isGreeting('good evening')).toBe(true);
      expect(isGreeting('good day')).toBe(true);
      expect(isGreeting('how are you')).toBe(true);
      expect(isGreeting('how do you do')).toBe(true);
    });

    it('handles trailing punctuation and case insensitivity', () => {
      expect(isGreeting('Hello!')).toBe(true);
      expect(isGreeting('HI!!')).toBe(true);
      expect(isGreeting('Good morning,')).toBe(true);
      expect(isGreeting('How are you?')).toBe(true);
    });

    it('CRITICAL: does NOT intercept messages with questions or further content', () => {
      expect(isGreeting('hello, can I get a refund?')).toBe(false);
      expect(isGreeting('hi how much is shipping?')).toBe(false);
      expect(isGreeting('hey what are your business hours')).toBe(false);
      expect(isGreeting('good morning I would like to track my order')).toBe(false);
      expect(isGreeting('hello I need help with my account')).toBe(false);
    });

    it('returns false for empty or non-greeting messages', () => {
      expect(isGreeting('')).toBe(false);
      expect(isGreeting('   ')).toBe(false);
      expect(isGreeting('shipping policy')).toBe(false);
      expect(isGreeting('cancel order')).toBe(false);
      expect(isGreeting('help')).toBe(false);
    });
  });

  describe('Topic extraction (extractKbTopics)', () => {
    it('extracts topics from markdown headings and uppercase headings', () => {
      const chunks: RetrievalResult[] = [
        {
          content: '# Return Policy\nAll items can be returned within 30 days.\n# Warranty\n1 year manufacturer warranty.',
          score: 0,
          sourceFilename: 'faq.md',
          chunkIndex: 0,
        },
        {
          content: 'SHIPPING DETAILS\nWe offer standard and express delivery options.',
          score: 0,
          sourceFilename: 'shipping.txt',
          chunkIndex: 1,
        },
      ];

      const topics = extractKbTopics(chunks);
      expect(topics).toContain('return');
      expect(topics).toContain('policy');
      expect(topics).toContain('warranty');
      expect(topics).toContain('shipping');
      expect(topics).toContain('details');
    });

    it('extracts high-frequency words (>= 3 occurrences)', () => {
      const chunks: RetrievalResult[] = [
        {
          content: 'Exchange instructions: to exchange an item, contact support. An exchange takes 5 days. Exchanges are free.',
          score: 0,
          sourceFilename: 'exchange.txt',
          chunkIndex: 0,
        },
      ];

      const topics = extractKbTopics(chunks);
      expect(topics).toContain('exchange');
    });

    it('filters out stop words and short words (< 4 chars)', () => {
      const chunks: RetrievalResult[] = [
        {
          content: '# It is for us to do\nYes we can and will with that and this.',
          score: 0,
          sourceFilename: 'doc.txt',
          chunkIndex: 0,
        },
      ];

      const topics = extractKbTopics(chunks);
      expect(topics).not.toContain('is');
      expect(topics).not.toContain('for');
      expect(topics).not.toContain('that');
    });
  });

  describe('Short-intent detection (detectShortIntent)', () => {
    const kbTopics = ['shipping', 'returns', 'refund', 'warranty', 'cancellation'];

    it('intercepts single-word matching topics', () => {
      const res = detectShortIntent('shipping', kbTopics);
      expect(res).toEqual({ type: 'short_intent', topic: 'shipping' });
    });

    it('intercepts two-word matching topics', () => {
      const res = detectShortIntent('shipping costs', kbTopics);
      expect(res).toEqual({ type: 'short_intent', topic: 'shipping' });
    });

    it('passes through when query ends with question mark (phrased as a question)', () => {
      const res = detectShortIntent('shipping?', kbTopics);
      expect(res).toEqual({ type: 'pass' });
    });

    it('passes through when word is not in KB topics', () => {
      const res = detectShortIntent('laptops', kbTopics);
      expect(res).toEqual({ type: 'pass' });
    });

    it('passes through when query is more than 2 meaningful words', () => {
      const res = detectShortIntent('how much does shipping cost', kbTopics);
      expect(res).toEqual({ type: 'pass' });
    });

    it('passes through empty message', () => {
      expect(detectShortIntent('', kbTopics)).toEqual({ type: 'pass' });
    });
  });

  describe('Combined detectIntent', () => {
    it('returns greeting before checking KB topics', () => {
      expect(detectIntent('hello', ['hello', 'other'])).toEqual({ type: 'greeting' });
    });

    it('returns short_intent when KB topics provided and matched', () => {
      expect(detectIntent('refund', ['refund', 'shipping'])).toEqual({
        type: 'short_intent',
        topic: 'refund',
      });
    });

    it('returns pass when no greeting and no match', () => {
      expect(detectIntent('tell me something else', ['refund'])).toEqual({ type: 'pass' });
    });
  });
});
