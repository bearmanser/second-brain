import { expect, test } from 'vitest';
import { chunkDocument, CHUNK_TARGET_TOKENS } from '../../src/retrieval/chunker.js';
import { parseDocument } from '../../src/notes/document-codec.js';
import { countReferenceTokens } from '../../src/retrieval/budget.js';

function chunksFor(raw: string, path = 'Knowledge/Example.md') {
  return chunkDocument(parseDocument(raw, path), raw);
}

function lineOf(raw: string, offset: number): number {
  return raw.slice(0, offset).split('\n').length;
}

test('chunks are exact source slices with one-based line numbers', () => {
  const raw =
    '---\ntype: note\nstatus: active\n---\n\n# Title\n\nFirst paragraph here.\n\n' +
    '## Section\n\nSecond paragraph with blåbær.\n';
  const chunks = chunksFor(raw);
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.text).toBe(raw.slice(chunk.start_offset, chunk.end_offset));
    expect(chunk.line_from).toBe(lineOf(raw, chunk.start_offset));
    expect(chunk.line_to).toBe(lineOf(raw, Math.max(chunk.start_offset, chunk.end_offset - 1)));
    expect(chunk.chunk_key).toBe(
      `${chunk.document_key}#${chunk.start_offset}-${chunk.end_offset}`
    );
  }
  expect(chunks.some((chunk) => chunk.text.includes('blåbær'))).toBe(true);
  const section = chunks.find((chunk) => chunk.text.includes('Second paragraph'));
  expect(section?.heading).toBe('Section');
});

test('CRLF bytes are preserved in the exact slices', () => {
  const raw = '# Service\r\n\r\noldterm with blåbær\r\n\r\n## More\r\n\r\nother\r\n';
  const chunks = chunksFor(raw);
  for (const chunk of chunks) {
    expect(chunk.text).toBe(raw.slice(chunk.start_offset, chunk.end_offset));
  }
  expect(chunks.some((chunk) => chunk.text.includes('\r\n'))).toBe(true);
  expect(chunks.some((chunk) => chunk.text.includes('blåbær'))).toBe(true);
});

test('tables and long code fences stay searchable data', () => {
  const code = '```ts\n' + 'const value = 1;\n'.repeat(600) + '```\n';
  const raw = `# Document\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n## Code\n\n${code}`;
  const chunks = chunksFor(raw);
  expect(chunks.some((chunk) => chunk.text.includes('| a | b |'))).toBe(true);
  expect(chunks.some((chunk) => chunk.text.includes('const value = 1;'))).toBe(true);
  for (const chunk of chunks) {
    expect(chunk.text).toBe(raw.slice(chunk.start_offset, chunk.end_offset));
  }
});

test('an oversized paragraph is split within the token target and overlaps', () => {
  const sentence = 'lorem ipsum dolor sit amet consectetur adipiscing elit ';
  const raw = `# Big\n\n${sentence.repeat(400)}`;
  const chunks = chunksFor(raw);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(countReferenceTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
    expect(chunk.text).toBe(raw.slice(chunk.start_offset, chunk.end_offset));
  }
  const overlapped = chunks.some(
    (chunk, index) => index > 0 && chunk.start_offset < chunks[index - 1].end_offset
  );
  expect(overlapped).toBe(true);
});

test('a long code fence is split without executing or rewriting its contents', () => {
  const code = '```sh\n' + 'echo hello world\n'.repeat(500) + '```\n';
  const raw = `# Script\n\n${code}`;
  const chunks = chunksFor(raw);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(raw.slice(chunk.start_offset, chunk.end_offset)).toBe(chunk.text);
    expect(countReferenceTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
  }
});

test('heading context is carried separately and never injected into the excerpt', () => {
  const raw = `# Head\n\n${'word '.repeat(400)}`;
  const chunks = chunksFor(raw);
  const continuation = chunks.find(
    (chunk) => !chunk.text.startsWith('# Head') && chunk.heading === 'Head'
  );
  expect(continuation).toBeDefined();
  expect(continuation?.text.includes('# Head')).toBe(false);
});

test('reference tokens record the wikilinks inside each slice', () => {
  const raw = '# Links\n\nSee [[Knowledge/Answer]] and [[Other#Part|label]].\n';
  const chunks = chunksFor(raw);
  const withLinks = chunks.find((chunk) => chunk.text.includes('Knowledge/Answer'));
  expect(withLinks?.reference_tokens).toEqual(['Knowledge/Answer', 'Other#Part']);
});

test('two near-target paragraphs keep every chunk within the token target after overlap', () => {
  const repeated = (word: string): string => {
    let text = '';
    while (countReferenceTokens(`${text}${word} `) <= 240) text += `${word} `;
    return text.trim();
  };
  const raw = `# Head\n\n${repeated('alpha')}\n\n${repeated('bravo')}\n`;
  const chunks = chunksFor(raw);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const chunk of chunks) {
    expect(countReferenceTokens(chunk.text)).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
    expect(chunk.text).toBe(raw.slice(chunk.start_offset, chunk.end_offset));
  }
  expect(chunks.some((chunk) => chunk.text.includes('bravo'))).toBe(true);
});

test('frontmatter-only notes produce a source-backed excerpt', () => {
  const raw = '---\naliases:\n  - Legacy alias\n---\n';
  const document = parseDocument(raw, 'Knowledge/Metadata only.md');
  const chunks = chunkDocument(document, raw);
  expect(chunks).toHaveLength(1);
  expect(chunks[0].text).toBe(raw);
  expect(chunks[0].text).toBe(raw.slice(chunks[0].start_offset, chunks[0].end_offset));
  expect(chunks[0].reference_tokens).toEqual([]);
  expect(chunks[0].heading).toBeNull();
});
