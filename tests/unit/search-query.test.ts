import { expect, test } from 'vitest';
import { literalMatch } from '../../src/retrieval/query.js';
import { openSearchIndex } from '../../src/storage/search-index.js';

test('user input is literal data rather than FTS syntax', () => {
  expect(literalMatch('opencode OR "service"')).toBe('"opencode" OR "OR" OR "service"');
  expect(literalMatch('" : *')).toBeNull();
  expect(literalMatch('blåbær')).toBe('"blåbær"');
});

test('empty and punctuation-only input has no literal match', () => {
  expect(literalMatch('')).toBeNull();
  expect(literalMatch('   ')).toBeNull();
  expect(literalMatch('* : ^ ( )')).toBeNull();
});

test('literal match deduplicates terms and bounds their count', () => {
  expect(literalMatch('Alpha alpha ALPHA')).toBe('"Alpha"');
  const many = Array.from({ length: 80 }, (_value, index) => `term${index}`).join(' ');
  const matched = literalMatch(many);
  expect(matched).not.toBeNull();
  expect(matched?.split(' OR ')).toHaveLength(64);
});

test('a punctuation-only query is an explicit invalid input rather than a whole-index scan', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({ path: 'Knowledge/Service.md', raw: '# Service\n\noldterm', etag: 'v1' });
    expect(() => index.candidates({ query: '* :', limit: 50 })).toThrowError(/searchable terms/);
  } finally {
    index.close();
  }
});

test('updates remove old searchable content in the same transaction', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({ path: 'Knowledge/Service.md', raw: '# Service\n\noldterm', etag: 'v1' });
    expect(index.candidates({ query: 'oldterm', limit: 50 })).toHaveLength(1);
    index.replaceDocument({ path: 'Knowledge/Service.md', raw: '# Service\n\nnewterm', etag: 'v2' });
    expect(index.candidates({ query: 'oldterm', limit: 50 })).toHaveLength(0);
    expect(index.candidates({ query: 'newterm', limit: 50 })).toHaveLength(1);
  } finally {
    index.close();
  }
});
