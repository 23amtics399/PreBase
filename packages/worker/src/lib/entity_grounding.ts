import type { D1Database } from '@cloudflare/workers-types';
import type { RetrievalResult } from './retrieval';

export type EntityEvidenceState =
  | 'confirmed'
  | 'explicitly_excluded'
  | 'conflicting'
  | 'insufficient_context'
  | 'mentioned_only'
  | 'absent'
  | 'none';

export interface CandidateEntity {
  name: string;
  normalized: string;
  sourcePattern: string;
}

export interface EntityGroundingCheckResult {
  hasCandidateEntity: boolean;
  candidateEntity: string | null;
  groundingState: EntityEvidenceState;
  recoveredFromFullKb: boolean;
  action: 'proceed_to_ai' | 'intercepted';
  boundedResponse?: string;
  evidenceChunk?: RetrievalResult;
}

/**
 * Common generic category terms that describe domains, workflows, or services
 * rather than specific individual entities, destinations, or products.
 * An inquiry targeting only these terms is a general category query and must
 * not be treated as a specific entity query.
 */
const GENERIC_CATEGORY_TERMS = new Set([
  // Shipping & logistics
  'international',
  'internationally',
  'shipping',
  'delivery',
  'packages',
  'package',
  'parcel',
  'parcels',
  'orders',
  'order',
  'transit',
  'freight',
  'customs',

  // Banking & fintech
  'wires',
  'wire',
  'wire transfers',
  'wire transfer',
  'transfers',
  'transfer',
  'withdrawals',
  'withdrawal',
  'deposits',
  'deposit',
  'atm',
  'accounts',
  'account',
  'fees',
  'fee',
  'transactions',
  'transaction',
  'statements',
  'statement',
  'disputes',
  'dispute',
  'savings',
  'checking',

  // Payment methods & instruments
  'cards',
  'card',
  'credit card',
  'credit cards',
  'debit card',
  'debit cards',
  'payment',
  'payments',
  'payment method',
  'payment methods',
  'payment option',
  'payment options',
  'payment methods and cards',

  // Healthcare & telehealth
  'health',
  'insurance',
  'health insurance',
  'in-network',
  'out-of-network',
  'coverage',
  'consultations',
  'consultation',
  'appointments',
  'appointment',
  'doctors',
  'doctor',
  'physicians',
  'physician',
  'prescriptions',
  'prescription',
  'refills',
  'refill',
  'medications',
  'medication',
  'drugs',
  'drug',
  'primary care',
  'telehealth',
  'virtual',
  'clinic',

  // SaaS & developer platforms
  'support',
  'customer support',
  'technical support',
  'tiers',
  'tier',
  'plans',
  'plan',
  'pricing',
  'uptime',
  'sla',
  'slas',
  'api requests',
  'api request',
  'requests',
  'request',
  'rate limits',
  'rate limit',
  'limits',
  'limit',
  'subscriptions',
  'subscription',
  'refunds',
  'refund',
  'cancellations',
  'cancellation',
  'platform',
  'cloud',

  // General business & reference
  'volume discounts',
  'volume discount',
  'discounts',
  'discount',
  'policy',
  'policies',
  'rules',
  'rule',
  'help',
  'contact',
  'information',
  'service',
  'services',
  'products',
  'product',
  'items',
  'item',
  'terms',
  'conditions',
]);

const PRONOUNS = new Set([
  'it', 'this', 'that', 'these', 'those', 'they', 'them', 'he', 'she', 'we', 'you', 'i', 'me', 'us',
  'anything', 'everything', 'something', 'nothing', 'anyone', 'everyone', 'someone',
  'none', 'all', 'any', 'some', 'each', 'every', 'both', 'either', 'neither', 'one', 'ones',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how'
]);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cleans and normalizes candidate entity string.
 * Strips leading/trailing articles, prepositions, and generic category noise suffixes.
 */
function cleanEntityString(raw: string): string {
  let s = raw.trim().replace(/^[\s,.;:?!"'()]+|[\s,.;:?!"'()]+$/g, '');

  // Strip leading articles / prepositions
  s = s.replace(/^(?:the|a|an|to|in|for|from|with|specifically to|specifically in|specifically for|specifically)\s+/i, '');

  // Strip trailing generic category words ONLY if preceded by other words
  s = s.replace(/(?<=\S\s+)(?:cards?|payments?|methods?|options?|accounts?|compliance reports?|reports?|compliance|health insurance|insurance|destination|destinations|country|countries|provider|providers|plan|plans|tier)$/i, '');

  return s.trim();
}

/**
 * Extracts candidate entities from user query using conservative, high-precision patterns.
 * Explicitly rejects queries that ask about general category concepts directly.
 */
export function extractCandidateEntities(message: string): CandidateEntity[] {
  const candidates: CandidateEntity[] = [];
  const normalizedMsg = message.trim();

  // Pattern 1: Targeted qualification ("specifically to Argentina", "available for Japan")
  const p1 = /\b(?:specifically|available)\s+(?:to|in|for|with|from)?\s*([a-zA-Z0-9\s.-]+?)(?:\?|$|\.|\busing\b|\bvia\b|\bon\b|\bfor\b|\bvirtually\b|\bonline\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = p1.exec(normalizedMsg)) !== null) {
    const cleaned = cleanEntityString(m[1]);
    const lower = cleaned.toLowerCase();
    if (cleaned && cleaned.length >= 2 && !GENERIC_CATEGORY_TERMS.has(lower) && !PRONOUNS.has(lower)) {
      candidates.push({ name: cleaned, normalized: lower, sourcePattern: 'specifically_prep' });
    }
  }

  // Pattern 2: Membership / qualification questions ("Is Cigna in-network?", "Is Argentina supported?")
  const p2 = /\b(?:is|are)\s+([a-zA-Z0-9\s.-]+?)\s+(?:in-network|covered|supported|accepted|eligible|included|allowed|available)\b/gi;
  while ((m = p2.exec(normalizedMsg)) !== null) {
    const cleaned = cleanEntityString(m[1]);
    const lower = cleaned.toLowerCase();
    if (cleaned && cleaned.length >= 2 && !GENERIC_CATEGORY_TERMS.has(lower) && !PRONOUNS.has(lower)) {
      candidates.push({ name: cleaned, normalized: lower, sourcePattern: 'is_category_membership' });
    }
  }

  // Pattern 3: Capability / Service interrogatives ("Do you ship to Germany?", "Can CarePoint doctors prescribe Adderall virtually?")
  const p3 = /\b(?:do you|can you|can I|can we|does it|does [a-zA-Z0-9_-]+|can [a-zA-Z0-9_-]+(?:\s+(?:doctors|physicians|team|staff|support))?)\s+(?:ship to|ship specifically to|send an international wire to|send a wire to|send to|wire to|prescribe|accept|cover|support|offer|include|provide|get|pay using|pay with)\s+([a-zA-Z0-9\s.-]+?)(?:\?|$|\.|\bif\b|\bwhen\b|\bafter\b|\bbefore\b|\bunless\b|\bwhile\b|\busing\b|\bvia\b|\bon\b|\bfor\b|\bfrom\b|\bwith\b|\bvirtually\b|\bonline\b)/gi;
  while ((m = p3.exec(normalizedMsg)) !== null) {
    const cleaned = cleanEntityString(m[1]);
    const lower = cleaned.toLowerCase();
    if (cleaned && cleaned.length >= 2 && !GENERIC_CATEGORY_TERMS.has(lower) && !PRONOUNS.has(lower)) {
      candidates.push({ name: cleaned, normalized: lower, sourcePattern: 'capability_action' });
    }
  }

  // Pattern 4: Feature-specific offerings ("Does DevCloud offer dedicated phone support?")
  const p4 = /\b(?:offer|provide|have)\s+([a-zA-Z0-9\s.-]+?)\s+(?:for|on|with|to)\s+(?:team|enterprise|free|personal|business)\b/gi;
  while ((m = p4.exec(normalizedMsg)) !== null) {
    const cleaned = cleanEntityString(m[1]);
    const lower = cleaned.toLowerCase();
    if (cleaned && cleaned.length >= 2 && !GENERIC_CATEGORY_TERMS.has(lower) && !PRONOUNS.has(lower)) {
      candidates.push({ name: cleaned, normalized: lower, sourcePattern: 'feature_tier_offering' });
    }
  }

  // Pattern 5: User presupposition claims ("Since Australia is an approved shipping destination...", "Since Cigna is in-network...")
  const p5 = /\b(?:since|now that|given that)\s+([a-zA-Z0-9\s.-]+?)\s+(?:is|are|has been|have been)\s+(?:an?\s+)?(?:approved|confirmed|active|supported|in-network|available)\b/gi;
  while ((m = p5.exec(normalizedMsg)) !== null) {
    const cleaned = cleanEntityString(m[1]);
    const lower = cleaned.toLowerCase();
    if (cleaned && cleaned.length >= 2 && !GENERIC_CATEGORY_TERMS.has(lower) && !PRONOUNS.has(lower)) {
      candidates.push({ name: cleaned, normalized: lower, sourcePattern: 'user_presupposition' });
    }
  }

  // Deduplicate by normalized name
  const uniqueMap = new Map<string, CandidateEntity>();
  for (const c of candidates) {
    if (!uniqueMap.has(c.normalized)) {
      uniqueMap.set(c.normalized, c);
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Searches the full authoritative bot knowledge base in D1 for exact occurrences
 * of an entity that may have been missed during initial query-based retrieval.
 * Strictly scoped to bot_id and requires BM25 score <= minBm25.
 */
export async function searchFullBotKbForEntity(
  db: D1Database,
  botId: string,
  entity: string,
  minBm25: number,
  limit: number = 3
): Promise<RetrievalResult[]> {
  const cleaned = cleanEntityString(entity);
  if (!cleaned || cleaned.length < 2) {
    return [];
  }

  if (!db || typeof db.prepare !== 'function') {
    return [];
  }

  // Format exact phrase FTS5 MATCH expression
  const safeEntity = cleaned.replace(/["*^~]/g, ' ').trim();
  const ftsQuery = `"${safeEntity.replace(/"/g, '""')}"`;

  try {
    const { results } = await db
      .prepare(
        `SELECT
           kc.content,
           kc.chunk_index  AS chunkIndex,
           ks.filename     AS sourceFilename,
           bm25(kb_fts)    AS score
         FROM kb_fts
         JOIN kb_chunks  kc ON kc.id = kb_fts.rowid
         JOIN kb_sources ks ON ks.id = kc.source_id
         WHERE kb_fts MATCH ?
           AND kb_fts.bot_id = ?
         ORDER BY score ASC
         LIMIT ?`
      )
      .bind(ftsQuery, botId, limit)
      .all<{ content: string; chunkIndex: number; sourceFilename: string; score: number }>();

    if (!results || results.length === 0) {
      return [];
    }

    // Verify whole-word boundary in JavaScript and respect BM25 relevance threshold
    const wordBoundaryRegex = new RegExp(`\\b${escapeRegex(cleaned)}\\b`, 'i');
    const matched: RetrievalResult[] = [];

    for (const r of results) {
      if (r.score <= minBm25 && wordBoundaryRegex.test(r.content)) {
        matched.push({
          content: r.content,
          score: r.score,
          sourceFilename: r.sourceFilename,
          chunkIndex: r.chunkIndex,
        });
      }
    }

    return matched;
  } catch (err) {
    console.error(`[entity_grounding] Full-KB search failed for bot ${botId}, entity "${entity}":`, err);
    return [];
  }
}

/**
 * Checks if the entity is present in any of the provided chunks using strict word boundaries.
 */
export function findEntityInChunks(
  entity: string,
  chunks: RetrievalResult[]
): { found: boolean; matchingChunk?: RetrievalResult } {
  const cleaned = cleanEntityString(entity);
  if (!cleaned) return { found: false };

  const regex = new RegExp(`\\b${escapeRegex(cleaned)}\\b`, 'i');
  for (const c of chunks) {
    if (regex.test(c.content)) {
      return { found: true, matchingChunk: c };
    }
  }

  // Conservative morphological plural/singular check
  let variant: string | null = null;
  if (/ies$/i.test(cleaned)) {
    variant = cleaned.replace(/ies$/i, 'y');
  } else if (/es$/i.test(cleaned) && cleaned.length > 4) {
    variant = cleaned.replace(/es$/i, '');
  } else if (/s$/i.test(cleaned) && !/ss$/i.test(cleaned) && cleaned.length > 3) {
    variant = cleaned.replace(/s$/i, '');
  }

  if (variant) {
    const variantRegex = new RegExp(`\\b${escapeRegex(variant)}\\b`, 'i');
    for (const c of chunks) {
      if (variantRegex.test(c.content)) {
        return { found: true, matchingChunk: c };
      }
    }
  }

  return { found: false };
}

/**
 * Evaluates the 6-state evidence priority for an entity across all available authoritative chunks:
 * 1. conflicting (positive AND negative evidence found across chunks or within chunk)
 * 2. explicitly_excluded (prohibition/denial without positive evidence)
 * 3. confirmed (affirmative support/in-network list without negative evidence)
 * 4. insufficient_context (conditional, plan-dependent, or ambiguous context)
 * 5. mentioned_only (mentioned without support or exclusion context)
 * 6. absent (entity does not appear in any chunk)
 */
export function evaluateEntityGroundingState(
  entity: string,
  presence: { found: boolean; matchingChunk?: RetrievalResult },
  allChunks: RetrievalResult[]
): { state: EntityEvidenceState; matchingChunk?: RetrievalResult; detail?: string } {
  if (!presence.found) {
    return { state: 'absent' };
  }

  const cleaned = cleanEntityString(entity);
  const variantRegex = /s$/i.test(cleaned) && !/ss$/i.test(cleaned)
    ? new RegExp(`\\b(?:${escapeRegex(cleaned)}|${escapeRegex(cleaned.replace(/s$/i, ''))})\\b`, 'i')
    : new RegExp(`\\b(?:${escapeRegex(cleaned)}|${escapeRegex(cleaned)}s)\\b`, 'i');

  // Filter chunks that actually contain the entity or its conservative variant
  const entityChunks = allChunks.filter(c => variantRegex.test(c.content));
  if (entityChunks.length === 0) {
    return { state: 'absent' };
  }

  let hasPositiveEvidence = false;
  let hasNegativeEvidence = false;
  let hasInsufficientContext = false;
  let representativeChunk = entityChunks[0];

  // Regex patterns for positive confirmation
  // Negative lookahead ensures no negation occurs between the affirmative trigger and the entity
  const positivePatterns = [
    new RegExp(`\\b(?:in-network with|accept|accepted|accepts|participating with|covered by|providers include|destinations include|supported(?: destinations| countries| regions| platforms)? include|we ship to|ships to|(?<!(?:not|never|neither|nor|cannot|can't|don't|do not)\\s+)ship to|available in|available to|available as|supports|(?:plans?|tiers?|platforms?|features?)\\s+support|includes|include|provides|provide|offers|offer)\\b(?:(?!\\b(?:not|never|neither|nor|except|excluding|unavailable|unsupported|prohibited)\\b)(?![.?!](?:\\s+|$))[^\n])*?\\b${escapeRegex(cleaned)}\\b`, 'i'),
    new RegExp(`\\b${escapeRegex(cleaned)}\\b(?:(?!\\b(?:not|never|neither|nor|except|excluding|unavailable|unsupported|prohibited)\\b)(?![.?!](?:\\s+|$))[^\n])*?\\b(?:is supported|are supported|is included|are included|is eligible|is in-network|are in-network|is covered|are covered|is available|are available|is accepted|are accepted)\\b`, 'i'),
    new RegExp(`\\b(?:accept|accepted|accepts|support|supported|supports|include|includes|offer|offers|available|payment methods?)\\b[^\n.?!]*?:?\\s*(?:\\n\\s*[-*•]\\s*[^\n]+)*?\\n\\s*[-*•]\\s*${escapeRegex(cleaned)}\\b`, 'i'),
  ];

  // Regex patterns for explicit exclusion / prohibition
  const negativePatterns = [
    new RegExp(`\\b(?:do not|don't|cannot|can't|does not|doesn't|never|not|no|excluding|exclude|excludes|excluded|except|without|unavailable|unsupported|prohibited|prohibit)\\b[^\n.?!]*?\\b${escapeRegex(cleaned)}\\b`, 'i'),
    new RegExp(`\\b${escapeRegex(cleaned)}\\b[^\n.?!]*?\\b(?:is not|are not|cannot|not supported|not currently supported|not available|currently unavailable|not covered|excluded|prohibited|not eligible|unsupported|unavailable|is unavailable|are unavailable)\\b`, 'i'),
  ];

  // Regex patterns for conditional / ambiguous context
  const ambiguousPatterns = [
    new RegExp(`\\b(?:depends on|subject to|inquire about|contact support regarding|eligibility depends)\\b[^\n.?!]*?\\b${escapeRegex(cleaned)}\\b`, 'i'),
    new RegExp(`\\b${escapeRegex(cleaned)}\\b[^\n.?!]*?\\b(?:depends on|subject to restrictions|requires manual review)\\b`, 'i'),
  ];

  for (const chunk of entityChunks) {
    const text = chunk.content;

    // Check positive
    if (positivePatterns.some(p => p.test(text))) {
      hasPositiveEvidence = true;
      representativeChunk = chunk;
    }

    // Check negative
    if (negativePatterns.some(p => p.test(text))) {
      hasNegativeEvidence = true;
      representativeChunk = chunk;
    }

    // Check ambiguous
    if (ambiguousPatterns.some(p => p.test(text))) {
      hasInsufficientContext = true;
      representativeChunk = chunk;
    }
  }

  // Precedence 1: Contradiction
  if (hasPositiveEvidence && hasNegativeEvidence) {
    return {
      state: 'conflicting',
      matchingChunk: representativeChunk,
      detail: 'Knowledge base contains conflicting statements regarding support.',
    };
  }

  // Precedence 2: Explicit exclusion
  if (hasNegativeEvidence && !hasPositiveEvidence) {
    return {
      state: 'explicitly_excluded',
      matchingChunk: representativeChunk,
      detail: 'Authoritative knowledge base explicitly excludes or prohibits this entity.',
    };
  }

  // Precedence 3: Explicit confirmation
  if (hasPositiveEvidence && !hasNegativeEvidence) {
    return {
      state: 'confirmed',
      matchingChunk: representativeChunk,
      detail: 'Authoritative knowledge base explicitly confirms support for this entity.',
    };
  }

  // Precedence 4: Insufficient context
  if (hasInsufficientContext) {
    return {
      state: 'insufficient_context',
      matchingChunk: representativeChunk,
      detail: 'Eligibility or support is conditional or ambiguous in the knowledge base.',
    };
  }

  // Precedence 5: Mentioned only
  return {
    state: 'mentioned_only',
    matchingChunk: representativeChunk,
    detail: 'Entity is mentioned in the knowledge base, but support or eligibility is not established.',
  };
}

/**
 * Resolves a trusted support contact following a strict precedence hierarchy:
 * 1. Validated email or HTTPS URL explicitly declared in <BOT_OWNER_INSTRUCTIONS> (T1)
 * 2. Validated contact present in an authoritative KB chunk
 * 3. undefined (never guesses or invents an email)
 */
export function resolveTrustedSupportContact(
  systemPrompt?: string,
  chunks?: RetrievalResult[]
): string | undefined {
  const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
  const URL_REGEX = /\bhttps?:\/\/[^\s"'<>)]+\b/;

  // Precedence 1: System prompt (Bot owner instructions)
  if (systemPrompt) {
    const emailMatch = systemPrompt.match(EMAIL_REGEX);
    if (emailMatch) return emailMatch[0];

    const urlMatch = systemPrompt.match(URL_REGEX);
    if (urlMatch) return urlMatch[0];
  }

  // Precedence 2: Authoritative KB chunks
  if (chunks && chunks.length > 0) {
    for (const chunk of chunks) {
      const emailMatch = chunk.content.match(EMAIL_REGEX);
      if (emailMatch) return emailMatch[0];

      const urlMatch = chunk.content.match(URL_REGEX);
      if (urlMatch) return urlMatch[0];
    }
  }

  return undefined;
}

/**
 * Extracts an authoritative governing policy sentence from retrieved chunks
 * that is demonstrably and semantically relevant to both the candidate entity
 * and the user's requested operation.
 *
 * Rejects questions, section headers, exclusion lists, and unrelated content.
 * Returns null if no governing policy sentence meets both criteria.
 */
export function extractGoverningPolicySentence(
  content: string,
  entity: string,
  userMessage?: string
): string | null {
  if (!content || !content.trim()) return null;

  // Reject pure exclusion sections immediately
  if (/^\s*#*\s*(?:what is not covered|not covered|exclusions?|exceptions?|things we don't cover)\b/i.test(content)) {
    return null;
  }

  // Split content into paragraphs first to preserve coherent multi-sentence policy blocks
  const paragraphs = content.split(/\r?\n\s*\r?\n/);
  const cleanCandidates: string[] = [];

  for (const para of paragraphs) {
    const lines = para.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const contentLines: string[] = [];

    for (let line of lines) {
      // Strip markdown formatting: leading headers, blockquotes, bullets, and numbering
      const cleanLine = line.replace(/^[\s#>\-*•\d.)]+/g, '').trim().replace(/[*_~`]/g, '').trim();

      if (cleanLine.length < 15) continue;

      // Reject questions (ends with '?' or starts with question interrogatives)
      if (cleanLine.endsWith('?') || /^(?:is|can|do|does|how|what|where|when|why|who|q:)\b/i.test(cleanLine)) {
        continue;
      }

      // Reject structural headings or metadata labels
      if (/^(?:information not covered|frequently asked questions|about us|contact details|payment methods|support and security|test cases|privacy|orders|returns|shipping|payment|warranty)\b/i.test(cleanLine)) {
        continue;
      }

      // Reject negative exclusion lists or disclaimers
      if (/\b(?:does not specify|not specify|does not cover|not covered|not claim|never ask|not require)\b/i.test(cleanLine)) {
        continue;
      }

      // Reject noun-phrase fragments lacking a predicate/verb
      if (!/\b(?:is|are|was|were|be|been|have|has|had|do|does|did|will|would|can|could|may|might|must|should|takes?|applies|apply|offers?|includes?|ships?|accepts?|requires?|delivers?|provides?)\b/i.test(cleanLine)) {
        continue;
      }

      contentLines.push(cleanLine);
    }

    if (contentLines.length === 0) continue;

    let block = contentLines.join(' ');
    if (!/[.]$/.test(block)) {
      block = block + '.';
    }

    if (block.length >= 20) {
      cleanCandidates.push(block);
    }
  }

  if (cleanCandidates.length === 0) return null;

  const combinedContext = `${entity} ${userMessage ?? ''}`.toLowerCase();

  // Domain triggers
  const isShipping = /\b(?:ship|shipping|delivery|deliver|delivers|internationally|international|destination|destinations|countries|country|germany|france|japan|argentina|brazil|uk|australia)\b/i.test(combinedContext);
  const isPayment = /\b(?:pay|payment|payments|methods?|accept|accepts|cards?|rupay|visa|mastercard|wire|transfers?|bank|banking)\b/i.test(combinedContext);
  const isHealth = /\b(?:prescribe|prescription|telehealth|virtual|doctor|physician|in-network|insurance|coverage|adderall|ambien|ozempic|cigna|aetna)\b/i.test(combinedContext);
  const isDiscount = /\b(?:discount|discounts|student)\b/i.test(combinedContext);
  const isReturn = /\b(?:return|returns|refund|refunds|cancellation|cancellations)\b/i.test(combinedContext);

  for (const cand of cleanCandidates) {
    if (isShipping && /\b(?:ship|shipping|delivery|deliver|delivers|destinations?|countries|international(?:ly)?|transit)\b/i.test(cand)) {
      return cand;
    }
    if (isPayment && /\b(?:pay|payment|payments|methods|accept|accepts|accepted|cards?|currencies|bank)\b/i.test(cand)) {
      return cand;
    }
    if (isHealth && /\b(?:prescribe|prescriptions?|telehealth|virtual|doctor|physician|in-network|insurance|coverage)\b/i.test(cand)) {
      return cand;
    }
    if (isDiscount && /\b(?:discounts?|coupons?|promo(?:tion)?s?)\b/i.test(cand)) {
      return cand;
    }
    if (isReturn && /\b(?:returns?|refunds?|cancellations?|resalable|packaging)\b/i.test(cand)) {
      return cand;
    }
  }

  return null;
}

/**
 * Builds a deterministic, bounded response for unconfirmed, conflicting, or absent entities
 * without calling Granite, completely eliminating hallucinated support.
 */
export function buildBoundedUnconfirmedResponse(
  categoryChunkContent: string,
  entity: string,
  state: EntityEvidenceState,
  supportContact?: string,
  userMessage?: string
): string {
  const contactSuffix = supportContact
    ? `For confirmation, please contact ${supportContact}.`
    : 'For confirmation, please contact customer support.';

  if (state === 'conflicting') {
    return `The knowledge base contains conflicting information regarding whether ${entity} is supported. ${contactSuffix}`;
  }

  if (state === 'insufficient_context') {
    return `The knowledge base indicates that eligibility for ${entity} depends on specific conditions or account requirements that are not confirmed. ${contactSuffix}`;
  }

  if (state === 'mentioned_only') {
    return `While ${entity} is mentioned in our documentation, the knowledge base does not confirm that it is currently supported. ${contactSuffix}`;
  }

  // Default: absent
  const governingSentence = extractGoverningPolicySentence(categoryChunkContent, entity, userMessage);

  if (governingSentence) {
    return `${governingSentence} However, the knowledge base does not specify whether ${entity} is included or supported. ${contactSuffix}`;
  }

  // Pure non-mention fallback without quoting unrelated chunks
  const cleanEntity = entity.trim();
  const formattedEntity = /^(?:a|an|the)\s+/i.test(cleanEntity) || /s$/i.test(cleanEntity)
    ? cleanEntity
    : `a ${cleanEntity}`;

  return `The knowledge base does not mention ${formattedEntity}, and does not specify whether it is included or supported. ${contactSuffix}`;
}

/**
 * Merges a recovered full-KB chunk into the retrieved context while respecting
 * the character budget and deduplicating by sourceFilename:chunkIndex.
 *
 * Implements a deterministic ranking strategy:
 * - If everything fits within budget, initial chunks are kept in order, followed by recovered chunks.
 * - If budget is exceeded, the top initial chunk is unconditionally preserved, and remaining
 *   initial and recovered chunks compete strictly by BM25 score (more negative = stronger).
 * - Recovered chunks cannot indiscriminately crowd out higher-ranked initial chunks.
 */
export function mergeRecoveredChunks(
  initialChunks: RetrievalResult[],
  recoveredChunks: RetrievalResult[],
  charBudget: number
): RetrievalResult[] {
  if (initialChunks.length === 0) {
    return recoveredChunks.filter(c => c.content.length <= charBudget);
  }

  const topChunk = initialChunks[0];
  const uniqueCandidates = new Map<string, RetrievalResult>();
  uniqueCandidates.set(`${topChunk.sourceFilename}:${topChunk.chunkIndex}`, topChunk);

  for (const c of initialChunks.slice(1)) {
    uniqueCandidates.set(`${c.sourceFilename}:${c.chunkIndex}`, c);
  }
  for (const c of recoveredChunks) {
    const key = `${c.sourceFilename}:${c.chunkIndex}`;
    if (!uniqueCandidates.has(key)) {
      uniqueCandidates.set(key, c);
    }
  }

  // If all fit within budget, retain initial chunks in order, then recovered chunks
  const allList: RetrievalResult[] = [...initialChunks];
  for (const rc of recoveredChunks) {
    if (!allList.some(c => c.sourceFilename === rc.sourceFilename && c.chunkIndex === rc.chunkIndex)) {
      allList.push(rc);
    }
  }
  const totalChars = allList.reduce((acc, c) => acc + c.content.length, 0);
  if (totalChars <= charBudget) {
    return allList;
  }

  // Budget exceeded: topChunk is unconditionally preserved
  const selected: RetrievalResult[] = [topChunk];
  let usedChars = topChunk.content.length;

  // Remaining candidates compete strictly by BM25 score ASC (more negative = stronger)
  const remaining = Array.from(uniqueCandidates.values())
    .filter(c => !(c.sourceFilename === topChunk.sourceFilename && c.chunkIndex === topChunk.chunkIndex))
    .sort((a, b) => a.score - b.score);

  for (const cand of remaining) {
    if (usedChars + cand.content.length <= charBudget) {
      selected.push(cand);
      usedChars += cand.content.length;
    }
  }

  return selected;
}
