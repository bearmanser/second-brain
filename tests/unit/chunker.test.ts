import { expect, test } from 'vitest';
import { CHUNK_MAX_CHARS, chunkNote } from '../../src/index/chunker.js';

test('uses the title as the heading of text before the first heading', () => {
  expect(chunkNote('Title', 'Intro text.\n\n## Situation\nIt broke.\n')).toEqual([
    { heading: 'Title', text: 'Intro text.' },
    { heading: 'Situation', text: '## Situation\nIt broke.' }
  ]);
});

test('ignores headings inside fenced code blocks', () => {
  const body = '## Code\n```md\n# not a heading\n\nstill code\n```\nafter\n';
  expect(chunkNote('T', body)).toEqual([
    { heading: 'Code', text: '## Code\n```md\n# not a heading\n\nstill code\n```\nafter' }
  ]);
});

test('handles CRLF line endings', () => {
  expect(chunkNote('T', 'a\r\n\r\n## H\r\nb\r\n')).toEqual([
    { heading: 'T', text: 'a' },
    { heading: 'H', text: '## H\nb' }
  ]);
});

test('packs paragraphs up to the size limit and splits oversized ones', () => {
  const paragraph = 'word '.repeat(100).trim();
  const chunks = chunkNote('T', Array.from({ length: 6 }, () => paragraph).join('\n\n'));
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  const long = chunkNote('T', 'x'.repeat(CHUNK_MAX_CHARS * 2 + 5));
  expect(long.map((c) => c.text.length)).toEqual([CHUNK_MAX_CHARS, CHUNK_MAX_CHARS, 5]);
});

test('returns a title-only chunk for empty bodies', () => {
  expect(chunkNote('Only title', '')).toEqual([{ heading: 'Only title', text: '' }]);
  expect(chunkNote('', '   \n')).toEqual([{ heading: null, text: '' }]);
});
