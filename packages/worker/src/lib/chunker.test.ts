import { chunkText } from './chunker';

describe('chunkText', () => {
  it('splits on Markdown headings', () => {
    const text = `# Heading 1
This is paragraph one under heading 1. It is long enough to meet the minimum threshold if we combine it with the next one.
This is paragraph two under heading 1. Still going.
## Heading 2
This is paragraph one under heading 2. It is also long enough.
This is paragraph two under heading 2.`;

    const chunks = chunkText(text, { minChunkChars: 50 });
    
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toContain('# Heading 1');
    expect(chunks[0].content).toContain('Still going.');
    
    expect(chunks[1].chunkIndex).toBe(1);
    expect(chunks[1].content).toContain('## Heading 2');
    expect(chunks[1].content).toContain('under heading 2.');
  });

  it('splits on paragraph breaks when chunk is large enough', () => {
    const text = `This is the first paragraph. It has some text.

This is the second paragraph. It also has some text.

This is the third paragraph. More text here.`;

    const chunks = chunkText(text, { minChunkChars: 20 });
    
    expect(chunks.length).toBe(3);
    expect(chunks[0].content).toBe('This is the first paragraph. It has some text.');
    expect(chunks[1].content).toBe('This is the second paragraph. It also has some text.');
    expect(chunks[2].content).toBe('This is the third paragraph. More text here.');
  });

  it('does not split on paragraph breaks if chunk is too small', () => {
    const text = `Short para 1.

Short para 2.

Short para 3.`;

    const chunks = chunkText(text, { minChunkChars: 30 });
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe('Short para 1.\n\nShort para 2.\n\nShort para 3.');
  });

  it('keeps list items together', () => {
    const text = `Here is a list:
- Item one is long enough to trigger a split maybe if we set a low min.
- Item two is also somewhat long.
- Item three concludes the list.

Next paragraph after list.`;

    const chunks = chunkText(text, { minChunkChars: 20 });
    
    // The intro + list should be one chunk, the next para is the second
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toContain('- Item one');
    expect(chunks[0].content).toContain('- Item three');
    expect(chunks[1].content).toBe('Next paragraph after list.');
  });

  it('hard splits on sentence boundary if chunk exceeds maxChars', () => {
    const text = `This is a very long paragraph without any breaks. It just keeps going and going. We want it to split at a sentence boundary. This is the sentence that should push it over the edge and cause a split. Let's add one more sentence just to be absolutely sure it exceeds the max length limit set in the options.`;
    
    const chunks = chunkText(text, { maxChunkChars: 150, minChunkChars: 20 });
    
    expect(chunks.length).toBeGreaterThan(1);
    // Ensure period is kept at the end of the first chunk
    expect(chunks[0].content.endsWith('.')).toBe(true);
    // Ensure second chunk starts with capital letter (part of next sentence)
    expect(/^[A-Z]/.test(chunks[1].content)).toBe(true);
  });
  
  it('merges lone headings into the next chunk', () => {
    const text = `# Lone Heading

This is the paragraph that belongs to the lone heading above.`;
    
    const chunks = chunkText(text, { minChunkChars: 50 });
    
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe('# Lone Heading\n\nThis is the paragraph that belongs to the lone heading above.');
  });
});
