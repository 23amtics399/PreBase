import type { RetrievalResult } from './retrieval';
import { resolveTrustedSupportContact } from './entity_grounding';

// ============================================================================
// 1. Types & Data Structures
// ============================================================================

export type FactKind = 'duration' | 'money' | 'quantity' | 'state';

export interface UserFact {
  kind: FactKind;
  /** Normalized numeric value (e.g. minutes for duration, float for money, integer for quantity) or boolean/string for state */
  value: number | string | boolean;
  unit?: string; // 'minute' | 'hour' | 'day' | 'week' | 'month' | 'INR' | 'USD' | 'EUR' | 'GBP' | 'requests' | 'items' | 'orders' | 'calls'
  raw: string;
  /** For state facts: true = asserted active, false = asserted inactive / not */
  polarity?: boolean;
}

export type ConstraintKind =
  | 'maximum_window'      // e.g. "within 2 hours", "up to 30 days"
  | 'minimum_advance'     // e.g. "at least 24 hours in advance"
  | 'minimum_threshold'   // e.g. "orders above ₹999", "at least $500"
  | 'maximum_threshold'   // e.g. "under 1,000 requests"
  | 'required_state'      // e.g. "unopened", "not entered processing"
  | 'explicit_negative';  // e.g. "does not specify: - A return shipping fee"

export type BoundaryOperator = '<' | '<=' | '>' | '>=';

export interface SecondaryCondition {
  raw: string;
  description: string;
  stateKey: 'processing' | 'opened' | 'used' | 'shipped' | 'damaged' | 'packaging';
  requiredPolarity: boolean; // e.g. processing must be false
}

export interface PolicyConstraint {
  operation: string; // 'cancellation' | 'shipping_threshold' | 'return_shipping_fee' | 'return_window' | 'dispute_window' | 'subscription_refund'
  kind: ConstraintKind;
  operator: BoundaryOperator;
  value?: number;
  unit?: string;
  rawEvidence: string;
  secondaryConditions?: SecondaryCondition[];
}

export type PolicyEvaluation =
  | {
      status: 'satisfied' | 'violated' | 'conditional_met' | 'explicit_negative';
      constraint: PolicyConstraint;
      userFact?: UserFact;
      evidence: string;
      boundedAnswer: string;
    }
  | {
      status: 'indeterminate';
      reason: string;
    };

// ============================================================================
// 2. Ambiguity & Noise Filters (Gate 1 & Gate 4)
// ============================================================================

/**
 * Detects fuzzy, relative, or subjective language that lacks concrete numerical grounding.
 * Any match disqualifies deterministic evaluation and yields 'indeterminate'.
 */
const RELATIVE_OR_FUZZY_PATTERNS = [
  /\b(?:a few days(?: ago)?|few days|recently|earlier today|a while ago|just now|shortly|last week|a little while ago)\b/i,
  /\b(?:yesterday|today|tomorrow)\b/i,
  /\b(?:large cart|tiny purchase|expensive order|bunch of items|several requests|huge cart|small order)\b/i,
  /\b(?:used heavily|worn out|barely used|slightly used|somewhat)\b/i,
];

/**
 * Detects hypothetical, speculative, or advice-seeking inquiries.
 * The policy engine never evaluates hypotheticals; those fall through to Granite.
 */
const HYPOTHETICAL_PATTERNS = [
  /\b(?:if\s+(?:i\b|my\b|the\b|an?\b|we\b|you\b)|what if|suppose|assuming|would it be|will it be)\b/i,
  /\b(?:hypothetically|in case i|should i wait)\b/i,
];

/**
 * Detects epistemic doubt or uncertain user statements regarding state.
 */
const EPISTEMIC_DOUBT_PATTERNS = [
  /\b(?:not sure if|don't think|do not think|might have|may have|as far as i (?:know|can tell)|i think|unsure)\b/i,
];

/**
 * Detects hybrid or cross-operational inquiries where the primary intent is ambiguous.
 */
const HYBRID_OPERATION_PATTERNS = [
  /\b(?:cancel (?:my )?return|return (?:a )?cancelled order|dispute (?:a )?cancelled order)\b/i,
  /\b(?:is return shipping free like (?:forward|regular|standard)?\s*delivery|is return delivery free)\b/i,
  /\b(?:is return shipping free for orders above)\b/i,
];

/**
 * Detects future or deferred operational intent that decouples current elapsed time from execution time.
 * E.g. "my order was placed 2 hours ago but I want to cancel tomorrow"
 */
const FUTURE_OR_DEFERRED_ACTION_PATTERNS = [
  /\b(?:(?:want to|will|plan(?:ning)? to|going to)\s+(?:cancel|return|dispute)\s+(?:tomorrow|later|next week|in a few days))\b/i,
  /\b(?:cancel tomorrow|cancel later|return tomorrow|return later|dispute later)\b/i,
];

/**
 * Detects arithmetic expressions, coupon/discount modifiers, or compound duration values.
 * E.g. "₹1,000 with a ₹300 coupon", "₹500 + ₹700", "2 hours and 30 minutes"
 */
const ARITHMETIC_OR_COUPON_PATTERNS = [
  /\b(?:coupon|voucher|promo(?:tion)?|promo code|discount code|gift card)\b/i,
  /\b(?:\+|\bplus\b|\bminus\b|\bsum of\b)\b/i,
  /\b\d+\s*(?:hours?|hrs?)\s*(?:and|\+)\s*\d+\s*(?:minutes?|mins?)\b/i,
];

/**
 * Detects qualified, inspection-only, or partial states that are ambiguous under binary state policies.
 * E.g. "opened the package just to inspect it", "tested the product once"
 */
const QUALIFIED_OR_PARTIAL_STATE_PATTERNS = [
  /\b(?:just to (?:inspect|check|see|look)|only to (?:inspect|check|see|look)|opened (?:the )?(?:outer )?box to inspect|opened just to)\b/i,
  /\b(?:tested(?: the product)?(?: once)?|tried (?:it|the product)(?: once)?|used once|tested once|barely used)\b/i,
];

/**
 * Detects calendar or business day conditions that require external calendar calculations.
 */
const CALENDAR_COMPLEXITY_PATTERNS = [
  /\b(?:business days?|working days?|excluding weekends|public holidays?)\b/i,
];

// ============================================================================
// 3. Fact Extraction (Gate 1: USER_FACT_CONFIDENT)
// ============================================================================

/**
 * Normalizes duration string and unit to minutes.
 */
function normalizeDurationToMinutes(val: number, unit: string): number {
  const u = unit.toLowerCase();
  if (/^min(?:ute)?s?$/i.test(u)) return val;
  if (/^h(?:ou)?rs?$/i.test(u)) return val * 60;
  if (/^days?$/i.test(u)) return val * 24 * 60;
  if (/^weeks?$/i.test(u)) return val * 7 * 24 * 60;
  if (/^months?$/i.test(u)) return val * 30 * 24 * 60;
  return val;
}

/**
 * Normalizes currency strings into standard ISO codes.
 */
function normalizeCurrency(raw: string): string {
  const s = raw.trim();
  if (s === '₹' || /^inr$/i.test(s) || /^rs\.?$/i.test(s) || /^rupees?$/i.test(s)) return 'INR';
  if (s === '$' || /^usd$/i.test(s) || /^dollars?$/i.test(s)) return 'USD';
  if (s === '€' || /^eur$/i.test(s) || /^euros?$/i.test(s)) return 'EUR';
  if (s === '£' || /^gbp$/i.test(s) || /^pounds?$/i.test(s)) return 'GBP';
  return s.toUpperCase();
}

/**
 * Extracts concrete user facts from user inquiry.
 * Returns null if ambiguous, contradictory, or ungrounded.
 */
export function extractUserFacts(message: string): UserFact[] {
  const msg = message.trim();

  // 1. Disqualify fuzzy or relative temporal expressions
  for (const p of RELATIVE_OR_FUZZY_PATTERNS) {
    if (p.test(msg)) return [];
  }

  // 2. Disqualify hypotheticals
  for (const p of HYPOTHETICAL_PATTERNS) {
    if (p.test(msg)) return [];
  }

  // 3. Disqualify epistemic doubt
  for (const p of EPISTEMIC_DOUBT_PATTERNS) {
    if (p.test(msg)) return [];
  }

  // 4. Disqualify hybrid operations
  for (const p of HYBRID_OPERATION_PATTERNS) {
    if (p.test(msg)) return [];
  }

  // 5. Disqualify business day calculations
  for (const p of CALENDAR_COMPLEXITY_PATTERNS) {
    if (p.test(msg)) return [];
  }

  // 6. Disqualify future or deferred actions
  for (const p of FUTURE_OR_DEFERRED_ACTION_PATTERNS) {
    if (p.test(msg)) return [];
  }

  // 7. Disqualify arithmetic expressions, coupons, or compound duration values
  for (const p of ARITHMETIC_OR_COUPON_PATTERNS) {
    if (p.test(msg)) return [];
  }

  // 8. Disqualify qualified, inspection-only, or partial states
  for (const p of QUALIFIED_OR_PARTIAL_STATE_PATTERNS) {
    if (p.test(msg)) return [];
  }

  const facts: UserFact[] = [];

  // --- A. Temporal Fact Extraction ---
  // Matches "4 hours ago", "45 minutes ago", "placed 2 hours ago", "40 days ago", "14 days", "for a week" (1 week)
  const temporalRegex = /\b(\d+(?:\.\d+)?|a|an|one)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s*(?:ago|elapsed|since)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = temporalRegex.exec(msg)) !== null) {
    const rawNumStr = m[1].toLowerCase();
    const rawVal = rawNumStr === 'a' || rawNumStr === 'an' || rawNumStr === 'one' ? 1 : parseFloat(rawNumStr);
    const unit = m[2].toLowerCase();
    const minutes = normalizeDurationToMinutes(rawVal, unit);
    facts.push({
      kind: 'duration',
      value: minutes,
      unit: 'minute',
      raw: m[0].trim(),
    });
  }

  // --- B. Monetary Fact Extraction ---
  // Matches "₹850", "₹ 999", "Rs. 850", "$500", "500 USD", "€40", "£30", "total is ₹850", "cart is ₹850"
  const moneyRegex = /(?:(₹|\$|€|£|INR|USD|EUR|GBP|Rs\.?)\s*(\d+(?:,\d{3})*(?:\.\d+)?)|(\d+(?:,\d{3})*(?:\.\d+)?)\s*(₹|\$|€|£|INR|USD|EUR|GBP|Rs\.?|rupees?|dollars?|euros?|pounds?))\b/gi;
  while ((m = moneyRegex.exec(msg)) !== null) {
    const currRaw = m[1] || m[4];
    const numRaw = (m[2] || m[3]).replace(/,/g, '');
    const val = parseFloat(numRaw);
    const curr = normalizeCurrency(currRaw);
    facts.push({
      kind: 'money',
      value: val,
      unit: curr,
      raw: m[0].trim(),
    });
  }

  // --- C. Quantity Fact Extraction ---
  const quantityRegex = /\b(\d+(?:,\d{3})*)\s*(requests?|api requests?|api calls?|calls?|items?|units?|orders?)\b/gi;
  while ((m = quantityRegex.exec(msg)) !== null) {
    const numRaw = m[1].replace(/,/g, '');
    const val = parseInt(numRaw, 10);
    const unit = m[2].toLowerCase();
    facts.push({
      kind: 'quantity',
      value: val,
      unit,
      raw: m[0].trim(),
    });
  }

  // --- D. Explicit State Fact Extraction ---
  // Order processing state
  if (/\b(?:not\s+(?:yet\s+)?(?:entered\s+)?process(?:ed|ing)|unprocessed|order has not processed)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'processing',
      polarity: false,
      raw: 'order has not entered processing',
    });
  } else if (/\b(?:has\s+(?:already\s+)?(?:entered\s+)?processing|is processing|already processed|order has processed)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'processing',
      polarity: true,
      raw: 'order has entered processing',
    });
  }

  // Product condition: opened / unopened
  if (/\b(?:unopened|sealed|never opened|in (?:its )?original packaging)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'opened',
      polarity: false,
      raw: 'unopened in original packaging',
    });
  } else if (/\b(?:opened|unsealed|seal is broken|box was opened)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'opened',
      polarity: true,
      raw: 'opened',
    });
  }

  // Product condition: used / unused
  if (/\b(?:unused|never used|not used|brand new)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'used',
      polarity: false,
      raw: 'unused',
    });
  } else if (/\b(?:used(?: it)?|have used|i used|used the product)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'used',
      polarity: true,
      raw: 'used',
    });
  }

  // Shipping status: shipped / not shipped
  if (/\b(?:not (?:yet )?shipped|has not shipped|before shipping|unshipped)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'shipped',
      polarity: false,
      raw: 'not shipped',
    });
  } else if (/\b(?:already shipped|has shipped|item shipped|package shipped)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'shipped',
      polarity: true,
      raw: 'shipped',
    });
  }

  // Damage status: damaged / undamaged
  if (/\b(?:not damaged|undamaged|in good condition|no damage)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'damaged',
      polarity: false,
      raw: 'undamaged',
    });
  } else if (/\b(?:damaged|broken|defective)\b/i.test(msg)) {
    facts.push({
      kind: 'state',
      value: 'damaged',
      polarity: true,
      raw: 'damaged',
    });
  }

  // Check for multi-fact contradiction or arithmetic breakdown
  const moneyFacts = facts.filter(f => f.kind === 'money');
  if (moneyFacts.length > 1) {
    return [];
  }

  const durationFacts = facts.filter(f => f.kind === 'duration');
  if (durationFacts.length > 1) {
    return [];
  }

  return facts;
}

// ============================================================================
// 4. Operation Matching (Gate 3: OPERATION_MATCH_CONFIDENT)
// ============================================================================

export type PolicyOperation =
  | 'cancellation'
  | 'shipping_threshold'
  | 'return_shipping_fee'
  | 'return_window'
  | 'dispute_window'
  | 'subscription_refund';

/**
 * Identifies the target operation from the user inquiry.
 * Returns null if the inquiry does not unambiguously match a single supported operation.
 */
export function matchOperation(message: string): PolicyOperation | null {
  const msg = message.toLowerCase();

  // Disqualify hybrid or cross-operational queries immediately
  for (const p of HYBRID_OPERATION_PATTERNS) {
    if (p.test(msg)) return null;
  }

  // 1. Subscription refund (prioritize before general cancellation)
  if (
    /\b(?:subscription refund|refund (?:for |my )?subscription|refund (?:for |my )?plan)\b/i.test(msg) ||
    (/\brefund\b/i.test(msg) && /\b(?:subscription|plan)\b/i.test(msg))
  ) {
    return 'subscription_refund';
  }

  // 2. Cancellation: "cancel my order", "order cancellation"
  if (/\b(?:cancel(?:lation|ing|led)?|cancelling)\b/i.test(msg)) {
    if (/\breturn\b/i.test(msg)) {
      return null;
    }
    return 'cancellation';
  }

  // 3. Return shipping fee: Must precede general shipping threshold
  if (/\b(?:return shipping(?: fee| charge| cost)?|cost to return|fee to return|pay for return shipping)\b/i.test(msg)) {
    return 'return_shipping_fee';
  }

  // 4. Free shipping threshold: Forward shipping
  if (/\b(?:free shipping|qualify for free shipping|free delivery|shipping fee|shipping charge|delivery fee)\b/i.test(msg)) {
    return 'shipping_threshold';
  }

  // 5. Dispute window: Disputing charge / billing
  if (/\b(?:dispute|disputes|disputing|disputed|chargeback|unauthorized charge)\b/i.test(msg)) {
    return 'dispute_window';
  }

  // 6. Return window / return eligibility
  if (/\b(?:return|returns|returning|send back|sent back)\b/i.test(msg)) {
    return 'return_window';
  }

  return null;
}

// ============================================================================
// 5. Policy Constraint Extraction (Gate 2: POLICY_CONSTRAINT_CONFIDENT)
// ============================================================================

/**
 * Parses operator string from authoritative text with exact boundary semantics.
 */
function parseOperator(text: string): BoundaryOperator {
  if (/\b(?:above|over|more than|exceeding|strictly greater than)\b/i.test(text)) {
    return '>';
  }
  if (/\b(?:at least|minimum of|or more|and above|prior to|in advance)\b/i.test(text)) {
    return '>=';
  }
  if (/\b(?:under|less than|fewer than|strictly less than)\b/i.test(text)) {
    return '<';
  }
  return '<=';
}

/**
 * Extracts secondary state conditions from a policy text block.
 */
function extractSecondaryConditions(text: string): SecondaryCondition[] {
  const conditions: SecondaryCondition[] = [];

  // 1. Processing check
  if (/\b(?:not (?:yet )?(?:entered )?processing|before (?:it enters )?processing|has not processed)\b/i.test(text)) {
    conditions.push({
      raw: 'order has not entered processing',
      description: 'the order has not entered processing',
      stateKey: 'processing',
      requiredPolarity: false,
    });
  }

  // 2. Unused check
  if (/\b(?:unused|never used)\b/i.test(text)) {
    conditions.push({
      raw: 'product must be unused',
      description: 'the item is unused',
      stateKey: 'used',
      requiredPolarity: false,
    });
  }

  // 3. Packaging / unopened check
  if (/\b(?:unopened|original packaging|seal intact)\b/i.test(text)) {
    conditions.push({
      raw: 'product must be in original packaging',
      description: 'the item is in original packaging with all seals intact',
      stateKey: 'opened',
      requiredPolarity: false,
    });
  }

  return conditions;
}

/**
 * Extracts the single governing policy constraint from authoritative KB chunks for a matched operation.
 * Returns null if no constraint exists or if contradictory constraints are found.
 */
export function extractPolicyConstraint(
  chunks: RetrievalResult[],
  operation: PolicyOperation
): PolicyConstraint | null {
  const candidateConstraints: PolicyConstraint[] = [];

  for (const chunk of chunks) {
    const text = chunk.content;
    const paragraphs = text.split(/\r?\n\s*\r?\n/);

    for (const para of paragraphs) {
      const pClean = para.trim();
      if (pClean.length < 20) continue;
      // Strip markdown artifacts (headings, bold, italics, code) for robust semantic extraction
      const pNormalized = pClean.replace(/[*_~`#]/g, '').replace(/\s+/g, ' ').trim();

      // 1. Cancellation Policy
      if (operation === 'cancellation') {
        if (/\b(?:cancel(?:led|ed|lation)?)\b/i.test(pNormalized) && /\b(?:within|up to|window|hours?|minutes?|under|less than)\b/i.test(pNormalized)) {
          const match = /\b(?:within|up to|in|under|less than)\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(pNormalized);
          if (match) {
            const val = parseFloat(match[1]);
            const unit = match[2];
            const minutes = normalizeDurationToMinutes(val, unit);
            const op = parseOperator(match[0]);
            const secondary = extractSecondaryConditions(pNormalized);

            candidateConstraints.push({
              operation,
              kind: 'maximum_window',
              operator: op,
              value: minutes,
              unit: 'minute',
              rawEvidence: pClean.split(/(?<=[.?!])\s+/)[0] || pClean,
              secondaryConditions: secondary,
            });
          }
        }
      }

      // 2. Free Shipping Threshold
      if (operation === 'shipping_threshold') {
        const isFreeShipping = !/\breturn shipping\b/i.test(pNormalized) && (
          /\b(?:free (?:standard |domestic )?(?:shipping|delivery))\b/i.test(pNormalized) ||
          /\b(?:shipping|delivery)\s+(?:is\s+)?free\b/i.test(pNormalized) ||
          /\bfree for (?:all )?orders\b/i.test(pNormalized)
        );
        if (isFreeShipping) {
          const match = /\b(above|over|more than|at least|minimum of|exceeding)\s*(?:(₹|\$|€|£|INR|USD|EUR|GBP|Rs\.?)\s*(\d+(?:,\d{3})*(?:\.\d+)?)|(\d+(?:,\d{3})*(?:\.\d+)?)\s*(₹|\$|€|£|INR|USD|EUR|GBP|Rs\.?|rupees?|dollars?|euros?|pounds?))\b/i.exec(pNormalized);
          if (match) {
            const opWord = match[1];
            const currRaw = match[2] || match[5];
            const numRaw = (match[3] || match[4]).replace(/,/g, '');
            const val = parseFloat(numRaw);
            const curr = normalizeCurrency(currRaw);
            const op = parseOperator(opWord);

            candidateConstraints.push({
              operation,
              kind: 'minimum_threshold',
              operator: op,
              value: val,
              unit: curr,
              rawEvidence: pClean.split(/(?<=[.?!])\s+/)[0] || pClean,
            });
          }
        }
      }

      // 3. Return Shipping Fee Policy
      if (operation === 'return_shipping_fee') {
        if (/\b(?:return shipping|cost of return|cost to return)\b/i.test(pNormalized)) {
          // A. Check if explicitly declared as not specified / not covered
          const isNegative =
            /\b(?:does not specify|not specified in (?:this )?knowledge base|information not covered|not covered|does not mention|unspecified)\b/i.test(pNormalized) ||
            /^(?:-\s*)?a return shipping fee\b/i.test(pClean);

          if (isNegative) {
            candidateConstraints.push({
              operation,
              kind: 'explicit_negative',
              operator: '<=',
              rawEvidence: pClean,
            });
          } else {
            // B. Check for numeric return fee: "flat return shipping fee of ₹150", "return shipping fee is $10"
            const feeMatch = /\b(?:return shipping(?: fee| charge| cost)?|cost of return|cost to return)\s*(?:is|of|costs?|flat fee of)?\s*(?:(₹|\$|€|£|INR|USD|EUR|GBP|Rs\.?)\s*(\d+(?:,\d{3})*(?:\.\d+)?)|(\d+(?:,\d{3})*(?:\.\d+)?)\s*(₹|\$|€|£|INR|USD|EUR|GBP|Rs\.?|rupees?|dollars?|euros?|pounds?))\b/i.exec(pNormalized);
            if (feeMatch) {
              const currRaw = feeMatch[1] || feeMatch[4];
              const numRaw = (feeMatch[2] || feeMatch[3]).replace(/,/g, '');
              const val = parseFloat(numRaw);
              const curr = normalizeCurrency(currRaw);
              candidateConstraints.push({
                operation,
                kind: 'minimum_threshold',
                operator: '<=',
                value: val,
                unit: curr,
                rawEvidence: pClean.split(/(?<=[.?!])\s+/)[0] || pClean,
              });
            }
          }
        }
      }

      // 4. Return Window Policy
      if (operation === 'return_window') {
        if (/\b(?:returns?|returned)\b/i.test(pNormalized)) {
          const match = /\b(?:within|up to|in|under|less than|fewer than)\s+(\d+)\s*(days?|weeks?|months?)\b/i.exec(pNormalized);
          const secondary = extractSecondaryConditions(pNormalized);

          if (match) {
            const val = parseInt(match[1], 10);
            const unit = match[2];
            const minutes = normalizeDurationToMinutes(val, unit);
            const op = parseOperator(match[0]);

            candidateConstraints.push({
              operation,
              kind: 'maximum_window',
              operator: op,
              value: minutes,
              unit: 'minute',
              rawEvidence: pClean, // Keep the full paragraph context for returns
              secondaryConditions: secondary,
            });
          } else if (secondary.length > 0) {
            candidateConstraints.push({
              operation,
              kind: 'required_state',
              operator: '<=',
              rawEvidence: pClean,
              secondaryConditions: secondary,
            });
          }
        }
      }

      // 5. Dispute Window Policy
      if (operation === 'dispute_window') {
        if (/\b(?:dispute|disputes|chargeback)\b/i.test(pNormalized) && /\b(?:within|up to|in|under|less than|days?|months?)\b/i.test(pNormalized)) {
          const match = /\b(?:within|up to|in|under|less than)\s+(\d+)\s*(days?|months?)\b/i.exec(pNormalized);
          if (match) {
            const val = parseInt(match[1], 10);
            const unit = match[2];
            const minutes = normalizeDurationToMinutes(val, unit);
            const op = parseOperator(match[0]);

            candidateConstraints.push({
              operation,
              kind: 'maximum_window',
              operator: op,
              value: minutes,
              unit: 'minute',
              rawEvidence: pClean.split(/(?<=[.?!])\s+/)[0] || pClean,
            });
          }
        }
      }

      // 6. Subscription Refund Policy
      if (operation === 'subscription_refund') {
        if (/\b(?:subscription|plan)\b/i.test(pNormalized) && /\b(?:refund|refunds)\b/i.test(pNormalized)) {
          const timeMatch = /\b(?:within|up to|in|under|less than)\s+(\d+)\s*(days?|weeks?)\b/i.exec(pNormalized);
          const reqMatch = /\b(?:under|less than|fewer than)\s+(\d+(?:,\d{3})*)\s*(requests?|api requests?|api calls?)\b/i.exec(pNormalized);

          if (timeMatch) {
            const val = parseInt(timeMatch[1], 10);
            const unit = timeMatch[2];
            const minutes = normalizeDurationToMinutes(val, unit);

            candidateConstraints.push({
              operation,
              kind: 'maximum_window',
              operator: '<=',
              value: minutes,
              unit: 'minute',
              rawEvidence: pClean.split(/(?<=[.?!])\s+/)[0] || pClean,
              secondaryConditions: reqMatch ? [{
                raw: reqMatch[0],
                description: `usage under ${reqMatch[1]} API requests`,
                stateKey: 'processing',
                requiredPolarity: true,
              }] : undefined,
            });
          }
        }
      }
    }
  }

  if (operation === 'return_shipping_fee' && candidateConstraints.length === 0) {
    const fullKb = chunks.map(c => c.content).join('\n\n');
    const isExplicitlyUnspecified =
      /(?:information not covered|this knowledge base does not specify|does not specify|not specified in (?:this )?knowledge base)[^#]*?(?:return shipping(?: fee| charge| cost)?|cost of return|cost to return)/i.test(fullKb);
    if (isExplicitlyUnspecified) {
      candidateConstraints.push({
        operation,
        kind: 'explicit_negative',
        operator: '<=',
        rawEvidence: 'This knowledge base does not specify a return shipping fee.',
      });
    }
  }

  if (candidateConstraints.length === 0) {
    return null;
  }

  // Check for contradiction among candidate constraints (Gate 4: NO_CONTRADICTORY_EVIDENCE)
  const first = candidateConstraints[0];
  for (let i = 1; i < candidateConstraints.length; i++) {
    const c = candidateConstraints[i];
    if (c.operator !== first.operator) {
      return null;
    }
    if (c.value !== undefined && first.value !== undefined && c.value !== first.value) {
      return null;
    }
    if (c.unit !== undefined && first.unit !== undefined && c.unit !== first.unit) {
      return null;
    }
    if (c.kind !== first.kind) {
      return null;
    }
  }

  return first;
}

// ============================================================================
// 6. Multi-Condition Evaluator & Deterministic Decision (Gate 5)
// ============================================================================

/**
 * Evaluates whether a numeric user fact satisfies a boundary constraint.
 */
function evaluateNumericConstraint(
  userVal: number,
  operator: BoundaryOperator,
  targetVal: number
): boolean {
  switch (operator) {
    case '>':
      return userVal > targetVal;
    case '>=':
      return userVal >= targetVal;
    case '<':
      return userVal < targetVal;
    case '<=':
      return userVal <= targetVal;
  }
}

/**
 * Formats a clean human-readable representation of stated user facts.
 */
function formatUserFactsSummary(facts: UserFact[]): string {
  if (facts.length === 0) return 'stated information';
  return facts.map(f => f.raw).join(' and ');
}

/**
 * Formats a duration in minutes into a hyphenated window string (e.g. "2-hour", "14-day").
 */
function formatDurationWindow(minutes?: number): string {
  if (!minutes) return '';
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days}-day`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}-hour`;
  }
  return `${minutes}-minute`;
}

/**
 * Formats a clear, non-approving answer for conditional_met evaluations.
 * Explicitly states the satisfied measurable condition and identifies remaining unknown conditions.
 */
function formatConditionalMetAnswer(
  constraint: PolicyConstraint,
  _primaryFact: UserFact | undefined,
  primarySatisfied: boolean,
  unknownConditions: string[],
  matchedSecondaryFacts: UserFact[]
): string {
  if (constraint.operation === 'cancellation') {
    const windowLabel = formatDurationWindow(constraint.value);
    if (primarySatisfied && constraint.value !== undefined) {
      return `The order is within the ${windowLabel} cancellation window, but cancellation also requires that the order has not entered processing.`;
    }
    if (matchedSecondaryFacts.length > 0) {
      return `The order has not entered processing, but cancellation also requires that the order was placed within the ${windowLabel} cancellation window.`;
    }
  }

  if (constraint.operation === 'return_window') {
    const windowLabel = constraint.value !== undefined ? `${formatDurationWindow(constraint.value)} ` : '';
    if (primarySatisfied) {
      const pendingText = unknownConditions.length > 0
        ? unknownConditions.join(' and ')
        : 'the item is unused and in original packaging with all seals intact';
      return `The return request is within the ${windowLabel}return window, but return eligibility also requires that ${pendingText}.`;
    }
    if (matchedSecondaryFacts.length > 0) {
      const factDesc = matchedSecondaryFacts.map(f => f.raw).join(' and ');
      return `The item is stated as ${factDesc}, but return eligibility also requires that the request is made within the ${windowLabel}return window.`;
    }
  }

  if (constraint.operation === 'subscription_refund') {
    const windowLabel = constraint.value !== undefined ? `${formatDurationWindow(constraint.value)} ` : '';
    if (primarySatisfied) {
      return `The refund request is within the ${windowLabel}refund window, but subscription refunds also require that usage is under 1,000 API requests.`;
    }
  }

  const pendingText = unknownConditions.length > 0 ? unknownConditions.join(' and ') : 'all eligibility criteria are met';
  return `The stated information meets the measurable requirement, but ${constraint.operation} also requires that ${pendingText}.`;
}

/**
 * Evaluates policy grounding conservatively against whole-KB chunks.
 * Strict Confidence Gate:
 * USER_FACT_CONFIDENT && POLICY_CONSTRAINT_CONFIDENT && OPERATION_MATCH_CONFIDENT && NO_CONTRADICTORY_EVIDENCE
 * Anything else yields { status: 'indeterminate' }.
 */
export function evaluatePolicyGrounding(
  chunks: RetrievalResult[],
  message: string,
  _systemPrompt?: string
): PolicyEvaluation {
  // 1. Operation matching
  const operation = matchOperation(message);
  if (!operation) {
    return { status: 'indeterminate', reason: 'no_confident_operation_match' };
  }

  // 2. Policy constraint extraction from authoritative KB
  const constraint = extractPolicyConstraint(chunks, operation);
  if (!constraint) {
    return { status: 'indeterminate', reason: 'no_confident_policy_constraint' };
  }

  // 3. Explicit negative constraint handling (bypasses user-fact requirement)
  if (constraint.kind === 'explicit_negative') {
    const contact = resolveTrustedSupportContact(_systemPrompt, chunks);
    const contactClause = contact ? ` For confirmation, please contact ${contact}.` : '';
    const opLabel = constraint.operation.replace(/_/g, ' ');
    const boundedAnswer = `The knowledge base does not specify a ${opLabel}.${contactClause}`;
    return {
      status: 'explicit_negative',
      constraint,
      evidence: constraint.rawEvidence,
      boundedAnswer,
    };
  }

  // 4. User fact extraction from query
  const userFacts = extractUserFacts(message);
  if (userFacts.length === 0) {
    return { status: 'indeterminate', reason: 'no_concrete_user_facts' };
  }

  // Match applicable primary metric fact
  let primaryFact: UserFact | undefined;
  if (constraint.kind === 'maximum_window' || constraint.kind === 'minimum_advance') {
    primaryFact = userFacts.find(f => f.kind === 'duration');
  } else if (constraint.kind === 'minimum_threshold' || constraint.kind === 'maximum_threshold') {
    primaryFact = userFacts.find(f => f.kind === 'money' || f.kind === 'quantity');
  } else if (constraint.kind === 'required_state') {
    primaryFact = userFacts.find(f => f.kind === 'state');
  }

  // Verify currency or unit compatibility
  if (primaryFact && primaryFact.kind === 'money' && constraint.unit) {
    if (primaryFact.unit !== constraint.unit) {
      return { status: 'indeterminate', reason: 'currency_unit_mismatch' };
    }
  }
  if (primaryFact && primaryFact.kind === 'quantity' && constraint.unit) {
    if (primaryFact.unit !== constraint.unit) {
      return { status: 'indeterminate', reason: 'quantity_unit_mismatch' };
    }
  }

  // Multi-condition evaluation flags
  let primaryViolated = false;
  let primarySatisfied = false;
  let primaryUnknown = false;

  if (primaryFact && constraint.value !== undefined && typeof primaryFact.value === 'number') {
    const passed = evaluateNumericConstraint(primaryFact.value, constraint.operator, constraint.value);
    if (passed) {
      primarySatisfied = true;
    } else {
      primaryViolated = true;
    }
  } else if (constraint.value !== undefined && !primaryFact) {
    primaryUnknown = true;
  } else if (constraint.kind === 'required_state') {
    primarySatisfied = true;
  }

  // Evaluate secondary conditions
  const secondaryList = constraint.secondaryConditions || [];
  let anySecondaryViolated = false;
  const unknownConditions: string[] = [];
  const matchedSecondaryFacts: UserFact[] = [];

  for (const sec of secondaryList) {
    const userState = userFacts.find(f => f.kind === 'state' && f.value === sec.stateKey);
    if (userState) {
      matchedSecondaryFacts.push(userState);
      if (userState.polarity === sec.requiredPolarity) {
        // Satisfied
      } else {
        anySecondaryViolated = true;
      }
    } else {
      unknownConditions.push(sec.description);
    }
  }

  // Select the most concise evidence sentence
  let evidence = constraint.rawEvidence.trim();
  evidence = evidence
    .replace(/^#+\s*[^\n]*\n+/g, '')
    .replace(/^[A-Z][a-zA-Z\s]{0,30}\n+/g, '')
    .replace(/[*_~`]/g, '')
    .trim();
  const sentences = evidence.split(/(?<=[.?!])\s+/);
  if (sentences.length > 1) {
    // If violation is due to a state requirement, pick the sentence specifying that state
    if (anySecondaryViolated) {
      const stateSentence = sentences.find(s => /\b(?:unused|unopened|processing)\b/i.test(s));
      if (stateSentence) evidence = stateSentence.trim();
    } else {
      evidence = sentences[0].trim();
    }
  }
  if (!/[.?!]$/.test(evidence)) {
    evidence += '.';
  }

  const allStatedFacts = [
    ...(primaryFact ? [primaryFact] : []),
    ...matchedSecondaryFacts,
  ];
  const factDesc = formatUserFactsSummary(allStatedFacts);

  // --- Rule 1: ANY required condition definitely violated -> VIOLATED ---
  if (primaryViolated || anySecondaryViolated) {
    const boundedAnswer = `${evidence} Based on the stated ${factDesc}, the request does not meet this requirement.`;
    return {
      status: 'violated',
      constraint,
      userFact: primaryFact || matchedSecondaryFacts[0],
      evidence,
      boundedAnswer,
    };
  }

  // --- Rule 2: ALL required conditions definitely satisfied -> SATISFIED ---
  if (primarySatisfied && !primaryUnknown && unknownConditions.length === 0) {
    const boundedAnswer = `${evidence} Based on the stated ${factDesc}, the request meets this requirement.`;
    return {
      status: 'satisfied',
      constraint,
      userFact: primaryFact || matchedSecondaryFacts[0],
      evidence,
      boundedAnswer,
    };
  }

  // --- Rule 3: NO violation, but one or more required conditions unknown -> CONDITIONAL_MET ---
  if (!primaryViolated && !anySecondaryViolated && (primaryUnknown || unknownConditions.length > 0)) {
    const boundedAnswer = formatConditionalMetAnswer(
      constraint,
      primaryFact,
      primarySatisfied,
      unknownConditions,
      matchedSecondaryFacts
    );
    return {
      status: 'conditional_met',
      constraint,
      userFact: primaryFact || matchedSecondaryFacts[0],
      evidence,
      boundedAnswer,
    };
  }

  // If indeterminate
  return { status: 'indeterminate', reason: 'unresolved_condition_matrix' };
}
