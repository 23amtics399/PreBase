import {
  extractCandidateEntities,
  findEntityInChunks,
  evaluateEntityGroundingState,
  extractGoverningPolicySentence,
  buildBoundedUnconfirmedResponse,
} from './entity_grounding';
import { buildPrompt, ANSWER_SYNTHESIS_POLICY } from './prompt';
import {
  isCredentialOrOtpInput,
  CREDENTIAL_SAFETY_RESPONSE,
  sanitizeFinalAnswer,
  executeRagPipeline,
} from './rag';
import type { RetrievalResult } from './retrieval';
import type { Bindings } from './types';

describe('Dual-KB Synthesis Correctness & Regression Suite', () => {
  const supportEmail = 'support@teststore.example';

  // ---------------------------------------------------------------------------
  // 1. Multi-Constraint Eligibility Evaluation
  // ---------------------------------------------------------------------------
  describe('1. Multi-Constraint Eligibility Rules', () => {
    it('prompt contains explicit constraint evaluation rule', () => {
      expect(ANSWER_SYNTHESIS_POLICY).toContain('compare those facts against every explicit eligibility condition');
      expect(ANSWER_SYNTHESIS_POLICY).toContain('A request is not eligible when any required condition is violated');
      expect(ANSWER_SYNTHESIS_POLICY).toContain('Do not focus on one satisfied condition while ignoring another violated condition');
    });

    it('prompt includes explicit 4-hour cancellation multi-constraint requirement', () => {
      expect(ANSWER_SYNTHESIS_POLICY).toContain('evaluate all stated constraints against the user\'s circumstances');
      expect(ANSWER_SYNTHESIS_POLICY).toContain('even if another condition is met');
    });

    it('builds system prompt instructing Granite to evaluate all conditions', () => {
      const prompt = buildPrompt({
        ownerInstructions: `Support contact: ${supportEmail}`,
        knowledge: 'Orders can be cancelled within 2 hours of placing the order, provided the order has not entered processing.',
        userMessage: "I placed my order 4 hours ago and it hasn't processed. Can I cancel it?",
      });
      const systemMsg = prompt.find(p => p.role === 'system')?.content;
      expect(systemMsg).toContain('evaluate all stated constraints');
      expect(systemMsg).toContain('A request is not eligible when any required condition is violated');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Explicit Negative Eligibility
  // ---------------------------------------------------------------------------
  describe('2. Explicit Negative Eligibility Rules', () => {
    it('prompt contains explicit negative eligibility rule for used/disqualifying facts', () => {
      expect(ANSWER_SYNTHESIS_POLICY).toContain('When the user states facts that explicitly violate a stated eligibility condition');
      expect(ANSWER_SYNTHESIS_POLICY).toContain('explicitly state that the item or request is not eligible under the stated policy');
      expect(ANSWER_SYNTHESIS_POLICY).toContain('Do not merely repeat the positive condition or suggest the user may qualify');
    });

    it('builds prompt instructing model that used products are ineligible', () => {
      const prompt = buildPrompt({
        ownerInstructions: `Support contact: ${supportEmail}`,
        knowledge: 'Customers may return unused products within 30 days of delivery. Returns are allowed only for unused products in original packaging.',
        userMessage: "I used the product for a week but didn't like it. Can I return it?",
      });
      const systemMsg = prompt.find(p => p.role === 'system')?.content;
      expect(systemMsg).toContain('explicitly state that the item or request is not eligible');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Prevent Semantic Policy Transfer Between Unrelated Fees
  // ---------------------------------------------------------------------------
  describe('3. Fee Isolation (No Policy Transfer)', () => {
    it('prompt contains explicit prohibition against transferring shipping fees to return shipping', () => {
      expect(ANSWER_SYNTHESIS_POLICY).toContain('Never transfer rules between distinct operations or fees');
      expect(ANSWER_SYNTHESIS_POLICY).toContain('state that the knowledge base does not specify it and provide the trusted support contact');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Conservative Entity Normalization for RuPay
  // ---------------------------------------------------------------------------
  describe('4. RuPay Conservative Entity Normalization', () => {
    const paymentChunk: RetrievalResult = {
      content: 'Payment\nWe accept UPI, Visa, Mastercard, RuPay, and net banking.\nCash on delivery is available only for eligible domestic orders.',
      score: -4.5,
      sourceFilename: 'prebase-test-faq.txt',
      chunkIndex: 6,
    };

    const bulletPaymentChunk: RetrievalResult = {
      content: '## 5. Payment Methods\n\nThe store accepts:\n- UPI\n- Visa\n- Mastercard\n- RuPay\n- Net banking',
      score: -4.0,
      sourceFilename: 'prebase-test-knowledge.md',
      chunkIndex: 24,
    };

    it('normalizes "RuPay cards" to "RuPay"', () => {
      const entities = extractCandidateEntities('Do you accept RuPay cards?');
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('RuPay');
      expect(entities[0].normalized).toBe('rupay');
    });

    it('normalizes "RuPay card" to "RuPay"', () => {
      const entities = extractCandidateEntities('Can I pay with RuPay card?');
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('RuPay');
    });

    it('normalizes "RuPay payment" to "RuPay"', () => {
      const entities = extractCandidateEntities('Do you accept RuPay payment?');
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('RuPay');
    });

    it('normalizes "RuPay payments" to "RuPay"', () => {
      const entities = extractCandidateEntities('Do you accept RuPay payments?');
      expect(entities).toHaveLength(1);
      expect(entities[0].name).toBe('RuPay');
    });

    it('confirms RuPay when retrieved in prose FAQ chunk', () => {
      const presence = findEntityInChunks('RuPay', [paymentChunk]);
      expect(presence.found).toBe(true);

      const res = evaluateEntityGroundingState('RuPay', presence, [paymentChunk]);
      expect(res.state).toBe('confirmed');
    });

    it('confirms RuPay when retrieved in bullet list chunk', () => {
      const presence = findEntityInChunks('RuPay', [bulletPaymentChunk]);
      expect(presence.found).toBe(true);

      const res = evaluateEntityGroundingState('RuPay', presence, [bulletPaymentChunk]);
      expect(res.state).toBe('confirmed');
    });

    it('does NOT over-normalize non-payment entities or arbitrary concepts', () => {
      const general = extractCandidateEntities('What are your payment methods?');
      expect(general).toHaveLength(0);

      const generalCards = extractCandidateEntities('Do you accept cards?');
      expect(generalCards).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Topic-Specific Bounded Interception (Student Discount)
  // ---------------------------------------------------------------------------
  describe('5. Topic-Specific Bounded Interception (Student Discount)', () => {
    const chunk49: RetrievalResult = {
      content: '## 10. Information Not Covered\n\nThis knowledge base does not specify:\n- A return shipping fee.\n- A guaranteed replacement timeline.\n- A specific list of international countries.\n- Weekend support hours.\n- A loyalty program.\n- Student discounts.\n- Product-specific prices.\n- The company\'s CEO.\n- The capital of any country.',
      score: -2.1,
      sourceFilename: 'prebase-test-knowledge.md',
      chunkIndex: 49,
    };

    it('extractGoverningPolicySentence returns null for unrelated exclusion lists', () => {
      const governing = extractGoverningPolicySentence(chunk49.content, 'student discount', 'Do you offer a student discount?');
      expect(governing).toBeNull();
    });

    it('buildBoundedUnconfirmedResponse outputs clean non-mention without quoting return shipping fee', () => {
      const response = buildBoundedUnconfirmedResponse(
        chunk49.content,
        'student discount',
        'absent',
        supportEmail,
        'Do you offer a student discount?'
      );

      // Semantic criteria:
      expect(response).not.toContain('return shipping fee');
      expect(response).not.toContain('A return shipping fee');
      expect(response).toContain('The knowledge base does not mention a student discount');
      expect(response).toContain(supportEmail);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Germany Governing Policy Extraction & Header Cleanup
  // ---------------------------------------------------------------------------
  describe('6. Germany Response Quality (No ### or Prompt Echo)', () => {
    const faqChunk37: RetrievalResult = {
      content: '### Do you deliver internationally?\n\nYes, but only to selected countries. International delivery usually takes **10–15 business days**.',
      score: -3.2,
      sourceFilename: 'prebase-test-knowledge.md',
      chunkIndex: 37,
    };

    const docChunk5: RetrievalResult = {
      content: 'International shipping is available to selected countries and usually takes 10 to 15 business days.',
      score: -3.0,
      sourceFilename: 'prebase-test-faq.txt',
      chunkIndex: 5,
    };

    it('extractGoverningPolicySentence rejects "### Do you deliver internationally?" and extracts policy statement', () => {
      const governing = extractGoverningPolicySentence(faqChunk37.content, 'Germany', 'Do you ship to Germany?');
      expect(governing).not.toBeNull();
      expect(governing).not.toContain('###');
      expect(governing).not.toContain('?');
      expect(governing).toContain('International delivery usually takes 10–15 business days.');
    });

    it('extractGoverningPolicySentence extracts clean policy from docChunk5', () => {
      const governing = extractGoverningPolicySentence(docChunk5.content, 'Germany', 'Do you ship to Germany?');
      expect(governing).not.toBeNull();
      expect(governing).toContain('International shipping is available to selected countries');
    });

    it('buildBoundedUnconfirmedResponse contains no "###" and states unconfirmed destination clearly', () => {
      const response = buildBoundedUnconfirmedResponse(
        faqChunk37.content,
        'Germany',
        'absent',
        supportEmail,
        'Do you ship to Germany?'
      );

      expect(response).not.toContain('###');
      expect(response).not.toContain('Do you deliver internationally?');
      expect(response).toContain('International delivery usually takes 10–15 business days.');
      expect(response).toContain('does not specify whether Germany is included or supported');
      expect(response).toContain(supportEmail);
    });

    it('sanitizeFinalAnswer strips leading markdown headers and user echoes', () => {
      expect(sanitizeFinalAnswer('### Do you deliver internationally?')).toBe('Do you deliver internationally?');
      expect(sanitizeFinalAnswer('# Shipping Policy')).toBe('Shipping Policy');
      expect(sanitizeFinalAnswer('## Notice')).toBe('Notice');
      expect(sanitizeFinalAnswer('<USER_INPUT> Hello')).toBe('Hello');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Dedicated Pre-Retrieval Authentication / OTP Safety Response
  // ---------------------------------------------------------------------------
  describe('7. Dedicated Credential & OTP Interception', () => {
    it('detects user providing an OTP code during account recovery', () => {
      const msg = 'I am locked out of my account. My email is user@example.com and the OTP I just got is 492104. Can you log me in?';
      expect(isCredentialOrOtpInput(msg)).toBe(true);
    });

    it('detects "My OTP is 123456"', () => {
      expect(isCredentialOrOtpInput('My OTP is 123456')).toBe(true);
    });

    it('detects verification code inputs', () => {
      expect(isCredentialOrOtpInput('here is my verification code 892104')).toBe(true);
      expect(isCredentialOrOtpInput('my auth code: 394812')).toBe(true);
    });

    it('detects password submissions', () => {
      expect(isCredentialOrOtpInput('my password is secretPassword123')).toBe(true);
      expect(isCredentialOrOtpInput('account password is Pass123!')).toBe(true);
      expect(isCredentialOrOtpInput('password: mysecretpassword')).toBe(true);
    });

    it('detects banking PIN and CVV submissions', () => {
      expect(isCredentialOrOtpInput('my pin is 4492')).toBe(true);
      expect(isCredentialOrOtpInput('atm pin: 1234')).toBe(true);
      expect(isCredentialOrOtpInput('cvv: 492')).toBe(true);
    });

    it('detects API key submissions', () => {
      expect(isCredentialOrOtpInput('my api_key: gsk_1234567890abcdef')).toBe(true);
      expect(isCredentialOrOtpInput('secret_key=xyz987654321')).toBe(true);
    });

    it('does NOT falsely intercept normal policy inquiries about OTPs or passwords', () => {
      // General questions about store policy
      expect(isCredentialOrOtpInput('Do your support agents ever ask for passwords?')).toBe(false);
      expect(isCredentialOrOtpInput('Will I receive an OTP for order verification?')).toBe(false);
      expect(isCredentialOrOtpInput('What is your privacy policy regarding security credentials?')).toBe(false);
    });

    it('executeRagPipeline intercepts OTP before FTS or AI and returns deterministic response', async () => {
      // Mock Bindings
      const mockEnv: Bindings = {
        DB: {
          prepare: jest.fn(),
        } as any,
        AI: {
          run: jest.fn(),
        } as any,
        PREBASE_AI_MODEL: '@cf/ibm-granite/granite-4.0-h-micro',
        PREBASE_AI_DAILY_LIMIT: '7954',
        PREBASE_PER_BOT_DAILY: '500',
        PREBASE_PER_BOT_IP_DAILY: '20',
        PREBASE_IP_DAILY: '100',
        PREBASE_CHAR_BUDGET: '3600',
        PREBASE_MIN_BM25_SCORE: '-0.5',
        PREBASE_MAX_MESSAGE_LEN: '2000',
        RATE_LIMIT_SECRET: 'test-secret',
        ENRICHMENT_QUEUE: {} as any,
        GROQ_API_KEY: 'test-key',
        PREBASE_INGESTION_MODEL: 'qwen/qwen3.8-27b',
        PREBASE_ENRICH_MAX_RETRIES: '3',
        PREBASE_GROQ_INGESTION_BUDGET: '650',
      };

      const result = await executeRagPipeline(
        mockEnv,
        'test-bot-id',
        'Support: support@teststore.example',
        'I am locked out of my account. My email is user@example.com and the OTP I just got is 492104. Can you log me in?',
        '2026-09-11'
      );

      // Verify response
      expect(result.status).toBe(200);
      expect(result.answer).toBe(CREDENTIAL_SAFETY_RESPONSE);
      expect(result.answer).toContain("I can't handle or use OTPs or authentication codes");

      // Verify AI and DB were NOT called
      expect(mockEnv.AI.run).not.toHaveBeenCalled();
      expect(mockEnv.DB.prepare).not.toHaveBeenCalled();

      // Verify telemetry
      expect(result._rag.ragStatus).toBe('credential_intercepted');
      expect(result._rag.aiCalled).toBe(false);
      expect(result._rag.candidateCount).toBe(0);

      // Verify the secret was NOT included in answer
      expect(result.answer).not.toContain('492104');
    });
  });
});
