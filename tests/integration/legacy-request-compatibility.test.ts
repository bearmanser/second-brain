import { expect, test } from 'vitest';
import {
  LEGACY_SHARED_CATEGORY,
  LEGACY_WARNING_HYBRID_DEPRECATED,
  LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED,
  normalizeRecallMode,
  normalizeRecallScope
} from '../../src/contracts/compatibility.js';

const lookup = {
  exists: (identifier: string) => ['freellmapi', 'shared', 'profile'].includes(identifier)
};

test('an old scope is an organization alias, never an access right', () => {
  const normalized = normalizeRecallScope({ scope: 'freellmapi' }, lookup);
  expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
  expect(normalized.include_shared).toBe(false);
});

test('an unknown legacy scope is a clear error and never widens the query', () => {
  try {
    normalizeRecallScope({ scope: 'not-a-project' }, lookup);
    throw new Error('expected an unknown-scope error');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('NOT_FOUND');
    expect((error as Error).message).toContain('not-a-project');
  }
});

test('include_shared selects the shared category only for a project-filtered request', () => {
  const projectScoped = normalizeRecallScope(
    { project: 'freellmapi', include_shared: true },
    lookup
  );
  expect(projectScoped.selected_shared).toBe(true);
  expect(projectScoped.warnings).toContain(LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED);

  const wholeBrain = normalizeRecallScope({ include_shared: true }, lookup);
  expect(wholeBrain.filter).toEqual({ mode: 'all' });
  expect(wholeBrain.selected_shared).toBe(false);
});

test('the shared category is only selected when it exists', () => {
  const normalized = normalizeRecallScope(
    { project: 'profile', include_shared: true },
    { exists: (identifier) => identifier === 'profile' || identifier === LEGACY_SHARED_CATEGORY }
  );
  expect(normalized.selected_shared).toBe(true);
});

test('hybrid is a warned alias that executes as reranked', () => {
  const normalized = normalizeRecallMode('hybrid');
  expect(normalized.requested).toBe('hybrid');
  expect(normalized.executed).toBe('reranked');
  expect(normalized.warnings.join(' ')).toContain(LEGACY_WARNING_HYBRID_DEPRECATED);

  expect(normalizeRecallMode('text').executed).toBe('text');
  expect(normalizeRecallMode(undefined).executed).toBe('text');
  expect(normalizeRecallMode('reranked').deprecated).toBe(false);
});

test('conflicting project and scope aliases are rejected instead of guessed', () => {
  expect(() =>
    normalizeRecallScope({ project: 'freellmapi', scope: 'profile' }, lookup)
  ).toThrow(/different projects/);
});
