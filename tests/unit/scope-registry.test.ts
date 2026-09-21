import { expect, test } from 'vitest';
import type {
  DynamicProjectGrant,
  Principal,
  RepositoryProjectRecord,
  ScopeConfig
} from '../../src/core/types.js';
import { ScopeRegistry } from '../../src/projects/scope-registry.js';
import { Journal } from '../../src/storage/journal.js';

const staticScopes: ScopeConfig[] = [
  { id: 'freellmapi', backend_project: 'freellmapi', relative_root: 'Projects/freellmapi', repository_aliases: ['free-api'] },
  { id: 'shared', backend_project: 'shared', relative_root: 'Shared', repository_aliases: [] },
  { id: 'profile', backend_project: 'profile', relative_root: 'Profile', repository_aliases: [] }
];

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  id: 'reviewer-a',
  role: 'reviewer',
  read_scopes: ['freellmapi', 'shared'],
  write_scopes: ['freellmapi'],
  review_scopes: ['freellmapi'],
  ...overrides
});

const readyProject = (overrides: Partial<RepositoryProjectRecord> = {}): RepositoryProjectRecord => ({
  repository_identity: 'github.com/bearmanser/second-brain',
  scope: 'second-brain',
  backend_project: 'second-brain',
  relative_root: 'Projects/second-brain',
  state: 'ready',
  created_by_principal_id: 'reviewer-a',
  creation_operation_id: 'operation-a',
  created_at: '2026-09-21T09:00:00.000Z',
  updated_at: '2026-09-21T09:00:00.000Z',
  ...overrides
});

const reviewGrant: DynamicProjectGrant = {
  principal_id: 'reviewer-a',
  scope: 'second-brain',
  can_read: true,
  can_write: true,
  can_review: true
};

test('loads ready projects and grants without mutating the authenticated principal', () => {
  const journal = Journal.open(':memory:');
  journal.reserveProject({
    repository_identity: 'github.com/bearmanser/second-brain',
    scope: 'second-brain',
    created_by_principal_id: 'reviewer-a',
    creation_operation_id: 'operation-a'
  });
  journal.grantProject(reviewGrant);
  journal.markProjectReady('github.com/bearmanser/second-brain');
  const reviewer = principal();
  const before = structuredClone(reviewer);
  const registry = new ScopeRegistry(staticScopes, journal);

  expect(registry.all().map((scope) => scope.id)).toEqual([
    'freellmapi',
    'shared',
    'profile',
    'second-brain'
  ]);
  expect(registry.visibleTo(reviewer).map((scope) => scope.id)).toEqual([
    'freellmapi',
    'shared',
    'second-brain'
  ]);
  expect(registry.permissions(reviewer, 'second-brain')).toEqual({
    can_read: true,
    can_write: true,
    can_review: true
  });
  expect(reviewer).toEqual(before);
  journal.close();
});

test('isolates dynamic grants while owners can see every ready project', () => {
  const source = {
    listReadyProjects: () => [readyProject()],
    listProjectGrants: () => [reviewGrant]
  };
  const registry = new ScopeRegistry(staticScopes, source);
  const other = principal({ id: 'reviewer-b', read_scopes: [], write_scopes: [], review_scopes: [] });
  const owner = principal({ id: 'owner-a', role: 'owner', read_scopes: [], write_scopes: [], review_scopes: [] });
  expect(registry.visibleTo(other)).toEqual([]);
  expect(registry.permissions(other, 'second-brain')).toEqual({
    can_read: false,
    can_write: false,
    can_review: false
  });
  expect(registry.visibleTo(owner).map((scope) => scope.id)).toEqual(['second-brain']);
  expect(registry.permissions(owner, 'second-brain')).toEqual({
    can_read: true,
    can_write: true,
    can_review: true
  });
});

test('does not load projects that are provisioning or require recovery', () => {
  const source = {
    listReadyProjects: () => [],
    listProjectGrants: () => [reviewGrant]
  };
  const registry = new ScopeRegistry(staticScopes, source);
  expect(registry.get('second-brain')).toBeUndefined();
  expect(() => registry.registerReadyProject(readyProject({ state: 'provisioning' }), reviewGrant)).toThrow(
    /INVALID_INPUT/
  );
  expect(() =>
    registry.registerReadyProject(readyProject({ state: 'recovery_required' }), reviewGrant)
  ).toThrow(/INVALID_INPUT/);
});

test('keeps static identifiers authoritative and rejects aliases or reserved dynamic scopes', () => {
  expect(() =>
    new ScopeRegistry([
      ...staticScopes,
      { id: 'other', backend_project: 'other', relative_root: 'Projects/other', repository_aliases: ['free-api'] }
    ])
  ).toThrow(/INVALID_INPUT/);

  const registry = new ScopeRegistry(staticScopes);
  expect(registry.get('free-api')?.id).toBe('freellmapi');
  expect(() =>
    registry.registerReadyProject(readyProject({ scope: 'shared', backend_project: 'shared', relative_root: 'Projects/shared' }), {
      ...reviewGrant,
      scope: 'shared'
    })
  ).toThrow(/INVALID_INPUT/);
  expect(() =>
    registry.registerReadyProject(readyProject({ scope: 'free-api', backend_project: 'free-api', relative_root: 'Projects/free-api' }), {
      ...reviewGrant,
      scope: 'free-api'
    })
  ).toThrow(/INVALID_INPUT/);
});

test('registers repeated identical projects and additional grants safely', () => {
  const registry = new ScopeRegistry(staticScopes);
  registry.registerReadyProject(readyProject(), reviewGrant);
  registry.registerReadyProject(readyProject(), reviewGrant);
  registry.registerReadyProject(readyProject(), {
    ...reviewGrant,
    principal_id: 'worker-b',
    can_review: false
  });
  expect(registry.permissions(principal({ id: 'worker-b', role: 'worker' }), 'second-brain')).toEqual({
    can_read: true,
    can_write: true,
    can_review: false
  });
  expect(() =>
    registry.registerReadyProject(readyProject({ backend_project: 'wrong' }), reviewGrant)
  ).toThrow(/CONFLICT/);
});
