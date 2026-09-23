import { expect, test } from 'vitest';
import { hasDivergentIdentities } from '../../src/features/recall.js';

test('flags only genuinely divergent revision identities for one logical id', () => {
  const divergent = new Map<string, Set<string>>([
    ['id-1', new Set(['rev-a|hash-1', 'rev-b|hash-2'])]
  ]);
  expect(hasDivergentIdentities(divergent)).toBe(true);

  const identical = new Map<string, Set<string>>([
    ['id-1', new Set(['rev-a|hash-1', 'rev-a|hash-1'])]
  ]);
  expect(hasDivergentIdentities(identical)).toBe(false);

  const distinctIds = new Map<string, Set<string>>([
    ['id-1', new Set(['rev-a|hash-1'])],
    ['id-2', new Set(['rev-b|hash-2'])]
  ]);
  expect(hasDivergentIdentities(distinctIds)).toBe(false);
});
