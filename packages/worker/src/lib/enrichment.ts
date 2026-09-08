export type EnrichmentMessage = {
  version: number;
  chunkId: number;
  botId: string;
  sourceId: number;
};

export type EnrichmentResult = {
  questions: string[];
  aliases: string[];
  keywords: string[];
  topics: string[];
  entities: string[];
  negative_constraints: string[];
};

/**
 * Calls the Gemini API using structured JSON output to extract metadata
 * for a specific knowledge base chunk.
 * 
 * We enforce a strict JSON schema via responseSchema.
 */
export async function enrichChunk(
  apiKey: string,
  model: string,
  content: string
): Promise<EnrichmentResult | null> {
  if (!apiKey) {
    console.error('[Enrichment] Missing GEMINI_API_KEY');
    return null;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Structured output schema
  const schema = {
    type: "OBJECT",
    properties: {
      questions: {
        type: "ARRAY",
        description: "List of possible user questions this text answers.",
        items: { type: "STRING" }
      },
      aliases: {
        type: "ARRAY",
        description: "Alternative names, abbreviations, or acronyms found in the text.",
        items: { type: "STRING" }
      },
      keywords: {
        type: "ARRAY",
        description: "Key terms and specific identifiers from the text.",
        items: { type: "STRING" }
      },
      topics: {
        type: "ARRAY",
        description: "High-level themes or categories.",
        items: { type: "STRING" }
      },
      entities: {
        type: "ARRAY",
        description: "Names of people, organizations, places, or products.",
        items: { type: "STRING" }
      },
      negative_constraints: {
        type: "ARRAY",
        description: "Things the text explicitly says it does NOT do, or exceptions to rules.",
        items: { type: "STRING" }
      }
    },
    required: ["questions", "aliases", "keywords", "topics", "entities", "negative_constraints"]
  };

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Analyze the following text and extract metadata for search indexing. DO NOT summarize the text. Only extract the structured data requested.\n\nText:\n" + content
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1, // Low temperature for deterministic extraction
      responseMimeType: "application/json",
      responseSchema: schema
    }
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Enrichment] Gemini API error: ${res.status} ${errorText}`);
      if (res.status === 404) {
        try {
          const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
          const listText = await listRes.text();
          console.error(`[Enrichment] Available models: ${listText}`);
        } catch (e) {
          console.error(`[Enrichment] Failed to list models:`, e);
        }
      }
      return null;
    }

    const data = await res.json() as any;
    
    // Safely extract the JSON from the Gemini response
    const candidate = data.candidates?.[0];
    if (!candidate || !candidate.content || !candidate.content.parts || !candidate.content.parts[0].text) {
      console.error('[Enrichment] Unexpected Gemini response format:', JSON.stringify(data));
      return null;
    }

    const jsonText = candidate.content.parts[0].text;
    const parsed = JSON.parse(jsonText) as EnrichmentResult;

    // Ensure all arrays exist even if Gemini omitted them or returned null
    return {
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      negative_constraints: Array.isArray(parsed.negative_constraints) ? parsed.negative_constraints : [],
    };
  } catch (err) {
    console.error('[Enrichment] Exception during enrichment API call:', err);
    return null;
  }
}

import type { Message } from '@cloudflare/workers-types';

export async function handleEnrichmentBatch(
  messages: readonly Message<EnrichmentMessage>[],
  env: { DB: any; GEMINI_API_KEY: string; PREBASE_GEMINI_MODEL: string; PREBASE_ENRICH_MAX_RETRIES: string }
) {
  const model = env.PREBASE_GEMINI_MODEL || 'gemini-1.5-flash-8b';
  const maxRetries = parseInt(env.PREBASE_ENRICH_MAX_RETRIES || '3', 10);
  
  for (const queueMsg of messages) {
    const msg = queueMsg.body;
    let result: EnrichmentResult | null = null;
    let attempt = 0;
    
    // Mark source as processing if it is currently queued
    await env.DB.prepare(
      `UPDATE kb_sources SET enrichment_status = 'processing' WHERE id = ? AND enrichment_status = 'queued'`
    ).bind(msg.sourceId).run();

    // Retrieve the original authoritative content from D1
    const chunkRecord = await env.DB.prepare(
      `SELECT content FROM kb_chunks WHERE id = ? AND bot_id = ? AND source_id = ?`
    ).bind(msg.chunkId, msg.botId, msg.sourceId).first() as { content: string } | null;

    if (!chunkRecord || !chunkRecord.content) {
      console.error(`[Enrichment] Failed to retrieve content for chunk ${msg.chunkId}.`);
      continue; // Skip this message, it's a dead letter or source was deleted
    }

    const chunkContent = chunkRecord.content;

    while (attempt < maxRetries && !result) {
      attempt++;
      result = await enrichChunk(env.GEMINI_API_KEY, model, chunkContent);
      if (!result && attempt < maxRetries) {
        // Simple exponential backoff
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }

    if (result) {
      // Upsert the enrichment results into the DB
      try {
        await env.DB.prepare(
          `INSERT INTO knowledge_enrichment (
            chunk_id, questions, aliases, keywords, topics, entities, negative_constraints, model, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(chunk_id) DO UPDATE SET
            questions=excluded.questions,
            aliases=excluded.aliases,
            keywords=excluded.keywords,
            topics=excluded.topics,
            entities=excluded.entities,
            negative_constraints=excluded.negative_constraints,
            model=excluded.model,
            updated_at=excluded.updated_at`
        ).bind(
          msg.chunkId,
          JSON.stringify(result.questions),
          JSON.stringify(result.aliases),
          JSON.stringify(result.keywords),
          JSON.stringify(result.topics),
          JSON.stringify(result.entities),
          JSON.stringify(result.negative_constraints),
          model,
          Date.now(),
          Date.now()
        ).run();

        // Check if all chunks for this source are now enriched. If so, mark as completed.
        await env.DB.prepare(`
          UPDATE kb_sources
          SET enrichment_status = 'completed'
          WHERE id = ? AND chunk_count = (
            SELECT COUNT(*) FROM kb_chunks c 
            JOIN knowledge_enrichment e ON c.id = e.chunk_id 
            WHERE c.source_id = ?
          )
        `).bind(msg.sourceId, msg.sourceId).run();
      } catch (err) {
        console.error(`[Enrichment] Failed to store result for chunk ${msg.chunkId}:`, err);
        throw err; // Allow message to be retried via Queue
      }
    } else {
      console.error(`[Enrichment] Failed to enrich chunk ${msg.chunkId} after ${maxRetries} inline attempts`);
      
      // If we are on our 3rd queue delivery (max_retries), mark the source as failed
      if (queueMsg.attempts >= 3) {
        await env.DB.prepare(
          `UPDATE kb_sources SET enrichment_status = 'failed' WHERE id = ?`
        ).bind(msg.sourceId).run();
      }

      // We throw to let the queue DLQ handle it
      throw new Error(`Failed to enrich chunk ${msg.chunkId}`);
    }
  }
}
