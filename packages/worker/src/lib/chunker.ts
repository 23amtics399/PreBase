/**
 * Structure-aware text chunker for PreBase knowledge bases.
 *
 * Chunking rules (in priority order):
 *   1. Split on Markdown headings (# / ## / ### / ####)
 *      → Always start a new chunk at a heading
 *      → Include the heading as the first line of the new chunk
 *   2. Within a section, split on blank lines (paragraph breaks)
 *      → Only if accumulated chunk >= MIN_CHUNK_CHARS
 *   3. Do not split inside a list block
 *      → Collect all list items before considering a split
 *   4. Hard cap: MAX_CHUNK_CHARS = 1500
 *      → Split at nearest sentence boundary if exceeded
 *   5. Minimum chunk size: MIN_CHUNK_CHARS = 100
 *      → Discard chunks shorter than this
 *      → Exception: lone headings are merged into the next chunk
 */

export interface Chunk {
  content: string;
  chunkIndex: number;
}

export interface ChunkerOptions {
  maxChunkChars?: number;
  minChunkChars?: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 1500;
// Lowered from 100 → 40 so short single-fact docs (e.g. one-sentence product
// descriptions ~75 chars) are not silently discarded. Any chunk with at least
// one complete sentence is worth indexing.
const DEFAULT_MIN_CHUNK_CHARS = 40;

// Matches Markdown headings: # to ####
const HEADING_RE = /^#{1,4}\s+.+/;

// Matches the start of a list item: "- ", "* ", or "1. "
const LIST_ITEM_RE = /^(\s*[-*]|\s*\d+\.)\s+/;

/**
 * Splits text at the nearest sentence boundary at or before `maxPos`.
 * Sentence boundary = '. ' followed by an uppercase letter, or end of string.
 * Falls back to splitting at the last space if no sentence boundary found.
 */
function splitAtSentenceBoundary(text: string, maxPos: number): [string, string] {
  // Search backward from maxPos for a sentence end
  const searchRegion = text.slice(0, maxPos);
  // Find last '. X' where X is uppercase (sentence end)
  const sentenceEndRe = /\.\s+[A-Z]/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = sentenceEndRe.exec(searchRegion)) !== null) {
    lastMatch = m;
  }

  if (lastMatch) {
    // Split after the period+space — keep the period in the first chunk
    const splitAt = lastMatch.index + 2;
    return [text.slice(0, splitAt).trim(), text.slice(splitAt).trim()];
  }

  // Fall back: split at last whitespace before maxPos
  const spaceIdx = searchRegion.lastIndexOf(' ');
  if (spaceIdx > 0) {
    return [text.slice(0, spaceIdx).trim(), text.slice(spaceIdx).trim()];
  }

  // Hard split — no choice
  return [text.slice(0, maxPos).trim(), text.slice(maxPos).trim()];
}

/**
 * Finalises a chunk: trims, validates against minChunkChars.
 * Returns the trimmed string or null if too short.
 */
function finalise(text: string, minChunkChars: number): string | null {
  const trimmed = text.trim();
  if (trimmed.length < minChunkChars) return null;
  return trimmed;
}

/**
 * Main chunker function.
 *
 * @param text    Raw text content (plain text or Markdown)
 * @param options Optional configuration overrides
 * @returns       Array of Chunk objects with content and index
 */
export function chunkText(text: string, options: ChunkerOptions = {}): Chunk[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const minChunkChars = options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;

  const lines = text.split('\n');
  const results: Chunk[] = [];
  let currentChunkLines: string[] = [];
  let currentChunkChars = 0;
  let inList = false;
  // Heading that needs to be merged into the next non-empty chunk
  let pendingHeading: string | null = null;

  function flushChunk(force = false): void {
    if (currentChunkLines.length === 0) return;

    const raw = currentChunkLines.join('\n');
    const trimmed = raw.trim();

    if (!force && trimmed.length < minChunkChars) {
      // Don't flush yet — keep accumulating
      return;
    }

    // Handle chunks that exceed the hard cap
    let remainder = trimmed;
    while (remainder.length > maxChunkChars) {
      const [head, tail] = splitAtSentenceBoundary(remainder, maxChunkChars);
      const chunk = finalise(head, minChunkChars);
      if (chunk) {
        results.push({ content: chunk, chunkIndex: results.length });
      }
      remainder = tail;
    }

    const chunk = finalise(remainder, minChunkChars);
    if (chunk) {
      results.push({ content: chunk, chunkIndex: results.length });
    }

    currentChunkLines = [];
    currentChunkChars = 0;
    inList = false;
  }

  for (const line of lines) {
    const isHeading = HEADING_RE.test(line);
    const isBlank = line.trim() === '';
    const isListItem = LIST_ITEM_RE.test(line);

    if (isHeading) {
      // Flush the current chunk first
      flushChunk(true);

      // If the flushed chunk was just a bare heading (pendingHeading scenario):
      // check if the results array last item is only a heading — if so, we'll
      // deal with that by storing it as a pending heading to merge.

      // Check if the last result is purely a heading line (will be merged into next)
      const lastResult = results[results.length - 1];
      if (
        lastResult &&
        results.length > 0 &&
        HEADING_RE.test(lastResult.content) &&
        lastResult.content.trim() === lastResult.content &&
        !lastResult.content.includes('\n')
      ) {
        // Last chunk is a lone heading — pull it back and use it as pendingHeading
        results.pop();
        pendingHeading = lastResult.content;
      }

      // Start new chunk with this heading
      currentChunkLines = [];
      currentChunkChars = 0;
      inList = false;

      // Prepend any pending heading from before
      if (pendingHeading) {
        currentChunkLines.push(pendingHeading);
        currentChunkChars += pendingHeading.length;
        pendingHeading = null;
      }

      currentChunkLines.push(line);
      currentChunkChars += line.length;
      continue;
    }

    if (isBlank) {
      if (inList) {
        // End of a list block
        inList = false;
      }

      // Paragraph break: consider splitting if chunk is large enough
      if (currentChunkChars >= minChunkChars) {
        flushChunk(false);
      } else {
        // Keep blank line as a separator within a small chunk
        if (currentChunkLines.length > 0) {
          currentChunkLines.push('');
          currentChunkChars += 1;
        }
      }
      continue;
    }

    if (isListItem) {
      inList = true;
    }

    // Regular content line
    if (!isListItem && inList) {
      // Continuation of a list item (indented content or continuation)
    }

    // Hard cap check: if adding this line would exceed the cap, flush first
    if (currentChunkChars + line.length + 1 > maxChunkChars && !inList) {
      flushChunk(true);
    }

    currentChunkLines.push(line);
    currentChunkChars += line.length + 1; // +1 for the newline
  }

  // Flush any remaining content
  flushChunk(true);

  // Re-index all chunks sequentially
  return results.map((chunk, i) => ({ ...chunk, chunkIndex: i }));
}
