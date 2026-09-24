import { expect, test } from 'vitest';
import { expectTypeOf } from 'vitest';
import type {
  LocalAllocatedIdentity,
  LocalHandlerDeps,
  LocalMutationCoordinatorPort,
  LocalOperationIntent,
  LocalOperationPlan,
  LocalOperationReceipt,
  LocalReadCondition,
  LocalObservedState,
  LocalPlannedOperation,
  ProjectResolutionPort,
  SourceBoundCursorPort,
  ProjectEnsureResult,
  ProjectEnsureResultV2,
  StatusResult,
  StatusResultV2
} from '../../src/core/types.js';
import { lessonFixture, fixtureIds } from '../fixtures/content.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const KEY = fixtureIds.idempotencyKey;
const HEADS = [
  { revision_id: fixtureIds.revision, etag: HASH },
  { revision_id: fixtureIds.replacement, etag: OTHER_HASH }
];
const PARENTS = [
  { revision_id: fixtureIds.revision, raw_hash: HASH },
  { revision_id: fixtureIds.replacement, raw_hash: OTHER_HASH }
];

test('operation intents construct every note mutation with explicit move, adopt and full fork heads', () => {
  const base = { project_id: 'repo', idempotency_key: KEY };
  const capture = {
    ...base, tool: 'brain_capture', action: 'capture',
    payload: { idempotency_key: KEY, note: lessonFixture }, preconditions: {}
  } satisfies LocalOperationIntent;
  const review = (action: 'approve' | 'archive') => ({
    ...base, tool: 'brain_review' as const, action,
    payload: { action, idempotency_key: KEY, id: fixtureIds.note, expected_etag: HASH, rationale: 'reviewed' },
    preconditions: { id: fixtureIds.note, etag: HASH }
  } satisfies LocalOperationIntent);
  const revise = {
    ...base, tool: 'brain_review', action: 'revise',
    payload: { action: 'revise', idempotency_key: KEY, id: fixtureIds.note, expected_etag: HASH, rationale: 'correct', note: lessonFixture },
    preconditions: { id: fixtureIds.note, etag: HASH }
  } satisfies LocalOperationIntent;
  const supersede = {
    ...base, tool: 'brain_review', action: 'supersede',
    payload: { action: 'supersede', idempotency_key: KEY, id: fixtureIds.note, expected_etag: HASH, rationale: 'replace', replacement_id: fixtureIds.replacement },
    preconditions: { id: fixtureIds.note, etag: HASH }
  } satisfies LocalOperationIntent;
  const move = {
    ...base, tool: 'brain_review', action: 'move',
    payload: { action: 'move', idempotency_key: KEY, id: fixtureIds.note, target_path: 'Knowledge/Moved.md', expected_etag: HASH, rationale: 'relocate' },
    preconditions: { id: fixtureIds.note, etag: HASH, target_path: 'Knowledge/Moved.md' }
  } satisfies LocalOperationIntent;
  const adopt = {
    ...base, tool: 'brain_review', action: 'adopt',
    payload: { action: 'adopt', idempotency_key: KEY, path: 'Knowledge/Human.md', expected_etag: HASH, rationale: 'adopt' },
    preconditions: { path: 'Knowledge/Human.md', etag: HASH }
  } satisfies LocalOperationIntent;
  const resolve = {
    ...base, tool: 'brain_review', action: 'resolve',
    payload: { action: 'resolve', idempotency_key: KEY, id: fixtureIds.note, expected_heads: HEADS, rationale: 'merge both branches', note: lessonFixture },
    preconditions: { id: fixtureIds.note, expected_heads: HEADS }
  } satisfies LocalOperationIntent;
  expect([capture, ...(['approve', 'archive'] as const).map(review), revise, supersede, move, adopt, resolve]
    .map((intent) => intent.action)).toEqual([
      'capture', 'approve', 'archive', 'revise', 'supersede', 'move', 'adopt', 'resolve'
    ]);
  expect(resolve.preconditions.expected_heads).toEqual(HEADS);
});

test('the note plan can retain all conflict heads and parents and express safe moves or adoption', async () => {
  const identity: LocalAllocatedIdentity = {
    kind: 'note', operation_id: KEY, timestamp: '2026-09-23T00:00:00Z',
    storage_operation_ids: [fixtureIds.revision, fixtureIds.replacement],
    note_id: fixtureIds.note, revision_id: KEY, path: 'Knowledge/Moved.md'
  };
  const observed: LocalObservedState = {
    sources: [
      { path: 'Knowledge/Original.md', raw: 'old', etag: HASH, id: fixtureIds.note, revision_id: fixtureIds.revision, parents: [] },
      { path: 'Knowledge/Fork.md', raw: 'fork', etag: OTHER_HASH, id: fixtureIds.note, revision_id: fixtureIds.replacement, parents: [{ revision_id: fixtureIds.revision, raw_hash: HASH }] }
    ],
    heads: [
      { id: fixtureIds.note, path: 'Knowledge/Original.md', ...HEADS[0], parents: [] },
      { id: fixtureIds.note, path: 'Knowledge/Fork.md', ...HEADS[1], parents: [{ revision_id: fixtureIds.revision, raw_hash: HASH }] }
    ]
  };
  const write = { path: identity.path, raw: 'resolved', id: identity.note_id, revision_id: identity.revision_id, parents: PARENTS };
  const plan: LocalOperationPlan = async (_identity, state) => ({
    kind: 'note', heads: state.heads, parents: PARENTS,
    read_set: [{ kind: 'heads', id: fixtureIds.note, expected_heads: HEADS }],
    effects: [
      { kind: 'move', from_path: state.sources[0].path, to_path: identity.path, write },
      { kind: 'adopt', path: 'Knowledge/Human.md', write: { ...write, path: 'Knowledge/Human.md' } },
      { kind: 'write', write: { ...write, path: 'Knowledge/History.md' } }
    ]
  });
  const result: LocalPlannedOperation = await plan(identity, observed);
  expect(result).toEqual({
    kind: 'note', heads: observed.heads, parents: PARENTS,
    read_set: [{ kind: 'heads', id: fixtureIds.note, expected_heads: HEADS }],
    effects: [
      { kind: 'move', from_path: 'Knowledge/Original.md', to_path: 'Knowledge/Moved.md', write },
      { kind: 'adopt', path: 'Knowledge/Human.md', write: { ...write, path: 'Knowledge/Human.md' } },
      { kind: 'write', write: { ...write, path: 'Knowledge/History.md' } }
    ]
  });
});

test('project ensure and feedback intents plan durable receipts without fabricated note IDs', async () => {
  const ensureIntent = {
    tool: 'brain_project_ensure', action: 'ensure', project_id: null, idempotency_key: KEY,
    payload: { idempotency_key: KEY, remote_url: 'git@github.com:example/repo.git' }, preconditions: {}
  } satisfies LocalOperationIntent;
  const feedbackIntent = {
    tool: 'brain_feedback', action: 'record', project_id: 'repo', idempotency_key: KEY,
    payload: { idempotency_key: KEY, id: fixtureIds.note, revision_id: fixtureIds.revision, verdict: 'useful', reason: 'verified' },
    preconditions: { id: fixtureIds.note, revision_id: fixtureIds.revision }
  } satisfies LocalOperationIntent;
  const observed: LocalObservedState = { sources: [], heads: [] };
  const ensureIdentity: LocalAllocatedIdentity = { kind: 'project_ensure', operation_id: KEY, timestamp: '2026-09-23T00:00:00Z', storage_operation_ids: [] };
  const feedbackIdentity: LocalAllocatedIdentity = { kind: 'feedback', operation_id: KEY, feedback_id: fixtureIds.replacement, timestamp: '2026-09-23T00:00:00Z', storage_operation_ids: [] };
  const ensurePlan: LocalOperationPlan = async () => ({
    kind: 'project_ensure', repository_identity: 'github.com/example/repo', project_id: 'repo',
    relative_root: 'Projects/Repo', created: true,
    read_set: [{ kind: 'project', repository_identity: 'github.com/example/repo', expected: { kind: 'absent' } }]
  });
  const feedbackPlan: LocalOperationPlan = async () => ({
    kind: 'feedback', feedback_id: feedbackIdentity.feedback_id,
    id: fixtureIds.note, revision_id: fixtureIds.revision, verdict: 'useful', reason: 'verified',
    read_set: [{ kind: 'note', id: fixtureIds.note, expected: { kind: 'present', path: 'Knowledge/Original.md', revision_id: fixtureIds.revision, etag: HASH } }]
  });
  expect(ensureIntent.action).toBe('ensure');
  expect(feedbackIntent.action).toBe('record');
  expect(await ensurePlan(ensureIdentity, observed)).toMatchObject({ kind: 'project_ensure', created: true });
  expect(await feedbackPlan(feedbackIdentity, observed)).toMatchObject({ kind: 'feedback', revision_id: fixtureIds.revision });
  const ensureReceipt: LocalOperationReceipt = {
    kind: 'project_ensure', operation_id: KEY, repository_identity: 'github.com/example/repo',
    project_id: 'repo', relative_root: 'Projects/Repo', created: true, materialized: true, warnings: []
  };
  const feedbackReceipt: LocalOperationReceipt = { kind: 'feedback', operation_id: KEY, feedback_id: fixtureIds.replacement, recorded: true };
  expect([ensureReceipt.kind, feedbackReceipt.kind]).toEqual(['project_ensure', 'feedback']);
});

test('a move plan persists source version and destination vacancy or destination version', async () => {
  const target = { kind: 'note', id: fixtureIds.note,
    expected: { kind: 'present', path: 'Knowledge/Original.md', revision_id: fixtureIds.revision, etag: HASH }
  } as const satisfies LocalReadCondition;
  const destination = { kind: 'path', path: 'Knowledge/Moved.md', expected: { kind: 'absent' } } as const satisfies LocalReadCondition;
  const occupiedDestination = { kind: 'path', path: 'Knowledge/Moved.md',
    expected: { kind: 'present', etag: OTHER_HASH, id: fixtureIds.replacement }
  } as const satisfies LocalReadCondition;
  const identity: LocalAllocatedIdentity = {
    kind: 'note', operation_id: KEY, timestamp: '2026-09-23T00:00:00Z', storage_operation_ids: [],
    note_id: fixtureIds.note, revision_id: fixtureIds.revision, path: 'Knowledge/Moved.md'
  };
  const observed: LocalObservedState = { sources: [], heads: [] };
  const planFor = (destinationCondition: LocalReadCondition): LocalOperationPlan => async () => ({
    kind: 'note', heads: [], parents: [], effects: [{ kind: 'move', from_path: 'Knowledge/Original.md', to_path: 'Knowledge/Moved.md' }],
    read_set: [target, destinationCondition]
  });
  const vacant = await planFor(destination)(identity, observed);
  const occupied = await planFor(occupiedDestination)(identity, observed);
  expect(vacant.read_set).toEqual([
    { kind: 'note', id: fixtureIds.note, expected: { kind: 'present', path: 'Knowledge/Original.md', revision_id: fixtureIds.revision, etag: HASH } },
    { kind: 'path', path: 'Knowledge/Moved.md', expected: { kind: 'absent' } }
  ]);
  expect(occupied.read_set).toEqual([
    { kind: 'note', id: fixtureIds.note, expected: { kind: 'present', path: 'Knowledge/Original.md', revision_id: fixtureIds.revision, etag: HASH } },
    { kind: 'path', path: 'Knowledge/Moved.md', expected: { kind: 'present', etag: OTHER_HASH, id: fixtureIds.replacement } }
  ]);
});

test('revise, adopt, supersede and resolve plans retain every dependency in the persisted read set', async () => {
  const identity: LocalAllocatedIdentity = {
    kind: 'note', operation_id: KEY, timestamp: '2026-09-23T00:00:00Z', storage_operation_ids: [],
    note_id: fixtureIds.note, revision_id: KEY, path: 'Knowledge/Original.md'
  };
  const observed: LocalObservedState = {
    sources: [],
    heads: [
      { id: fixtureIds.note, path: 'Knowledge/Original.md', ...HEADS[0], parents: [] },
      { id: fixtureIds.note, path: 'Knowledge/Fork.md', ...HEADS[1], parents: [{ revision_id: fixtureIds.revision, raw_hash: HASH }] }
    ]
  };
  const target = { kind: 'note', id: fixtureIds.note,
    expected: { kind: 'present', path: 'Knowledge/Original.md', revision_id: fixtureIds.revision, etag: HASH }
  } as const satisfies LocalReadCondition;
  const readSets: Record<'revise' | 'adopt' | 'supersede' | 'resolve', readonly [LocalReadCondition, ...LocalReadCondition[]]> = {
    revise: [target],
    adopt: [{ kind: 'path', path: 'Knowledge/Human.md', expected: { kind: 'present', etag: HASH } }],
    supersede: [
      target,
      { kind: 'note', id: fixtureIds.replacement, expected: { kind: 'present', path: 'Knowledge/Replacement.md', revision_id: fixtureIds.replacement, etag: OTHER_HASH } },
      { kind: 'note', id: KEY, expected: { kind: 'present', path: 'Knowledge/Chain.md', revision_id: KEY, etag: 'c'.repeat(64) } }
    ],
    resolve: [{ kind: 'heads', id: fixtureIds.note, expected_heads: HEADS }]
  };
  const planFor = (read_set: readonly [LocalReadCondition, ...LocalReadCondition[]]): LocalOperationPlan => async () => ({
    kind: 'note', heads: [], parents: [], effects: [], read_set
  });
  const resolvePlan: LocalOperationPlan = async (_identity, state) => ({
    kind: 'note', heads: state.heads, parents: PARENTS, effects: [], read_set: readSets.resolve
  });
  const revise = await planFor(readSets.revise)(identity, observed);
  const adopt = await planFor(readSets.adopt)(identity, observed);
  const supersede = await planFor(readSets.supersede)(identity, observed);
  const resolve = await resolvePlan(identity, observed);
  expect(revise.read_set).toEqual([
    { kind: 'note', id: fixtureIds.note, expected: { kind: 'present', path: 'Knowledge/Original.md', revision_id: fixtureIds.revision, etag: HASH } }
  ]);
  expect(adopt.read_set).toEqual([
    { kind: 'path', path: 'Knowledge/Human.md', expected: { kind: 'present', etag: HASH } }
  ]);
  expect(supersede.read_set).toEqual([
    { kind: 'note', id: fixtureIds.note, expected: { kind: 'present', path: 'Knowledge/Original.md', revision_id: fixtureIds.revision, etag: HASH } },
    { kind: 'note', id: fixtureIds.replacement, expected: { kind: 'present', path: 'Knowledge/Replacement.md', revision_id: fixtureIds.replacement, etag: OTHER_HASH } },
    { kind: 'note', id: KEY, expected: { kind: 'present', path: 'Knowledge/Chain.md', revision_id: KEY, etag: 'c'.repeat(64) } }
  ]);
  expect(resolve.read_set).toEqual([{ kind: 'heads', id: fixtureIds.note, expected_heads: HEADS }]);
  expect(resolve).toMatchObject({ heads: observed.heads, parents: PARENTS });
});

test('local handler dependencies expose the frozen capabilities', () => {
  expectTypeOf<LocalHandlerDeps['mutations']>().toEqualTypeOf<LocalMutationCoordinatorPort>();
  expectTypeOf<LocalHandlerDeps['projects']>().toEqualTypeOf<ProjectResolutionPort>();
  expectTypeOf<LocalHandlerDeps['cursors']>().toEqualTypeOf<SourceBoundCursorPort>();
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('documents');
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('catalogue');
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('index');
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('journal');
  expectTypeOf<LocalHandlerDeps>().toHaveProperty('worker');
});

test('V2 public result shapes do not carry backend-specific fields', () => {
  expectTypeOf<ProjectEnsureResultV2>().not.toHaveProperty('backend_ready');
  expectTypeOf<StatusResultV2['health']>().not.toHaveProperty('backend');
  expectTypeOf<StatusResultV2['health']>().not.toHaveProperty('embeddings');
  expectTypeOf<StatusResultV2['health']>().toHaveProperty('index');
  expectTypeOf<StatusResultV2['health']>().toHaveProperty('worker');

  const ensure: ProjectEnsureResultV2 = {
    operation_id: 'op',
    repository_identity: 'github.com/example/repo',
    project_id: 'repo',
    relative_root: 'Projects/Repo',
    created: true,
    materialized: true,
    warnings: []
  };
  expect(ensure.project_id).toBe('repo');

  const status: StatusResultV2 = {
    version: '0.1.0',
    protocol_version: '2',
    schema_version: 1,
    protocol: 2,
    projects: [{ id: 'repo', display_name: 'Repo', relative_root: 'Projects/Repo', state: 'ready' }],
    health: { gateway: 'ready', index: 'ready', worker: 'disabled' },
    features: { reranking: false, text_search: true, fallback: true },
    pending_operations: 0
  };
  expect(status.health.index).toBe('ready');
});

test('the legacy result shapes keep their backend fields separate', () => {
  expectTypeOf<ProjectEnsureResult>().toHaveProperty('backend_ready');
  expectTypeOf<StatusResult['health']>().toHaveProperty('backend');
  expectTypeOf<StatusResult['health']>().toHaveProperty('embeddings');

  const legacyEnsure: ProjectEnsureResult = {
    operation_id: 'op',
    repository_identity: 'github.com/example/repo',
    scope: 'repo',
    created: true,
    backend_ready: true,
    materialized: true,
    warnings: []
  };
  expect(legacyEnsure.backend_ready).toBe(true);
  const legacyStatus: StatusResult = {
    version: '0.1.0',
    protocol_version: '1',
    schema_version: 1,
    scopes: [{ id: 'shared' }],
    health: { gateway: 'ready', backend: 'ready', embeddings: 'unknown' },
    pending_operations: 0
  };
  expect(legacyStatus.health.backend).toBe('ready');
});
