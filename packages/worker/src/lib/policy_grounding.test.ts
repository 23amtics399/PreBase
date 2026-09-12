import {
  extractUserFacts,
  matchOperation,
  extractPolicyConstraint,
  evaluatePolicyGrounding,
} from './policy_grounding';
import type { RetrievalResult } from './retrieval';

describe('policy_grounding', () => {
  const sampleKbChunks: RetrievalResult[] = [
    {
      sourceFilename: 'orders.md',
      chunkIndex: 0,
      content: `### Order Cancellation
Orders can be cancelled within 2 hours of placement, provided the order has not entered processing. Once processing has started or 2 hours have passed, cancellations cannot be completed.

### Shipping & Delivery
We offer free standard shipping on all orders above ₹999. For orders of ₹999 or below, a flat shipping charge of ₹79 applies.
Estimated delivery time is 3 to 5 days across India.

### Return Shipping Fee
Customers are responsible for return shipping costs. A flat return shipping fee of ₹150 is deducted from the refund unless the item arrived defective.`,
      score: 0,
    },
    {
      sourceFilename: 'returns_and_refunds.md',
      chunkIndex: 1,
      content: `### Returns Policy
Items may be returned within 14 days of delivery. All returned items must be unused and in original packaging with all seals intact. Used items or items returned after 14 days are not eligible for a refund.

### Billing Disputes
Billing and credit card disputes must be submitted within 60 days of the statement date. Disputes submitted after 60 days cannot be investigated.`,
      score: 0,
    },
    {
      sourceFilename: 'saas_terms.md',
      chunkIndex: 2,
      content: `### Subscription Refunds
Monthly subscriptions can be refunded within 14 days of initial signup provided usage is under 1,000 API requests. Accounts exceeding 1,000 requests are non-refundable.`,
      score: 0,
    },
  ];

  // ==========================================================================
  // 1. Fact Extraction Tests
  // ==========================================================================
  describe('extractUserFacts', () => {
    it('extracts duration in minutes accurately', () => {
      const facts1 = extractUserFacts('I placed my order 45 minutes ago.');
      expect(facts1).toHaveLength(1);
      expect(facts1[0]).toMatchObject({ kind: 'duration', value: 45, unit: 'minute' });

      const facts2 = extractUserFacts('I ordered 2 hours ago.');
      expect(facts2).toHaveLength(1);
      expect(facts2[0]).toMatchObject({ kind: 'duration', value: 120, unit: 'minute' });

      const facts3 = extractUserFacts('The charge was 40 days ago.');
      expect(facts3).toHaveLength(1);
      expect(facts3[0]).toMatchObject({ kind: 'duration', value: 57600, unit: 'minute' });
    });

    it('extracts monetary amounts and currency', () => {
      const facts1 = extractUserFacts('My cart total is ₹850. Do I get free shipping?');
      expect(facts1.find(f => f.kind === 'money')).toMatchObject({
        kind: 'money',
        value: 850,
        unit: 'INR',
      });

      const facts2 = extractUserFacts('Order value is $120.');
      expect(facts2.find(f => f.kind === 'money')).toMatchObject({
        kind: 'money',
        value: 120,
        unit: 'USD',
      });
    });

    it('extracts explicit user states and polarity without hallucination', () => {
      const facts1 = extractUserFacts('My order has not processed yet.');
      expect(facts1.find(f => f.kind === 'state')).toMatchObject({
        kind: 'state',
        value: 'processing',
        polarity: false,
      });

      const facts2 = extractUserFacts('I already used the product for 3 days.');
      expect(facts2.find(f => f.kind === 'state' && f.value === 'used')).toMatchObject({
        kind: 'state',
        value: 'used',
        polarity: true,
      });

      const facts3 = extractUserFacts('It is unopened in original packaging.');
      expect(facts3.find(f => f.kind === 'state' && f.value === 'opened')).toMatchObject({
        kind: 'state',
        value: 'opened',
        polarity: false,
      });
    });

    it('rejects fuzzy, relative, or subjective terms by returning empty facts', () => {
      expect(extractUserFacts('I placed my order a little while ago.')).toEqual([]);
      expect(extractUserFacts('I bought a huge cart yesterday.')).toEqual([]);
      expect(extractUserFacts('The item was used heavily.')).toEqual([]);
      expect(extractUserFacts('I made a tiny purchase recently.')).toEqual([]);
    });

    it('rejects multiple monetary amounts (breakdown or coupon arithmetic)', () => {
      expect(extractUserFacts('I bought one item for ₹500 and another for ₹700.')).toEqual([]);
    });
  });

  // ==========================================================================
  // 2. Operation Matching Tests
  // ==========================================================================
  describe('matchOperation', () => {
    it('accurately identifies target operation', () => {
      expect(matchOperation('Can I cancel my order?')).toBe('cancellation');
      expect(matchOperation('Do I get free shipping on my cart?')).toBe('shipping_threshold');
      expect(matchOperation('What is the return shipping fee?')).toBe('return_shipping_fee');
      expect(matchOperation('Can I return this shirt?')).toBe('return_window');
      expect(matchOperation('I want to dispute this transaction on my card.')).toBe('dispute_window');
      expect(matchOperation('Can I get a refund for my subscription?')).toBe('subscription_refund');
    });

    it('prevents forward shipping threshold from answering return shipping questions', () => {
      expect(matchOperation('Do I have to pay for return shipping?')).toBe('return_shipping_fee');
      expect(matchOperation('What is the fee to return an item?')).toBe('return_shipping_fee');
      expect(matchOperation('Will you cover return shipping?')).toBe('return_shipping_fee');
    });

    it('returns null on hybrid or cross-operational queries', () => {
      expect(matchOperation('Can I cancel my return?')).toBeNull();
      expect(matchOperation('Is return shipping free like regular delivery?')).toBeNull();
    });
  });

  // ==========================================================================
  // 2b. Policy Constraint Extraction Tests
  // ==========================================================================
  describe('extractPolicyConstraint', () => {
    it('extracts cancellation constraint accurately with boundary semantics', () => {
      const constraint = extractPolicyConstraint(sampleKbChunks, 'cancellation');
      expect(constraint).not.toBeNull();
      expect(constraint?.operation).toBe('cancellation');
      expect(constraint?.kind).toBe('maximum_window');
      expect(constraint?.operator).toBe('<=');
      expect(constraint?.value).toBe(120); // 2 hours = 120 mins
      expect(constraint?.secondaryConditions?.[0]?.stateKey).toBe('processing');
    });

    it('extracts shipping threshold constraint accurately', () => {
      const constraint = extractPolicyConstraint(sampleKbChunks, 'shipping_threshold');
      expect(constraint).not.toBeNull();
      expect(constraint?.operation).toBe('shipping_threshold');
      expect(constraint?.kind).toBe('minimum_threshold');
      expect(constraint?.operator).toBe('>');
      expect(constraint?.value).toBe(999);
      expect(constraint?.unit).toBe('INR');
    });

    it('extracts dispute window constraint accurately', () => {
      const constraint = extractPolicyConstraint(sampleKbChunks, 'dispute_window');
      expect(constraint).not.toBeNull();
      expect(constraint?.operation).toBe('dispute_window');
      expect(constraint?.kind).toBe('maximum_window');
      expect(constraint?.value).toBe(60 * 24 * 60); // 60 days in minutes
    });
  });

  // ==========================================================================
  // 3. Exact Boundary Value Tests
  // ==========================================================================
  describe('Boundary Semantics & Exact Limits', () => {
    // A. Cancellation Boundary (within 2 hours = <= 120 minutes)
    it('2-hour cancellation window boundaries', () => {
      // 45 minutes: satisfied (conditional_met if processing unknown)
      const res45m = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 45 minutes ago. Can I cancel?');
      expect(res45m.status).toBe('conditional_met');

      // Exactly 2 hours (120 min): satisfied
      const res120m = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 2 hours ago and it has not processed. Can I cancel?');
      expect(res120m.status).toBe('satisfied');

      // 2 hours + 1 minute (121 min): violated
      const res121m = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 121 minutes ago and it has not processed. Can I cancel?');
      expect(res121m.status).toBe('violated');
      expect((res121m as any).boundedAnswer).toContain('does not meet this requirement');

      // 4 hours (240 min): violated
      const res4h = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 4 hours ago and it has not processed. Can I cancel?');
      expect(res4h.status).toBe('violated');
    });

    // B. Monetary Threshold Boundary ("above ₹999" = > 999)
    it('Free shipping threshold "above ₹999" boundaries', () => {
      // ₹998: strictly < 999 -> violated
      const res998 = evaluatePolicyGrounding(sampleKbChunks, 'My cart is ₹998. Do I get free shipping?');
      expect(res998.status).toBe('violated');
      expect((res998 as any).boundedAnswer).toContain('does not meet this requirement');

      // Exactly ₹999: "above ₹999" requires > 999, so ₹999 is NOT above -> violated!
      const res999 = evaluatePolicyGrounding(sampleKbChunks, 'My cart is ₹999. Do I get free shipping?');
      expect(res999.status).toBe('violated');

      // ₹850: violated
      const res850 = evaluatePolicyGrounding(sampleKbChunks, 'My cart is ₹850. Do I get free shipping?');
      expect(res850.status).toBe('violated');

      // ₹1000: strictly > 999 -> satisfied!
      const res1000 = evaluatePolicyGrounding(sampleKbChunks, 'My cart is ₹1000. Do I get free shipping?');
      expect(res1000.status).toBe('satisfied');
      expect((res1000 as any).boundedAnswer).toContain('meets this requirement');
    });

    // C. Return Window Boundary (within 14 days = <= 14 days)
    it('14-day return window boundaries', () => {
      // 10 days, unused and in original packaging: satisfied
      const res10dAll = evaluatePolicyGrounding(
        sampleKbChunks,
        'I received the item 10 days ago and it is unused and in original packaging. Can I return it?'
      );
      expect(res10dAll.status).toBe('satisfied');

      // 10 days, unused only (original packaging unmentioned): conditional_met
      const res10d = evaluatePolicyGrounding(
        sampleKbChunks,
        'I received the item 10 days ago and it is unused. Can I return it?'
      );
      expect(res10d.status).toBe('conditional_met');
      expect((res10d as any).boundedAnswer).toContain('The return request is within the 14-day return window, but return eligibility also requires that');

      // Exactly 14 days, unused and in original packaging: satisfied
      const res14d = evaluatePolicyGrounding(
        sampleKbChunks,
        'I received the item 14 days ago and it is unused and in original packaging. Can I return it?'
      );
      expect(res14d.status).toBe('satisfied');

      // 15 days: violated (time expired)
      const res15d = evaluatePolicyGrounding(
        sampleKbChunks,
        'I received the item 15 days ago and it is unused and in original packaging. Can I return it?'
      );
      expect(res15d.status).toBe('violated');
    });

    // D. Dispute Window Boundary (within 60 days = <= 60 days)
    it('60-day dispute window boundaries', () => {
      // 40 days: satisfied
      const res40d = evaluatePolicyGrounding(sampleKbChunks, 'The disputed charge was 40 days ago. Can I file a dispute?');
      expect(res40d.status).toBe('satisfied');

      // Exactly 60 days: satisfied
      const res60d = evaluatePolicyGrounding(sampleKbChunks, 'The charge occurred 60 days ago. Can I dispute it?');
      expect(res60d.status).toBe('satisfied');

      // 61 days: violated
      const res61d = evaluatePolicyGrounding(sampleKbChunks, 'The charge was 61 days ago. Can I dispute it?');
      expect(res61d.status).toBe('violated');

      // 75 days: violated
      const res75d = evaluatePolicyGrounding(sampleKbChunks, 'The charge was 75 days ago. Can I file a dispute?');
      expect(res75d.status).toBe('violated');
    });
  });

  // ==========================================================================
  // 4. Multi-Condition Logic Tests
  // ==========================================================================
  describe('Multi-Condition Evaluation', () => {
    it('prioritizes violation when ANY required condition is violated', () => {
      // 4 hours (violated) even though order has NOT processed (satisfied)
      const res1 = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 4 hours ago and it has not processed. Can I cancel?');
      expect(res1.status).toBe('violated');

      // 45 minutes (satisfied) but order has already processed (violated)
      const res2 = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 45 minutes ago and it has entered processing. Can I cancel?');
      expect(res2.status).toBe('violated');
    });

    it('returns satisfied only when ALL required conditions are satisfied', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 45 minutes ago and the order has not processed. Can I cancel?');
      expect(res.status).toBe('satisfied');
    });

    it('returns conditional_met when measurable fact passes but secondary condition is unmentioned', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 45 minutes ago. Can I cancel?');
      expect(res.status).toBe('conditional_met');
      expect((res as any).boundedAnswer).toBe(
        'The order is within the 2-hour cancellation window, but cancellation also requires that the order has not entered processing.'
      );
    });

    it('never infers user state when unstated', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I ordered 1 hour ago. Can I cancel?');
      // Must NOT guess processing status based on elapsed time!
      expect(res.status).toBe('conditional_met');
      expect((res as any).boundedAnswer).toBe(
        'The order is within the 2-hour cancellation window, but cancellation also requires that the order has not entered processing.'
      );
    });
  });

  // ==========================================================================
  // 5. Explicit User State Tests
  // ==========================================================================
  describe('Product Condition States', () => {
    it('detects violation when used item is returned under unused requirement', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I used the product for a week. Can I return it?');
      expect(res.status).toBe('violated');
      expect((res as any).boundedAnswer).toContain('does not meet this requirement');
    });

    it('detects conditional_met when unused item is returned without timeframe stated', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'The product is unused. Can I return it?');
      expect(res.status).toBe('conditional_met');
      expect((res as any).boundedAnswer).toBe(
        'The item is stated as unused, but return eligibility also requires that the request is made within the 14-day return window.'
      );
    });

    it('detects satisfied when unused and unopened item is returned within timeframe', () => {
      const res = evaluatePolicyGrounding(
        sampleKbChunks,
        'I received the item 5 days ago and it is unused and in original packaging. Can I return it?'
      );
      expect(res.status).toBe('satisfied');
      expect((res as any).boundedAnswer).toContain('meets this requirement');
    });
  });

  // ==========================================================================
  // 6. Indeterminate Safety Fallthrough Tests
  // ==========================================================================
  describe('Indeterminate Fallthrough (Gate Checks)', () => {
    it('returns indeterminate on general questions without user facts', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'What is your cancellation policy?');
      expect(res.status).toBe('indeterminate');
    });

    it('returns indeterminate on fuzzy temporal terms', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order recently. Can I cancel?');
      expect(res.status).toBe('indeterminate');
    });

    it('returns indeterminate on hypothetical inquiries', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'If my order was placed 3 hours ago, can I cancel?');
      expect(res.status).toBe('indeterminate');
    });

    it('returns indeterminate on epistemic doubt', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, "I'm not sure if it has processed, but I ordered 45 minutes ago.");
      expect(res.status).toBe('indeterminate');
    });

    it('returns indeterminate on currency mismatch', () => {
      // KB is in INR (₹999), user gives USD ($50)
      const res = evaluatePolicyGrounding(sampleKbChunks, 'My cart total is $50. Do I get free shipping?');
      expect(res.status).toBe('indeterminate');
    });

    it('returns indeterminate on business day complexity', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'Can I cancel within 3 business days?');
      expect(res.status).toBe('indeterminate');
    });
  });

  // ==========================================================================
  // 7. 5-Repetition Conditional Consistency Suite (User Mandate #12)
  // ==========================================================================
  describe('5-Repetition Deterministic Consistency Suite (10 Cases)', () => {
    const canonicalCases: Array<{ name: string; query: string; expectedStatus: string }> = [
      {
        name: '45-minute cancellation',
        query: 'I placed my order 45 minutes ago. Can I cancel?',
        expectedStatus: 'conditional_met',
      },
      {
        name: 'exactly 2-hour cancellation',
        query: 'I placed my order 2 hours ago and it has not processed. Can I cancel?',
        expectedStatus: 'satisfied',
      },
      {
        name: '4-hour cancellation',
        query: 'I placed my order 4 hours ago and it has not processed. Can I cancel?',
        expectedStatus: 'violated',
      },
      {
        name: '₹850 vs ₹999',
        query: 'My cart total is ₹850. Do I get free shipping?',
        expectedStatus: 'violated',
      },
      {
        name: 'exactly ₹999',
        query: 'My cart total is ₹999. Do I get free shipping?',
        expectedStatus: 'violated',
      },
      {
        name: '40-day dispute',
        query: 'The disputed charge was 40 days ago. Can I file a dispute?',
        expectedStatus: 'satisfied',
      },
      {
        name: '60-day dispute',
        query: 'The charge occurred 60 days ago. Can I dispute it?',
        expectedStatus: 'satisfied',
      },
      {
        name: '75-day dispute',
        query: 'The charge was 75 days ago. Can I file a dispute?',
        expectedStatus: 'violated',
      },
      {
        name: 'used product',
        query: 'I used the product for a week. Can I return it?',
        expectedStatus: 'violated',
      },
      {
        name: 'unused product',
        query: 'I received the item 5 days ago and it is unused and in original packaging. Can I return it?',
        expectedStatus: 'satisfied',
      },
    ];

    for (const testCase of canonicalCases) {
      it(`evaluates ${testCase.name} 5 times with byte-identical outputs`, () => {
        const results: string[] = [];

        for (let rep = 0; rep < 5; rep++) {
          const evalResult = evaluatePolicyGrounding(sampleKbChunks, testCase.query);
          expect(evalResult.status).toBe(testCase.expectedStatus);
          expect((evalResult as any).boundedAnswer).toBeDefined();
          results.push((evalResult as any).boundedAnswer);
        }

        // Verify all 5 repetitions are 100% byte-identical
        const firstOutput = results[0];
        for (let rep = 1; rep < 5; rep++) {
          expect(results[rep]).toBe(firstOutput);
        }
      });
    }
  });

  // ==========================================================================
  // 8. Final Hardening Pass: 15 Adversarial & Parser-Boundary Cases
  // ==========================================================================
  describe('15 Adversarial & Parser-Boundary Cases', () => {
    // 1. "2 hours and 30 minutes ago"
    it('Case 1: "2 hours and 30 minutes ago" yields indeterminate (compound duration)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order 2 hours and 30 minutes ago. Can I cancel?');
      expect(res.status).toBe('indeterminate');
    });

    // 2. "₹999.50"
    it('Case 2: "₹999.50" unambiguously evaluates to satisfied on "above ₹999"', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'My cart total is ₹999.50. Do I get free shipping?');
      expect(res.status).toBe('satisfied');
      expect((res as any).boundedAnswer).toContain('meets this requirement');
    });

    // 3. "INR 999"
    it('Case 3: "INR 999" unambiguously evaluates to violated on "above ₹999" (999 is not > 999)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'My cart total is INR 999. Do I get free shipping?');
      expect(res.status).toBe('violated');
      expect((res as any).boundedAnswer).toContain('does not meet this requirement');
    });

    // 4. "₹1,000 with a ₹300 coupon"
    it('Case 4: "₹1,000 with a ₹300 coupon" yields indeterminate (coupon/discount arithmetic)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'My cart is ₹1,000 with a ₹300 coupon. Do I get free shipping?');
      expect(res.status).toBe('indeterminate');
    });

    // 5. "₹500 + ₹700"
    it('Case 5: "₹500 + ₹700" yields indeterminate (arithmetic breakdown)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'My cart has items worth ₹500 + ₹700. Do I get free shipping?');
      expect(res.status).toBe('indeterminate');
    });

    // 6. "yesterday"
    it('Case 6: "yesterday" yields indeterminate (fuzzy relative temporal term)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I placed my order yesterday. Can I cancel?');
      expect(res.status).toBe('indeterminate');
    });

    // 7. "last week"
    it('Case 7: "last week" yields indeterminate (relative temporal term)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I received the item last week. Can I return it?');
      expect(res.status).toBe('indeterminate');
    });

    // 8. "I opened the package just to inspect it"
    it('Case 8: "I opened the package just to inspect it" yields indeterminate (inspection-only intent)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I opened the package just to inspect it. Can I return it?');
      expect(res.status).toBe('indeterminate');
    });

    // 9. "I tested the product once"
    it('Case 9: "I tested the product once" yields indeterminate (partial/qualified state)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'I tested the product once. Can I return it?');
      expect(res.status).toBe('indeterminate');
    });

    // 10. "I don't think my order has processed"
    it('Case 10: "I don\'t think my order has processed" yields indeterminate (epistemic doubt)', () => {
      const res = evaluatePolicyGrounding(
        sampleKbChunks,
        "I placed my order 45 minutes ago, but I don't think my order has processed. Can I cancel?"
      );
      expect(res.status).toBe('indeterminate');
    });

    // 11. "my order was placed 2 hours ago but I want to cancel tomorrow"
    it('Case 11: "my order was placed 2 hours ago but I want to cancel tomorrow" yields indeterminate (deferred action intent)', () => {
      const res = evaluatePolicyGrounding(
        sampleKbChunks,
        'my order was placed 2 hours ago but I want to cancel tomorrow'
      );
      expect(res.status).toBe('indeterminate');
    });

    // 12. "can I cancel my return?"
    it('Case 12: "can I cancel my return?" yields indeterminate (hybrid cross-operation)', () => {
      const res = evaluatePolicyGrounding(sampleKbChunks, 'can I cancel my return?');
      expect(res.status).toBe('indeterminate');
    });

    // 13. Policy text containing two conflicting thresholds for the same operation
    it('Case 13: Conflicting thresholds in KB for the same operation yields indeterminate', () => {
      const conflictingKb: RetrievalResult[] = [
        {
          sourceFilename: 'policy_a.md',
          chunkIndex: 0,
          content: '### Order Cancellation\nOrders can be cancelled within 2 hours of placement.',
          score: 0,
        },
        {
          sourceFilename: 'policy_b.md',
          chunkIndex: 1,
          content: '### Cancellation Policy\nOrders can be cancelled within 24 hours of placement.',
          score: 0,
        },
      ];
      const res = evaluatePolicyGrounding(
        conflictingKb,
        'I placed my order 1 hour ago and it has not processed. Can I cancel?'
      );
      expect(res.status).toBe('indeterminate');
      expect((res as any).reason).toBe('no_confident_policy_constraint');
    });

    // 14. A numeric value belonging to an unrelated policy in another chunk
    it('Case 14: Numeric value from an unrelated policy in another chunk does not bleed into threshold check', () => {
      // Return fee is ₹150 in orders.md, shipping threshold is ₹999
      const res = evaluatePolicyGrounding(sampleKbChunks, 'My cart total is ₹150. Do I get free shipping?');
      // ₹150 does not satisfy ₹999 shipping threshold -> strictly violated, not confused with return fee!
      expect(res.status).toBe('violated');
      expect((res as any).constraint.operation).toBe('shipping_threshold');
      expect((res as any).constraint.value).toBe(999);

      // And an unrelated numeric query without an established policy falls through to indeterminate
      const resUnrelated = evaluatePolicyGrounding(sampleKbChunks, 'Can I get a discount for ₹150?');
      expect(resUnrelated.status).toBe('indeterminate');
    });

    // 15. Same number/unit but different operation
    it('Case 15: Same number/unit across different operations does not cause cross-bleed', () => {
      // 14 days is return window; cancellation is 2 hours. User asks to cancel in 14 days.
      const res = evaluatePolicyGrounding(sampleKbChunks, 'Can I cancel my order within 14 days?');
      expect(res.status).toBe('violated'); // 14 days (20160 mins) is strictly > 120 mins
      expect((res as any).constraint.operation).toBe('cancellation');

      // Cross-operational inquiry: "Is return shipping free for orders above ₹999?"
      const resHybrid = evaluatePolicyGrounding(sampleKbChunks, 'Is return shipping free for orders above ₹999?');
      expect(resHybrid.status).toBe('indeterminate');
    });
  });

  // ==========================================================================
  // 9. Exact Boundary Semantics Suite
  // ==========================================================================
  describe('Exact Boundary Semantics Verification', () => {
    // 1. "above 999" -> strictly > 999
    it('Strictly greater than ("> 999"): 998, 999, 999.50, 1000', () => {
      const r998 = evaluatePolicyGrounding(sampleKbChunks, 'My cart total is ₹998. Do I get free shipping?');
      expect(r998.status).toBe('violated');

      const r999 = evaluatePolicyGrounding(sampleKbChunks, 'My cart total is ₹999. Do I get free shipping?');
      expect(r999.status).toBe('violated');

      const r999_5 = evaluatePolicyGrounding(sampleKbChunks, 'My cart total is ₹999.50. Do I get free shipping?');
      expect(r999_5.status).toBe('satisfied');

      const r1000 = evaluatePolicyGrounding(sampleKbChunks, 'My cart total is ₹1000. Do I get free shipping?');
      expect(r1000.status).toBe('satisfied');
    });

    // 2. "at least 999" -> >= 999
    it('Greater than or equal (">= 999"): 998, 999, 1000', () => {
      const atLeastKb: RetrievalResult[] = [
        {
          sourceFilename: 'shipping.md',
          chunkIndex: 0,
          content: '### Free Shipping\nWe offer free standard shipping on orders of at least ₹999.',
          score: 0,
        },
      ];

      const r998 = evaluatePolicyGrounding(atLeastKb, 'My cart total is ₹998. Do I get free shipping?');
      expect(r998.status).toBe('violated');

      const r999 = evaluatePolicyGrounding(atLeastKb, 'My cart total is ₹999. Do I get free shipping?');
      expect(r999.status).toBe('satisfied');

      const r1000 = evaluatePolicyGrounding(atLeastKb, 'My cart total is ₹1000. Do I get free shipping?');
      expect(r1000.status).toBe('satisfied');
    });

    // 3. "within 2 hours" -> <= 2 hours
    it('Less than or equal ("<= 120 mins"): 120m, 121m', () => {
      const r120 = evaluatePolicyGrounding(
        sampleKbChunks,
        'I placed my order 2 hours ago and it has not processed. Can I cancel?'
      );
      expect(r120.status).toBe('satisfied');

      const r121 = evaluatePolicyGrounding(
        sampleKbChunks,
        'I placed my order 121 minutes ago and it has not processed. Can I cancel?'
      );
      expect(r121.status).toBe('violated');
    });

    // 4. "under 14 days" -> < 14 days
    it('Strictly less than ("< 14 days"): 13 days, 14 days, 15 days', () => {
      const underKb: RetrievalResult[] = [
        {
          sourceFilename: 'returns.md',
          chunkIndex: 0,
          content: '### Returns Policy\nItems may be returned under 14 days of delivery. All returned items must be unused and in original packaging.',
          score: 0,
        },
      ];

      // 13 days: < 14 -> satisfied
      const r13 = evaluatePolicyGrounding(
        underKb,
        'I received the item 13 days ago and it is unused and in original packaging. Can I return it?'
      );
      expect(r13.status).toBe('satisfied');

      // Exactly 14 days: NOT < 14 -> violated
      const r14 = evaluatePolicyGrounding(
        underKb,
        'I received the item 14 days ago and it is unused and in original packaging. Can I return it?'
      );
      expect(r14.status).toBe('violated');

      // 15 days: violated
      const r15 = evaluatePolicyGrounding(
        underKb,
        'I received the item 15 days ago and it is unused and in original packaging. Can I return it?'
      );
      expect(r15.status).toBe('violated');
    });
  });
});
