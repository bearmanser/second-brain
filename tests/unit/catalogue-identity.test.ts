import { expect, test } from 'vitest';
import { selectCatalogueEntry } from '../../src/notes/catalogue.js';
import {
  CURRENT_VAULT_DEBOUNCE_MS,
  CURRENT_VAULT_RESCAN_INTERVAL_MS,
  matchCurrentIdentity
} from '../../src/notes/current-catalogue.js';

test('a managed rename follows its ID rather than its previous path', () => {
  const id = '44b093c5-71db-4785-b9a5-bb8118304278';
  expect(matchCurrentIdentity(
    [{id, path: 'Knowledge/Before.md'}],
    [{id, path: 'Knowledge/After.md'}]
  )).toEqual([{id, from: 'Knowledge/Before.md', to: 'Knowledge/After.md'}]);
});

test('duplicate IDs return a conflict rather than a move', () => {
  const id = '44b093c5-71db-4785-b9a5-bb8118304278';
  expect(matchCurrentIdentity(
    [{ id, path: 'Knowledge/Original.md' }],
    [
      { id, path: 'Knowledge/Copy A.md' },
      { id, path: 'Knowledge/Copy B.md' }
    ]
  )).toEqual([
    { id, conflict: 'duplicate_id', paths: ['Knowledge/Copy A.md', 'Knowledge/Copy B.md', 'Knowledge/Original.md'] }
  ]);
  expect(matchCurrentIdentity(
    [
      { id, path: 'Knowledge/One.md' },
      { id, path: 'Knowledge/Two.md' }
    ],
    [{ id, path: 'Knowledge/Three.md' }]
  )).toEqual([
    { id, conflict: 'duplicate_id', paths: ['Knowledge/One.md', 'Knowledge/Three.md', 'Knowledge/Two.md'] }
  ]);
});

test('identity matching reports only real path changes', () => {
  const first = '44b093c5-71db-4785-b9a5-bb8118304278';
  const second = '550ba4d6-82ec-4896-a0b6-cc9229415389';
  expect(matchCurrentIdentity([], [{ id: first, path: 'Knowledge/New.md' }])).toEqual([]);
  expect(matchCurrentIdentity([{ id: first, path: 'Knowledge/Old.md' }], [])).toEqual([]);
  expect(
    matchCurrentIdentity([{ id: first, path: 'Knowledge/Same.md' }], [{ id: first, path: 'Knowledge/Same.md' }])
  ).toEqual([]);
  expect(
    matchCurrentIdentity(
      [{ id: first, path: 'Knowledge/A.md' }],
      [
        { id: second, path: 'Knowledge/B.md' },
        { id: first, path: 'Knowledge/C.md' }
      ]
    )
  ).toEqual([{ id: first, from: 'Knowledge/A.md', to: 'Knowledge/C.md' }]);
});

test('the current catalogue lookup prefers a managed ID over a path', () => {
  const entries = [
    { id: null, path: 'Knowledge/Plain.md' },
    { id: '44b093c5-71db-4785-b9a5-bb8118304278', path: 'Knowledge/Managed.md' },
    { id: '550ba4d6-82ec-4896-a0b6-cc9229415389', path: 'Knowledge/Other.md' }
  ];
  expect(
    selectCatalogueEntry(entries, { id: '44b093c5-71db-4785-b9a5-bb8118304278' })?.path
  ).toBe('Knowledge/Managed.md');
  expect(selectCatalogueEntry(entries, { path: 'Knowledge/Plain.md' })?.path).toBe(
    'Knowledge/Plain.md'
  );
  expect(
    selectCatalogueEntry(entries, {
      id: '44b093c5-71db-4785-b9a5-bb8118304278',
      path: 'Knowledge/Plain.md'
    })?.path
  ).toBe('Knowledge/Managed.md');
  expect(
    selectCatalogueEntry(entries, {
      id: 'aaaaaaaa-71db-4785-b9a5-bb8118304278',
      path: 'Knowledge/Plain.md'
    })?.path
  ).toBe('Knowledge/Plain.md');
  expect(selectCatalogueEntry(entries, { id: 'missing-id' })).toBeUndefined();
  expect(selectCatalogueEntry(entries, {})).toBeUndefined();
});

test('current vault observation uses the documented debounce and rescan interval', () => {
  expect(CURRENT_VAULT_DEBOUNCE_MS).toBe(250);
  expect(CURRENT_VAULT_RESCAN_INTERVAL_MS).toBe(30_000);
});
