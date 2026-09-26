import Database from 'better-sqlite3';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SearchIndex, literalMatch, type IndexedNote } from '../../src/index/search-index.js';
import { scratch } from '../helpers.js';

function note(path: string, overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path, id: `id-${path}`, title: path, type: 'note', project: null, tags: [], created: null,
    updated: null, hash: 'h', size: 1, mtimeMs: 1, ...overrides
  };
}

test('literalMatch quotes words and neutralizes FTS5 syntax', () => {
  expect(literalMatch('Laya "reranker" AND NEAR(x) -y *')).toBe('"Laya" OR "reranker" OR "AND" OR "NEAR" OR "x" OR "y"');
  expect(literalMatch('same SAME Same')).toBe('"same"');
  expect(literalMatch('*** --- ()')).toBeNull();
  expect(literalMatch(Array.from({ length: 80 }, (_, i) => `w${i}`).join(' '))?.split(' OR ').length).toBe(64);
});

test('upserts, searches with title weighting, and filters', () => {
  const index = SearchIndex.open(':memory:');
  index.upsert(note('Projects/A/budget.md', { title: 'Budget planning', project: 'A', type: 'decision' }), [
    { heading: 'Budget planning', text: 'unrelated words' }
  ]);
  index.upsert(note('Projects/B/other.md', { title: 'Other', project: 'B', tags: ['finance'] }), [
    { heading: 'Other', text: 'the budget was exceeded' }
  ]);
  expect(index.search('budget', {}, 10).map((hit) => hit.path)).toEqual(['Projects/A/budget.md', 'Projects/B/other.md']);
  expect(index.search('budget', { project: 'B' }, 10).map((hit) => hit.path)).toEqual(['Projects/B/other.md']);
  expect(index.search('budget', { types: ['decision'] }, 10).map((hit) => hit.path)).toEqual(['Projects/A/budget.md']);
  expect(index.search('finance', {}, 10)[0]).toMatchObject({ path: 'Projects/B/other.md', heading: 'Other' });
  expect(index.search('budget', {}, 1)).toHaveLength(1);
});

test('treats hostile queries as plain words', () => {
  const index = SearchIndex.open(':memory:');
  index.upsert(note('a.md'), [{ heading: null, text: 'drop table notes' }]);
  expect(() => index.search('"; DROP TABLE notes; -- NEAR( * )', {}, 10)).not.toThrow();
  expect(index.search('***', {}, 10)).toEqual([]);
  expect(index.all()).toHaveLength(1);
});

test('re-upsert replaces chunks and remove deletes everything for a path', () => {
  const index = SearchIndex.open(':memory:');
  index.upsert(note('a.md'), [{ heading: null, text: 'alpha' }]);
  index.upsert(note('a.md'), [{ heading: null, text: 'beta' }]);
  expect(index.search('alpha', {}, 10)).toEqual([]);
  expect(index.search('beta', {}, 10)).toHaveLength(1);
  index.remove('a.md');
  expect(index.search('beta', {}, 10)).toEqual([]);
  expect(index.get('a.md')).toBeUndefined();
});

test('reads notes back and reports duplicate ids', () => {
  const index = SearchIndex.open(':memory:');
  const stored = note('b.md', { id: 'dup', tags: ['x', 'y'], mtimeMs: 1234.5, created: 'c', updated: 'u' });
  index.upsert(stored, [{ heading: null, text: '' }]);
  index.upsert(note('a.md', { id: 'dup' }), [{ heading: null, text: '' }]);
  index.upsert(note('c.md', { id: null }), [{ heading: null, text: '' }]);
  expect(index.get('b.md')).toEqual(stored);
  expect(index.byId('dup').map((n) => n.path)).toEqual(['a.md', 'b.md']);
  expect(index.all().map((n) => n.path)).toEqual(['a.md', 'b.md', 'c.md']);
  expect(index.duplicateIds()).toEqual(new Map([['dup', ['a.md', 'b.md']]]));
});

test('rebuilds tables when the schema version differs', () => {
  const file = join(scratch('index'), 'index.db');
  const raw = new Database(file);
  raw.exec('CREATE TABLE notes (legacy TEXT)');
  raw.pragma('user_version = 99');
  raw.close();
  const index = SearchIndex.open(file);
  expect(index.all()).toEqual([]);
  index.upsert(note('a.md'), [{ heading: null, text: 'x' }]);
  index.close();
  expect(SearchIndex.open(file).all()).toHaveLength(1);
});
