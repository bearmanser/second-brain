import { expect, test } from 'vitest';
import {
  LEGACY_WARNING_HYBRID_DEPRECATED,
  LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED,
  normalizeRecallMode,
  normalizeRecallRequest,
  normalizeRecallScope
} from '../../src/contracts/compatibility.js';

const canonical: Record<string, string> = {
  freellmapi: 'freellmapi',
  'github.com/example/freellmapi': 'freellmapi',
  'free-llm-api': 'freellmapi',
  shared: 'shared',
  profile: 'profile'
};

const lookup = {
  canonicalId: (identifier: string) => canonical[identifier]
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

test('include_shared selects the shared category for scope-only and project-filtered requests', () => {
  for (const input of [
    { project: 'freellmapi', include_shared: true },
    { scope: 'freellmapi', include_shared: true }
  ]) {
    const normalized = normalizeRecallScope(input, lookup);
    expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
    expect(normalized.selected_shared).toBe(true);
    expect(normalized.warnings).toContain(LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED);
  }
});

test('include_shared changes nothing for a whole-brain request', () => {
  const normalized = normalizeRecallScope({ include_shared: true }, lookup);
  expect(normalized.filter).toEqual({ mode: 'all' });
  expect(normalized.selected_shared).toBe(false);
});

test('the shared category is not added when the request already targets shared', () => {
  const normalized = normalizeRecallScope(
    { project: 'shared', include_shared: true },
    lookup
  );
  expect(normalized.selected_shared).toBe(false);
});

test('a repository-identity alias resolves to the canonical project id', () => {
  const normalized = normalizeRecallScope({ scope: 'github.com/example/freellmapi' }, lookup);
  expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
});

test('an unknown scope is reported before a conflicting known project', () => {
  try {
    normalizeRecallScope({ project: 'profile', scope: 'not-a-project' }, lookup);
    throw new Error('expected an unknown-scope error');
  } catch (error) {
    expect((error as { code?: string }).code).toBe('NOT_FOUND');
    expect((error as Error).message).toContain('not-a-project');
  }
});

test('conflicting known project and scope aliases are rejected instead of guessed', () => {
  expect(() =>
    normalizeRecallScope({ project: 'freellmapi', scope: 'profile' }, lookup)
  ).toThrow(/different projects/);
});

test('equivalent aliases of the same project are accepted', () => {
  const normalized = normalizeRecallScope(
    { project: 'free-llm-api', scope: 'github.com/example/freellmapi' },
    lookup
  );
  expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
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

test('normalizeRecallRequest combines the canonical filter and the executed mode', () => {
  const normalized = normalizeRecallRequest(
    { scope: 'github.com/example/freellmapi', include_shared: true, mode: 'hybrid' },
    lookup
  );
  expect(normalized.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
  expect(normalized.selected_shared).toBe(true);
  expect(normalized.requested_mode).toBe('hybrid');
  expect(normalized.mode).toBe('reranked');
  expect(normalized.warnings.join(' ')).toContain(LEGACY_WARNING_HYBRID_DEPRECATED);
  expect(normalized.warnings).toContain(LEGACY_WARNING_INCLUDE_SHARED_DEPRECATED);
});
