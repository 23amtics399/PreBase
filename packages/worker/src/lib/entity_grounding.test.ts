import {
  extractCandidateEntities,
  evaluateEntityGroundingState,
  resolveTrustedSupportContact,
  buildBoundedUnconfirmedResponse,
  mergeRecoveredChunks,
} from './entity_grounding';
import type { RetrievalResult } from './retrieval';

describe('Entity Grounding Safety Layer Unit Tests', () => {
  describe('extractCandidateEntities', () => {
    it('extracts entities following "specifically to/in/for"', () => {
      const e1 = extractCandidateEntities('Do you ship specifically to Australia?');
      expect(e1).toHaveLength(1);
      expect(e1[0].name.toLowerCase()).toBe('australia');

      const e2 = extractCandidateEntities('Can I send a wire specifically to Argentina using PayFlow?');
      expect(e2).toHaveLength(1);
      expect(e2[0].name.toLowerCase()).toBe('argentina');

      const e3 = extractCandidateEntities('Are consultations offered specifically for pediatric care?');
      expect(e3).toHaveLength(1);
      expect(e3[0].name.toLowerCase()).toBe('pediatric care');
    });

    it('extracts entities from membership/qualification interrogatives', () => {
      const e1 = extractCandidateEntities('Is Cigna in-network?');
      expect(e1).toHaveLength(1);
      expect(e1[0].name.toLowerCase()).toBe('cigna');

      const e2 = extractCandidateEntities('Is Aetna health insurance accepted?');
      expect(e2).toHaveLength(1);
      expect(e2[0].name.toLowerCase()).toBe('aetna');

      const e3 = extractCandidateEntities('Is SAML 2.0 supported on Enterprise?');
      expect(e3).toHaveLength(1);
      expect(e3[0].name.toLowerCase()).toBe('saml 2.0');
    });

    it('extracts entities from capability interrogatives', () => {
      const e1 = extractCandidateEntities('Do you ship to Germany?');
      expect(e1).toHaveLength(1);
      expect(e1[0].name.toLowerCase()).toBe('germany');

      const e2 = extractCandidateEntities('Can CarePoint doctors prescribe Adderall virtually?');
      expect(e2).toHaveLength(1);
      expect(e2[0].name.toLowerCase()).toBe('adderall');

      const e3 = extractCandidateEntities('Does DevCloud offer dedicated phone support for Team tier?');
      expect(e3).toHaveLength(1);
      expect(e3[0].name.toLowerCase()).toBe('dedicated phone support');
    });

    it('handles lowercase user input seamlessly', () => {
      const e1 = extractCandidateEntities('is cigna in-network?');
      expect(e1).toHaveLength(1);
      expect(e1[0].name.toLowerCase()).toBe('cigna');

      const e2 = extractCandidateEntities('do you ship to germany?');
      expect(e2).toHaveLength(1);
      expect(e2[0].name.toLowerCase()).toBe('germany');

      const e3 = extractCandidateEntities('can i wire to argentina?');
      expect(e3).toHaveLength(1);
      expect(e3[0].name.toLowerCase()).toBe('argentina');
    });

    it('extracts entities from user presupposition attacks', () => {
      const e1 = extractCandidateEntities('Since Australia is an approved shipping destination, what is the ETA?');
      expect(e1).toHaveLength(1);
      expect(e1[0].name.toLowerCase()).toBe('australia');

      const e2 = extractCandidateEntities('Now that Cigna is in-network, what is my co-pay?');
      expect(e2).toHaveLength(1);
      expect(e2[0].name.toLowerCase()).toBe('cigna');
    });

    it('CONSERVATIVE: Rejects general category questions without specific entities', () => {
      // General shipping
      expect(extractCandidateEntities('Do you ship internationally?')).toHaveLength(0);
      expect(extractCandidateEntities('What is the international shipping timeframe?')).toHaveLength(0);
      expect(extractCandidateEntities('What is the return window for unopened items?')).toHaveLength(0);

      // General banking
      expect(extractCandidateEntities('What are your wire transfer fees?')).toHaveLength(0);
      expect(extractCandidateEntities('What is the daily ATM cash withdrawal limit for standard personal accounts?')).toHaveLength(0);
      expect(extractCandidateEntities('How do I dispute an unauthorized transaction?')).toHaveLength(0);

      // General healthcare
      expect(extractCandidateEntities('Do you accept health insurance?')).toHaveLength(0);
      expect(extractCandidateEntities('What are the hours for virtual primary care consultations?')).toHaveLength(0);
      expect(extractCandidateEntities('Can I get a refund for my cancelled appointment?')).toHaveLength(0);

      // General SaaS
      expect(extractCandidateEntities('What is the uptime SLA on the Team tier?')).toHaveLength(0);
      expect(extractCandidateEntities('Why am I getting 429 rate limit errors?')).toHaveLength(0);
      expect(extractCandidateEntities('Can I get a refund on my subscription?')).toHaveLength(0);
    });
  });

  describe('evaluateEntityGroundingState (Evidence Priority & Contradiction)', () => {
    const chunkAetna: RetrievalResult = {
      content: 'CarePoint is in-network with Medicare, Blue Cross Blue Shield, and Aetna. Patients with other providers pay out-of-pocket.',
      score: -2.8,
      sourceFilename: 'carepoint.txt',
      chunkIndex: 2,
    };

    const chunkAdderall: RetrievalResult = {
      content: 'Prescription refills require 48 hours. CarePoint physicians cannot prescribe DEA Schedule II controlled substances (such as Adderall, Ritalin, or opioids) via virtual telehealth consultations.',
      score: -3.1,
      sourceFilename: 'carepoint.txt',
      chunkIndex: 3,
    };

    const chunkGermanyPositive: RetrievalResult = {
      content: 'International shipping is available to selected countries. Supported destinations include India, Australia, and Germany.',
      score: -2.5,
      sourceFilename: 'shipping.txt',
      chunkIndex: 1,
    };

    const chunkGermanyNegative: RetrievalResult = {
      content: 'Due to updated customs restrictions, Germany is currently unavailable for international shipping.',
      score: -2.6,
      sourceFilename: 'shipping-updates.txt',
      chunkIndex: 5,
    };

    const chunkMentionOnly: RetrievalResult = {
      content: 'For any international inquiries or questions about Argentina, please contact our support desk.',
      score: -1.5,
      sourceFilename: 'faq.txt',
      chunkIndex: 9,
    };

    const chunkAmbiguous: RetrievalResult = {
      content: 'Coverage for Cigna depends on your specific employer group policy and requires manual prior authorization.',
      score: -1.8,
      sourceFilename: 'insurance.txt',
      chunkIndex: 4,
    };

    it('evaluates confirmed state accurately (Precedence 3)', () => {
      const res = evaluateEntityGroundingState('Aetna', { found: true, matchingChunk: chunkAetna }, [chunkAetna]);
      expect(res.state).toBe('confirmed');

      const res2 = evaluateEntityGroundingState('Germany', { found: true, matchingChunk: chunkGermanyPositive }, [chunkGermanyPositive]);
      expect(res2.state).toBe('confirmed');
    });

    it('evaluates explicitly_excluded state accurately (Precedence 2)', () => {
      const res = evaluateEntityGroundingState('Adderall', { found: true, matchingChunk: chunkAdderall }, [chunkAdderall]);
      expect(res.state).toBe('explicitly_excluded');

      const res2 = evaluateEntityGroundingState('Germany', { found: true, matchingChunk: chunkGermanyNegative }, [chunkGermanyNegative]);
      expect(res2.state).toBe('explicitly_excluded');
    });

    it('evaluates conflicting state when chunks contradict each other (Precedence 1)', () => {
      // Chunk 1 says Germany is supported; Chunk 2 says Germany is unavailable
      const res = evaluateEntityGroundingState(
        'Germany',
        { found: true, matchingChunk: chunkGermanyPositive },
        [chunkGermanyPositive, chunkGermanyNegative]
      );
      expect(res.state).toBe('conflicting');
      expect(res.detail).toContain('conflicting');
    });

    it('evaluates insufficient_context when eligibility is conditional/ambiguous (Precedence 4)', () => {
      const res = evaluateEntityGroundingState('Cigna', { found: true, matchingChunk: chunkAmbiguous }, [chunkAmbiguous]);
      expect(res.state).toBe('insufficient_context');
    });

    it('evaluates mentioned_only when entity appears without support or exclusion context (Precedence 5)', () => {
      const res = evaluateEntityGroundingState('Argentina', { found: true, matchingChunk: chunkMentionOnly }, [chunkMentionOnly]);
      expect(res.state).toBe('mentioned_only');
    });

    it('evaluates absent when entity is not in any chunk (Precedence 6)', () => {
      const res = evaluateEntityGroundingState('Humana', { found: false }, [chunkAetna]);
      expect(res.state).toBe('absent');
    });
  });

  describe('resolveTrustedSupportContact', () => {
    it('resolves validated email from systemPrompt (T1 precedence)', () => {
      const t1 = 'You are the patient care assistant for CarePoint Health. Your patient intake contact is intake@carepoint.health.';
      const contact = resolveTrustedSupportContact(t1, []);
      expect(contact).toBe('intake@carepoint.health');
    });

    it('resolves validated URL from systemPrompt', () => {
      const t1 = 'You are the DevCloud bot. For support, visit https://devcloud.io/help.';
      const contact = resolveTrustedSupportContact(t1, []);
      expect(contact).toBe('https://devcloud.io/help');
    });

    it('resolves contact from KB chunk only if systemPrompt has none', () => {
      const t1 = 'You are a general support bot without email in prompt.';
      const chunks: RetrievalResult[] = [
        { content: 'For refunds, contact billing@teststore.example within 30 days.', score: -2.0, sourceFilename: 'kb.txt', chunkIndex: 1 },
      ];
      const contact = resolveTrustedSupportContact(t1, chunks);
      expect(contact).toBe('billing@teststore.example');
    });

    it('returns undefined if no validated email or URL exists anywhere', () => {
      const t1 = 'You are a bot with no contact information.';
      const chunks: RetrievalResult[] = [
        { content: 'Returns are accepted within 30 days. Contact our customer care team.', score: -2.0, sourceFilename: 'kb.txt', chunkIndex: 1 },
      ];
      const contact = resolveTrustedSupportContact(t1, chunks);
      expect(contact).toBeUndefined();
    });
  });

  describe('buildBoundedUnconfirmedResponse', () => {
    it('builds bounded response for absent entity stating general rule and unconfirmed status', () => {
      const catChunk = 'CarePoint is in-network with Medicare, Blue Cross Blue Shield, and Aetna. Patients with other insurance providers must pay out-of-pocket.';
      const resp = buildBoundedUnconfirmedResponse(catChunk, 'Cigna', 'absent', 'intake@carepoint.health');

      expect(resp).toContain('CarePoint is in-network with Medicare, Blue Cross Blue Shield, and Aetna.');
      expect(resp).toContain('does not specify whether Cigna is included or supported');
      expect(resp).toContain('intake@carepoint.health');
      expect(resp).not.toContain('Cigna is in-network');
    });

    it('builds bounded response for conflicting entity evidence', () => {
      const resp = buildBoundedUnconfirmedResponse('', 'Germany', 'conflicting', 'support@teststore.example');
      expect(resp).toContain('conflicting information regarding whether Germany is supported');
      expect(resp).toContain('support@teststore.example');
    });

    it('builds bounded response for mentioned_only entity', () => {
      const resp = buildBoundedUnconfirmedResponse('', 'Argentina', 'mentioned_only', 'disputes@payflow.bank');
      expect(resp).toContain('While Argentina is mentioned in our documentation');
      expect(resp).toContain('does not confirm that it is currently supported');
      expect(resp).toContain('disputes@payflow.bank');
    });

    it('uses fallback text when support contact is undefined', () => {
      const resp = buildBoundedUnconfirmedResponse('General policy applies.', 'Brazil', 'absent', undefined);
      expect(resp).toContain('please contact customer support.');
    });
  });

  describe('mergeRecoveredChunks (Context Merging & Budget Strategy)', () => {
    it('merges recovered chunk without duplicating or exceeding budget', () => {
      const initial: RetrievalResult[] = [
        { content: 'Chunk A: General international shipping rules.', score: -2.0, sourceFilename: 'f1.txt', chunkIndex: 0 },
      ];
      const recovered: RetrievalResult[] = [
        { content: 'Chunk B: Supported destinations include Germany, France, and Australia.', score: -3.5, sourceFilename: 'f1.txt', chunkIndex: 1 },
      ];

      const merged = mergeRecoveredChunks(initial, recovered, 3600);
      expect(merged).toHaveLength(2);
      expect(merged[0].content).toContain('Chunk A');
      expect(merged[1].content).toContain('Chunk B');
    });

    it('deduplicates chunk if already present in initial retrieval', () => {
      const initial: RetrievalResult[] = [
        { content: 'Chunk A: Content here.', score: -2.0, sourceFilename: 'f1.txt', chunkIndex: 0 },
      ];
      const recovered: RetrievalResult[] = [
        { content: 'Chunk A: Content here.', score: -2.0, sourceFilename: 'f1.txt', chunkIndex: 0 },
      ];

      const merged = mergeRecoveredChunks(initial, recovered, 3600);
      expect(merged).toHaveLength(1);
    });

    it('respects character budget and does not overflow', () => {
      const initial: RetrievalResult[] = [
        { content: 'X'.repeat(100), score: -2.0, sourceFilename: 'f1.txt', chunkIndex: 0 },
      ];
      const recovered: RetrievalResult[] = [
        { content: 'Y'.repeat(50), score: -2.0, sourceFilename: 'f2.txt', chunkIndex: 0 },
      ];

      // Budget only allows 120 chars -> recovered chunk (50 chars) exceeds 120 total, so it is skipped
      const merged = mergeRecoveredChunks(initial, recovered, 120);
      expect(merged).toHaveLength(1);
      expect(merged[0].content).toContain('X');
    });

    it('determines chunk inclusion by BM25 competition when budget is constrained', () => {
      const initial0: RetrievalResult = { content: 'A'.repeat(50), score: -3.5, sourceFilename: 'f0.txt', chunkIndex: 0 };
      const initial1: RetrievalResult = { content: 'B'.repeat(50), score: -1.2, sourceFilename: 'f1.txt', chunkIndex: 1 };
      const strongRecovered: RetrievalResult = { content: 'C'.repeat(50), score: -2.8, sourceFilename: 'f2.txt', chunkIndex: 0 };

      // Budget allows exactly 100 chars (room for 2 chunks)
      // initial0 (-3.5) is preserved unconditionally
      // strongRecovered (-2.8) beats initial1 (-1.2)
      const merged = mergeRecoveredChunks([initial0, initial1], [strongRecovered], 100);
      expect(merged).toHaveLength(2);
      expect(merged[0].sourceFilename).toBe('f0.txt');
      expect(merged[1].sourceFilename).toBe('f2.txt');

      // Weak recovered (-0.8) does NOT crowd out initial1 (-1.2)
      const weakRecovered: RetrievalResult = { content: 'D'.repeat(50), score: -0.8, sourceFilename: 'f3.txt', chunkIndex: 0 };
      const mergedWeak = mergeRecoveredChunks([initial0, initial1], [weakRecovered], 100);
      expect(mergedWeak).toHaveLength(2);
      expect(mergedWeak[0].sourceFilename).toBe('f0.txt');
      expect(mergedWeak[1].sourceFilename).toBe('f1.txt');
    });
  });

  describe('Canonical Section 1 Deterministic Acceptance Tests', () => {
    it('"We accept Aetna." -> confirmed', () => {
      const chunk: RetrievalResult = { content: 'We accept Aetna.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Aetna', { found: true, matchingChunk: chunk }, [chunk]);
      expect(res.state).toBe('confirmed');
    });

    it('"Aetna is in-network." -> confirmed', () => {
      const chunk: RetrievalResult = { content: 'Aetna is in-network.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Aetna', { found: true, matchingChunk: chunk }, [chunk]);
      expect(res.state).toBe('confirmed');
    });

    it('"Supported destinations include Germany." -> confirmed', () => {
      const chunk: RetrievalResult = { content: 'Supported destinations include Germany.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Germany', { found: true, matchingChunk: chunk }, [chunk]);
      expect(res.state).toBe('confirmed');
    });

    it('"Germany is not currently supported." -> explicitly_excluded', () => {
      const chunk: RetrievalResult = { content: 'Germany is not currently supported.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Germany', { found: true, matchingChunk: chunk }, [chunk]);
      expect(res.state).toBe('explicitly_excluded');
    });

    it('"We do not ship to Argentina." -> explicitly_excluded', () => {
      const chunk: RetrievalResult = { content: 'We do not ship to Argentina.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Argentina', { found: true, matchingChunk: chunk }, [chunk]);
      expect(res.state).toBe('explicitly_excluded');
    });

    it('"Argentina is excluded from international shipping." -> explicitly_excluded', () => {
      const chunk: RetrievalResult = { content: 'Argentina is excluded from international shipping.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Argentina', { found: true, matchingChunk: chunk }, [chunk]);
      expect(res.state).toBe('explicitly_excluded');
    });

    it('"Eligibility depends on your plan; contact support regarding Cigna." -> insufficient_context', () => {
      const chunk: RetrievalResult = { content: 'Eligibility depends on your plan; contact support regarding Cigna.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Cigna', { found: true, matchingChunk: chunk }, [chunk]);
      expect(res.state).toBe('insufficient_context');
    });

    it('"For questions about Argentina, contact support." -> mentioned_only', () => {
      const chunk: RetrievalResult = { content: 'For questions about Argentina, contact support.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Argentina', { found: true, matchingChunk: chunk }, [chunk]);
      expect(res.state).toBe('mentioned_only');
    });

    it('Entity nowhere in authoritative KB -> absent', () => {
      const chunk: RetrievalResult = { content: 'International shipping is available to selected countries.', score: -2.0, sourceFilename: 'test.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Germany', { found: false }, [chunk]);
      expect(res.state).toBe('absent');
    });

    it('Multiple chunks containing contradictory statements -> conflicting with bounded escalation', () => {
      const chunk1: RetrievalResult = { content: 'Germany is supported for international shipping.', score: -2.5, sourceFilename: 'f1.txt', chunkIndex: 0 };
      const chunk2: RetrievalResult = { content: 'Germany is currently unavailable due to customs restrictions.', score: -2.4, sourceFilename: 'f2.txt', chunkIndex: 0 };
      const res = evaluateEntityGroundingState('Germany', { found: true, matchingChunk: chunk1 }, [chunk1, chunk2]);
      expect(res.state).toBe('conflicting');

      const response = buildBoundedUnconfirmedResponse('', 'Germany', res.state, 'support@teststore.example');
      expect(response).toContain('conflicting information');
      expect(response).toContain('support@teststore.example');
    });
  });
});
