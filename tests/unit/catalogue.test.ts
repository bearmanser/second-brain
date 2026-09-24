import { afterEach, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BrainError, type BrainErrorCode } from '../../src/contracts/errors.js';
import type { ScopeConfig, StoredRevision } from '../../src/core/types.js';
import { makeEtag, payloadHash, renderRevision } from '../../src/notes/codec.js';
import { hashRaw, relativePathFor } from '../../src/notes/identity.js';
import { RevisionCatalogue, resolveHead, type ApprovalProvenance, type ParsedRevision } from '../../src/notes/catalogue.js';
import { FileVault } from '../../src/storage/vault.js';
import { fixtureIds, lessonFixture, revisionGraphFixture } from '../fixtures/content.js';

const temporaryRoot = join('/tmp/opencode', 'brain-catalogue-tests');
const temporaryDirectories: string[] = [];
const openCatalogues: RevisionCatalogue[] = [];

const scopeConfig: ScopeConfig = {
  id: 'freellmapi',
  backend_project: 'freellmapi',
  relative_root: 'freellmapi',
  repository_aliases: []
};

const sharedScope: ScopeConfig = {
  id: 'shared',
  backend_project: 'shared',
  relative_root: 'shared',
  repository_aliases: []
};

afterEach(() => {
  while (openCatalogues.length > 0) openCatalogues.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const makeVaultRoot = (): string => {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'case-'));
  temporaryDirectories.push(directory);
  return directory;
};

const writeRaw = (root: string, relativePath: string, raw: string): string => {
  const absolute = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, raw, 'utf8');
  return absolute;
};

let sequence = 0;
const nextUuid = (): string => {
  sequence += 1;
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
};

const makeRevision = (overrides: Partial<StoredRevision> = {}): StoredRevision => ({
  id: nextUuid(),
  revision_id: nextUuid(),
  parents: [],
  scope: scopeConfig.id,
  status: 'candidate',
  note: lessonFixture,
  created_at: '2026-09-01T00:00:00Z',
  modified_at: '2026-09-01T00:05:00Z',
  operation_id: fixtureIds.idempotencyKey,
  extra_frontmatter: {},
  extra_markdown: '',
  ...overrides
});

test('registers a dynamic catalogue scope idempotently and rejects mapping changes', async () => {
  const root = makeVaultRoot();
  mkdirSync(join(root, scopeConfig.relative_root), { recursive: true });
  const vault = new FileVault(root, [scopeConfig]);
  const catalogue = RevisionCatalogue.open(join(root, 'catalogue.sqlite'), {
    vault,
    scopes: [scopeConfig]
  });
  openCatalogues.push(catalogue);
  const dynamic: ScopeConfig = {
    id: 'second-brain',
    backend_project: 'second-brain',
    relative_root: 'Projects/second-brain',
    repository_aliases: []
  };
  mkdirSync(join(root, 'Projects', 'second-brain'), { recursive: true });
  vault.registerScope(dynamic);
  expect(() => catalogue.registerScope(dynamic)).not.toThrow();
  expect(() => catalogue.registerScope(dynamic)).not.toThrow();
  await expect(catalogue.reconcileReport(dynamic.id)).resolves.toMatchObject({ scope: dynamic.id });
  expect(() => catalogue.registerScope({ ...dynamic, backend_project: 'wrong' })).toThrow(
    /CONFLICT/
  );
});

const writeRevision = (
  root: string,
  revision: StoredRevision
): { path: string; raw: string; hash: string } => {
  const raw = renderRevision(revision, scopeConfig);
  const path = relativePathFor(
    scopeConfig.relative_root,
    revision.note.content.kind,
    revision.id,
    revision.note.title,
    revision.revision_id
  );
  writeRaw(root, path, raw);
  return { path, raw, hash: hashRaw(raw) };
};

const trustAllProvenance: ApprovalProvenance = { verify: () => true };

const openCatalogue = (
  root: string,
  provenance: ApprovalProvenance | null = trustAllProvenance
): { vault: FileVault; catalogue: RevisionCatalogue } => {
  const vault = new FileVault(root, [scopeConfig, sharedScope]);
  const catalogue = RevisionCatalogue.open(join(root, 'catalogue.sqlite'), {
    vault,
    scopes: [scopeConfig, sharedScope],
    ...(provenance === null ? {} : { approval_provenance: provenance })
  });
  openCatalogues.push(catalogue);
  return { vault, catalogue };
};

const expectBrain = async (action: Promise<unknown>, code: BrainErrorCode): Promise<void> => {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).code).toBe(code);
    return;
  }
  throw new Error(`expected BrainError ${code} but the action resolved`);
};

test('does not choose a winner when two revisions share a parent', () => {
  const { root, left, right } = revisionGraphFixture();
  const result = resolveHead([root, left, right]);
  expect(result.state).toBe('conflict');
  if (result.state === 'conflict') expect(result.heads).toHaveLength(2);
});

test('accepts a single valid chain and selects the child as head', () => {
  const { root, left } = revisionGraphFixture();
  const result = resolveHead([root, left]);
  expect(result.state).toBe('ready');
  if (result.state === 'ready') expect(result.head.revision.revision_id).toBe(left.revision.revision_id);
});

test('rejects duplicate revision identities across scopes', () => {
  const { root } = revisionGraphFixture();
  const duplicate: ParsedRevision = {
    revision: { ...root.revision, scope: 'shared' },
    raw_hash: root.raw_hash,
    relative_path: 'shared/Lessons/copy.md'
  };
  const result = resolveHead([root, duplicate]);
  expect(result.state).toBe('conflict');
  if (result.state === 'conflict') expect(result.reasons).toContain('duplicate_revision_id');
});

test('rejects a missing parent', () => {
  const { left } = revisionGraphFixture();
  const result = resolveHead([left]);
  expect(result.state).toBe('conflict');
  if (result.state === 'conflict') expect(result.reasons).toContain('missing_parent');
});

test('rejects a parent raw-hash mismatch', () => {
  const { root, left } = revisionGraphFixture();
  const changed: ParsedRevision = {
    revision: {
      ...left.revision,
      parents: [{ revision_id: root.revision.revision_id, raw_hash: 'd'.repeat(64) }]
    },
    raw_hash: left.raw_hash,
    relative_path: left.relative_path
  };
  const result = resolveHead([root, changed]);
  expect(result.state).toBe('conflict');
  if (result.state === 'conflict') expect(result.reasons).toContain('parent_hash_mismatch');
});

test('rejects a cycle', () => {
  const { root, left } = revisionGraphFixture();
  const a: ParsedRevision = {
    revision: {
      ...root.revision,
      parents: [{ revision_id: left.revision.revision_id, raw_hash: left.raw_hash }]
    },
    raw_hash: root.raw_hash,
    relative_path: root.relative_path
  };
  const b: ParsedRevision = {
    revision: {
      ...left.revision,
      parents: [{ revision_id: root.revision.revision_id, raw_hash: root.raw_hash }]
    },
    raw_hash: left.raw_hash,
    relative_path: left.relative_path
  };
  const result = resolveHead([a, b]);
  expect(result.state).toBe('conflict');
  if (result.state === 'conflict') expect(result.reasons).toContain('cycle');
});

test('reconciles a single revision into a unique head and stays rebuildable', async () => {
  const root = makeVaultRoot();
  const revision = makeRevision();
  const info = writeRevision(root, revision);
  const { catalogue } = openCatalogue(root);

  await expectBrain(catalogue.get(scopeConfig.id, revision.id), 'NOT_FOUND');
  await catalogue.reconcile(scopeConfig.id);

  const head = await catalogue.get(scopeConfig.id, revision.id);
  expect(head.revision.revision_id).toBe(revision.revision_id);
  expect(head.source.relative_path).toBe(info.path);
  expect(head.source.etag).toBe(makeEtag(revision.revision_id, info.hash));
  expect(head.source.status).toBe('candidate');
  expect(head.state).toBe('ready');

  await catalogue.reconcile(scopeConfig.id);
  const again = await catalogue.get(scopeConfig.id, revision.id);
  expect(again.raw_hash).toBe(head.raw_hash);

  const database = new Database(join(root, 'catalogue.sqlite'));
  const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  expect(versions).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 },
    { version: 6 },
    { version: 7 },
    { version: 8 },
    { version: 9 },
    { version: 10 },
    { version: 11 }
  ]);
  database.close();
});

test('never returns an older active revision when an archived head descends from it', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const parent = makeRevision({ id: noteId, status: 'active' });
  const parentInfo = writeRevision(root, parent);
  const child = makeRevision({
    id: noteId,
    status: 'archived',
    parents: [{ revision_id: parent.revision_id, raw_hash: parentInfo.hash }]
  });
  writeRevision(root, child);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);

  const head = await catalogue.get(scopeConfig.id, noteId);
  expect(head.revision.revision_id).toBe(child.revision_id);
  expect(head.revision.status).toBe('archived');
  expect(head.source.status).toBe('archived');
  expect(head.state).toBe('ready');

  const historical = await catalogue.getRevision(scopeConfig.id, noteId, parent.revision_id);
  expect(historical.revision.revision_id).toBe(parent.revision_id);
  expect(historical.source.warnings).toContain('historical');
});

test('marks a changed approval payload fingerprint as manual_unreviewed', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const base = makeRevision({ id: noteId, status: 'active' });
  const approved: StoredRevision = {
    ...base,
    approval: {
      principal_id: nextUuid(),
      rationale: 'Approved after review.',
      payload_hash: payloadHash(base)
    }
  };
  const info = writeRevision(root, approved);
  const { catalogue } = openCatalogue(root);

  await catalogue.reconcile(scopeConfig.id);
  const before = await catalogue.get(scopeConfig.id, noteId);
  expect(before.state).toBe('ready');
  expect(before.source.status).toBe('active');

  const replacement =
    lessonFixture.content.kind === 'lesson' ? lessonFixture.content.lesson : 'original lesson';
  const edited = info.raw.replace(replacement, 'A different lesson written after approval.');
  expect(edited).not.toBe(info.raw);
  writeRaw(root, info.path, edited);

  await catalogue.reconcile(scopeConfig.id);
  const changed = await catalogue.get(scopeConfig.id, noteId);
  expect(changed.state).toBe('manual_unreviewed');
  expect(changed.revision.status).toBe('active');
  expect(changed.source.status).toBe('candidate');
  expect(changed.source.warnings).toContain('manual_unreviewed');
});

test('does not trust a matching approval fingerprint without provenance', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const base = makeRevision({ id: noteId, status: 'active' });
  const approved: StoredRevision = {
    ...base,
    approval: {
      principal_id: nextUuid(),
      rationale: 'Approved after review.',
      payload_hash: payloadHash(base)
    }
  };
  writeRevision(root, approved);
  const { catalogue } = openCatalogue(root, null);

  await catalogue.reconcile(scopeConfig.id);
  const head = await catalogue.get(scopeConfig.id, noteId);
  expect(head.state).toBe('manual_unreviewed');
  expect(head.source.status).toBe('candidate');
  expect(head.revision.status).toBe('active');
  expect(catalogue.approvalIsValid(head.revision)).toBe(false);
});

test('trusts a matching approval fingerprint only when provenance verifies', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const base = makeRevision({ id: noteId, status: 'active' });
  const approved: StoredRevision = {
    ...base,
    approval: {
      principal_id: nextUuid(),
      rationale: 'Approved after review.',
      payload_hash: payloadHash(base)
    }
  };
  writeRevision(root, approved);

  const denied = openCatalogue(root, { verify: () => false });
  await denied.catalogue.reconcile(scopeConfig.id);
  const deniedHead = await denied.catalogue.get(scopeConfig.id, noteId);
  expect(deniedHead.state).toBe('manual_unreviewed');
  expect(deniedHead.source.status).toBe('candidate');

  const trusted = openCatalogue(root, {
    verify: (input) => input.revision_id === approved.revision_id
  });
  await trusted.catalogue.reconcile(scopeConfig.id);
  const trustedHead = await trusted.catalogue.get(scopeConfig.id, noteId);
  expect(trustedHead.state).toBe('ready');
  expect(trustedHead.source.status).toBe('active');
  expect(trusted.catalogue.approvalIsValid(trustedHead.revision)).toBe(true);
});

test('flags malformed YAML as a conflict without discarding the file', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revisionId = nextUuid();
  const raw = [
    '---',
    'title: Broken note',
    'type: lesson',
    'brain_schema_version: 1',
    `brain_id: ${noteId}`,
    `brain_revision_id: ${revisionId}`,
    'brain_scope: freellmapi',
    'brain_status: candidate',
    'broken: [unclosed',
    '---',
    '',
    '## Situation',
    '',
    'Body'
  ].join('\n');
  writeRaw(root, `freellmapi/Notes/${noteId}/broken.md`, raw);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'CONFLICT');

  const conflicts = await catalogue.list(scopeConfig.id, 'conflict');
  expect(conflicts.items).toHaveLength(0);

  const database = new Database(join(root, 'catalogue.sqlite'));
  const row = database
    .prepare("SELECT state FROM catalogue_revisions WHERE state = 'malformed'")
    .get() as { state: string } | undefined;
  expect(row?.state).toBe('malformed');
  database.close();
});

test('quarantines an unknown schema version instead of fabricating a revision', async () => {
  const root = makeVaultRoot();
  const revision = makeRevision();
  const raw = renderRevision(revision, scopeConfig).replace(
    'brain_schema_version: 1',
    'brain_schema_version: 2'
  );
  const path = relativePathFor(
    scopeConfig.relative_root,
    revision.note.content.kind,
    revision.id,
    revision.note.title,
    revision.revision_id
  );
  writeRaw(root, path, raw);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await expectBrain(catalogue.get(scopeConfig.id, revision.id), 'UNSUPPORTED_SCHEMA');

  const conflicts = await catalogue.list(scopeConfig.id, 'conflict');
  expect(conflicts.items).toHaveLength(0);

  const database = new Database(join(root, 'catalogue.sqlite'));
  const row = database
    .prepare("SELECT state FROM catalogue_revisions WHERE state = 'unsupported_schema'")
    .get() as { state: string } | undefined;
  expect(row?.state).toBe('unsupported_schema');
  database.close();
});

test('rejects a revision duplicated in two locations', async () => {
  const root = makeVaultRoot();
  const revision = makeRevision();
  const info = writeRevision(root, revision);
  writeRaw(root, `freellmapi/Notes/${revision.id}/copy.md`, info.raw);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await expectBrain(catalogue.get(scopeConfig.id, revision.id), 'CONFLICT');

  const conflicts = await catalogue.list(scopeConfig.id, 'conflict');
  expect(conflicts.items).toHaveLength(2);
});

test('reports a vault fork as a conflict instead of selecting a head', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const ancestor = makeRevision({ id: noteId });
  const ancestorInfo = writeRevision(root, ancestor);
  const leftBranch = makeRevision({
    id: noteId,
    parents: [{ revision_id: ancestor.revision_id, raw_hash: ancestorInfo.hash }]
  });
  writeRevision(root, leftBranch);
  const rightBranch = makeRevision({
    id: noteId,
    parents: [{ revision_id: ancestor.revision_id, raw_hash: ancestorInfo.hash }]
  });
  writeRevision(root, rightBranch);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'CONFLICT');

  const conflicts = await catalogue.list(scopeConfig.id, 'conflict');
  expect(conflicts.items).toHaveLength(2);

  const inspected = await catalogue.getRevision(scopeConfig.id, noteId, leftBranch.revision_id);
  expect(inspected.revision.revision_id).toBe(leftBranch.revision_id);
  expect(inspected.source.warnings).toContain('conflict');
});

test('treats the file scope as authoritative over mismatched metadata', async () => {
  const root = makeVaultRoot();
  const revision = makeRevision({ scope: sharedScope.id });
  const raw = renderRevision(revision, sharedScope);
  const path = `freellmapi/Lessons/${revision.id}/misplaced.md`;
  writeRaw(root, path, raw);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await expectBrain(catalogue.get(scopeConfig.id, revision.id), 'CONFLICT');

  const conflicts = await catalogue.list(scopeConfig.id, 'conflict');
  expect(conflicts.items).toHaveLength(1);
  expect(conflicts.items[0].warnings).toContain('scope_mismatch');
});

test('turns a changed parent payload into a revision conflict', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const parent = makeRevision({ id: noteId });
  const parentInfo = writeRevision(root, parent);
  const child = makeRevision({
    id: noteId,
    parents: [{ revision_id: parent.revision_id, raw_hash: parentInfo.hash }]
  });
  writeRevision(root, child);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  expect((await catalogue.get(scopeConfig.id, noteId)).revision.revision_id).toBe(child.revision_id);

  const edited = parentInfo.raw.replace('First-token latency', 'A different first-token account');
  writeRaw(root, parentInfo.path, edited);
  await catalogue.reconcile(scopeConfig.id);
  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'CONFLICT');
});

test('lists candidate heads separately from conflicts', async () => {
  const root = makeVaultRoot();
  const candidate = makeRevision();
  writeRevision(root, candidate);
  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);

  const candidates = await catalogue.list(scopeConfig.id, 'candidate');
  expect(candidates.items.map((item) => item.id)).toEqual([candidate.id]);
  expect(candidates.items[0].status).toBe('candidate');
  expect(await catalogue.list(scopeConfig.id, 'conflict')).toEqual({ items: [] });

  await expectBrain(catalogue.get('profile', candidate.id), 'FORBIDDEN');
  await expectBrain(catalogue.get(scopeConfig.id, nextUuid()), 'NOT_FOUND');
});

test('stores only rebuildable metadata and never copies note bodies', async () => {
  const root = makeVaultRoot();
  const revision = makeRevision();
  writeRevision(root, revision);
  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);

  const database = new Database(join(root, 'catalogue.sqlite'));
  const rows = database.prepare('SELECT * FROM catalogue_revisions').all();
  const serialized = JSON.stringify(rows);
  const body = lessonFixture.content.kind === 'lesson' ? lessonFixture.content.lesson : '';
  expect(serialized).not.toContain(body);
  expect(serialized).not.toContain('## Situation');
  expect(serialized).toContain(revision.revision_id);
  database.close();
});

test('rejects a malformed cursor instead of returning unrelated rows', async () => {
  const root = makeVaultRoot();
  writeRevision(root, makeRevision());
  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await expectBrain(catalogue.list(scopeConfig.id, 'candidate', 'not-base64!!'), 'INVALID_INPUT');
});

test('lists only the candidate head, not a candidate ancestor', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const ancestor = makeRevision({ id: noteId, status: 'candidate' });
  const ancestorInfo = writeRevision(root, ancestor);
  const head = makeRevision({
    id: noteId,
    status: 'candidate',
    parents: [{ revision_id: ancestor.revision_id, raw_hash: ancestorInfo.hash }]
  });
  writeRevision(root, head);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);

  const candidates = await catalogue.list(scopeConfig.id, 'candidate');
  expect(candidates.items).toHaveLength(1);
  expect(candidates.items[0].revision_id).toBe(head.revision_id);
});

test('detects the same revision identity filed under two scopes', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revisionId = nextUuid();
  const inScope = makeRevision({ id: noteId, revision_id: revisionId, scope: scopeConfig.id });
  const shared = makeRevision({ id: noteId, revision_id: revisionId, scope: sharedScope.id });
  writeRevision(root, inScope);
  const sharedPath = relativePathFor(
    sharedScope.relative_root,
    shared.note.content.kind,
    shared.id,
    shared.note.title,
    shared.revision_id
  );
  writeRaw(root, sharedPath, renderRevision(shared, sharedScope));

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(sharedScope.id);

  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'CONFLICT');
  await expectBrain(catalogue.get(sharedScope.id, noteId), 'CONFLICT');
  const conflicts = await catalogue.list(scopeConfig.id, 'conflict');
  expect(conflicts.items).toHaveLength(1);
  expect(conflicts.items[0].warnings).toContain('duplicate_identity');
});

test('keeps a cross-scope duplicate conflict while both scopes still hold it', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revisionId = nextUuid();
  const inScope = makeRevision({ id: noteId, revision_id: revisionId, scope: scopeConfig.id });
  const shared = makeRevision({ id: noteId, revision_id: revisionId, scope: sharedScope.id });
  writeRevision(root, inScope);
  writeRaw(
    root,
    relativePathFor(
      sharedScope.relative_root,
      shared.note.content.kind,
      shared.id,
      shared.note.title,
      shared.revision_id
    ),
    renderRevision(shared, sharedScope)
  );

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(sharedScope.id);
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(sharedScope.id);

  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'CONFLICT');
  await expectBrain(catalogue.get(sharedScope.id, noteId), 'CONFLICT');
  expect((await catalogue.list(scopeConfig.id, 'conflict')).items).toHaveLength(1);
  expect((await catalogue.list(sharedScope.id, 'conflict')).items).toHaveLength(1);
  expect((await catalogue.list(scopeConfig.id, 'candidate')).items).toHaveLength(0);
  expect((await catalogue.list(sharedScope.id, 'candidate')).items).toHaveLength(0);
});

test('clears a cross-scope duplicate conflict after the duplicate is removed and rescanned', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revisionId = nextUuid();
  const inScope = makeRevision({ id: noteId, revision_id: revisionId, scope: scopeConfig.id });
  const shared = makeRevision({ id: noteId, revision_id: revisionId, scope: sharedScope.id });
  const inScopeFile = writeRevision(root, inScope);
  writeRaw(
    root,
    relativePathFor(
      sharedScope.relative_root,
      shared.note.content.kind,
      shared.id,
      shared.note.title,
      shared.revision_id
    ),
    renderRevision(shared, sharedScope)
  );

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(sharedScope.id);
  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'CONFLICT');
  await expectBrain(catalogue.get(sharedScope.id, noteId), 'CONFLICT');

  rmSync(join(root, inScopeFile.path), { force: true });
  await catalogue.reconcile(scopeConfig.id);

  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'NOT_FOUND');
  const surviving = await catalogue.get(sharedScope.id, noteId);
  expect(surviving.revision.revision_id).toBe(revisionId);
  expect(surviving.state).toBe('ready');
  expect(surviving.source.status).toBe('candidate');
  expect((await catalogue.list(sharedScope.id, 'conflict')).items).toHaveLength(0);
  expect((await catalogue.list(sharedScope.id, 'candidate')).items).toHaveLength(1);

  const database = new Database(join(root, 'catalogue.sqlite'));
  const row = database
    .prepare('SELECT state, is_head FROM catalogue_revisions WHERE scope = ?')
    .get(sharedScope.id) as { state: string; is_head: number };
  expect(row).toEqual({ state: 'ready', is_head: 1 });
  database.close();
});

test('normalizes a legacy persisted cross-scope duplicate marker once the duplicate is gone', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revisionId = nextUuid();
  const inScope = makeRevision({ id: noteId, revision_id: revisionId, scope: scopeConfig.id });
  const shared = makeRevision({ id: noteId, revision_id: revisionId, scope: sharedScope.id });
  const inScopeFile = writeRevision(root, inScope);
  writeRaw(
    root,
    relativePathFor(
      sharedScope.relative_root,
      shared.note.content.kind,
      shared.id,
      shared.note.title,
      shared.revision_id
    ),
    renderRevision(shared, sharedScope)
  );

  const { catalogue } = openCatalogue(root);
  const databasePath = join(root, 'catalogue.sqlite');
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(sharedScope.id);

  const seed = new Database(databasePath);
  seed
    .prepare(
      `UPDATE catalogue_revisions
       SET state = 'conflict', is_head = 0, warnings_json = '["duplicate_identity","conflict"]'
       WHERE scope = ?`
    )
    .run(sharedScope.id);
  seed.close();
  const seeded = new Database(databasePath);
  expect(
    seeded.prepare('SELECT state, is_head FROM catalogue_revisions WHERE scope = ?').get(sharedScope.id)
  ).toEqual({ state: 'conflict', is_head: 0 });
  seeded.close();

  rmSync(join(root, inScopeFile.path), { force: true });
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(scopeConfig.id);

  const normalized = new Database(databasePath);
  expect(
    normalized
      .prepare('SELECT state, is_head, warnings_json FROM catalogue_revisions WHERE scope = ?')
      .get(sharedScope.id)
  ).toEqual({ state: 'ready', is_head: 1, warnings_json: '[]' });
  normalized.close();

  const survived = await catalogue.get(sharedScope.id, noteId);
  expect(survived.state).toBe('ready');
  expect(survived.source.status).toBe('candidate');
  const candidates = await catalogue.list(sharedScope.id, 'candidate');
  expect(candidates.items.map((item) => item.revision_id)).toEqual([revisionId]);
  expect(await catalogue.list(sharedScope.id, 'conflict')).toEqual({ items: [] });
  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'NOT_FOUND');
});

test('restores manual_unreviewed after normalizing a legacy cross-scope duplicate marker', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revisionId = nextUuid();
  const inScope = makeRevision({ id: noteId, revision_id: revisionId, scope: scopeConfig.id });
  const sharedBase = makeRevision({
    id: noteId,
    revision_id: revisionId,
    scope: sharedScope.id,
    status: 'active'
  });
  const shared: StoredRevision = {
    ...sharedBase,
    approval: {
      principal_id: nextUuid(),
      rationale: 'Approval no longer matches the payload.',
      payload_hash: '0'.repeat(64)
    }
  };
  const inScopeFile = writeRevision(root, inScope);
  writeRaw(
    root,
    relativePathFor(
      sharedScope.relative_root,
      shared.note.content.kind,
      shared.id,
      shared.note.title,
      shared.revision_id
    ),
    renderRevision(shared, sharedScope)
  );

  const { catalogue } = openCatalogue(root);
  const databasePath = join(root, 'catalogue.sqlite');
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(sharedScope.id);

  const seed = new Database(databasePath);
  seed
    .prepare(
      `UPDATE catalogue_revisions
       SET state = 'conflict', is_head = 0,
           warnings_json = '["duplicate_identity","conflict","manual_unreviewed"]'
       WHERE scope = ?`
    )
    .run(sharedScope.id);
  seed.close();

  rmSync(join(root, inScopeFile.path), { force: true });
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(scopeConfig.id);

  const normalized = new Database(databasePath);
  expect(
    normalized
      .prepare('SELECT state, is_head, warnings_json FROM catalogue_revisions WHERE scope = ?')
      .get(sharedScope.id)
  ).toEqual({
    state: 'manual_unreviewed',
    is_head: 1,
    warnings_json: '["manual_unreviewed"]'
  });
  normalized.close();

  const survived = await catalogue.get(sharedScope.id, noteId);
  expect(survived.state).toBe('manual_unreviewed');
  expect(survived.source.status).toBe('candidate');
  expect(survived.source.warnings).toEqual(['manual_unreviewed']);
  expect((await catalogue.list(sharedScope.id, 'candidate')).items).toHaveLength(1);
  expect(await catalogue.list(sharedScope.id, 'conflict')).toEqual({ items: [] });
});

test('recomputes a normalized head within its persisted logical-id graph', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revisionId = nextUuid();
  const inScope = makeRevision({ id: noteId, revision_id: revisionId, scope: scopeConfig.id });
  const shared = makeRevision({ id: noteId, revision_id: revisionId, scope: sharedScope.id });
  const inScopeFile = writeRevision(root, inScope);
  const sharedRaw = renderRevision(shared, sharedScope);
  writeRaw(
    root,
    relativePathFor(
      sharedScope.relative_root,
      shared.note.content.kind,
      shared.id,
      shared.note.title,
      shared.revision_id
    ),
    sharedRaw
  );
  const unrelatedChild = makeRevision({
    scope: sharedScope.id,
    parents: [{ revision_id: revisionId, raw_hash: hashRaw(sharedRaw) }]
  });
  writeRaw(
    root,
    relativePathFor(
      sharedScope.relative_root,
      unrelatedChild.note.content.kind,
      unrelatedChild.id,
      unrelatedChild.note.title,
      unrelatedChild.revision_id
    ),
    renderRevision(unrelatedChild, sharedScope)
  );

  const { catalogue } = openCatalogue(root);
  const databasePath = join(root, 'catalogue.sqlite');
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(sharedScope.id);

  const seed = new Database(databasePath);
  seed
    .prepare(
      `UPDATE catalogue_revisions
       SET state = 'conflict', is_head = 0, warnings_json = '["duplicate_identity","conflict"]'
       WHERE scope = ? AND revision_id = ?`
    )
    .run(sharedScope.id, revisionId);
  seed.close();

  rmSync(join(root, inScopeFile.path), { force: true });
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(scopeConfig.id);

  const normalized = new Database(databasePath);
  expect(
    normalized
      .prepare(
        'SELECT state, is_head, warnings_json FROM catalogue_revisions WHERE scope = ? AND revision_id = ?'
      )
      .get(sharedScope.id, revisionId)
  ).toEqual({ state: 'ready', is_head: 1, warnings_json: '[]' });
  normalized.close();
});

test('keeps a genuine cross-scope duplicate marker conflicted while both scopes hold it', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revisionId = nextUuid();
  const inScope = makeRevision({ id: noteId, revision_id: revisionId, scope: scopeConfig.id });
  const shared = makeRevision({ id: noteId, revision_id: revisionId, scope: sharedScope.id });
  writeRevision(root, inScope);
  writeRaw(
    root,
    relativePathFor(
      sharedScope.relative_root,
      shared.note.content.kind,
      shared.id,
      shared.note.title,
      shared.revision_id
    ),
    renderRevision(shared, sharedScope)
  );

  const { catalogue } = openCatalogue(root);
  const databasePath = join(root, 'catalogue.sqlite');
  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(sharedScope.id);

  const seed = new Database(databasePath);
  seed
    .prepare(
      `UPDATE catalogue_revisions
       SET state = 'conflict', is_head = 0, warnings_json = '["duplicate_identity","conflict"]'
       WHERE scope = ?`
    )
    .run(sharedScope.id);
  seed.close();

  await catalogue.reconcile(scopeConfig.id);
  await catalogue.reconcile(scopeConfig.id);

  const kept = new Database(databasePath);
  expect(
    kept.prepare('SELECT state, is_head FROM catalogue_revisions WHERE scope = ?').get(sharedScope.id)
  ).toEqual({ state: 'conflict', is_head: 0 });
  kept.close();

  await expectBrain(catalogue.get(sharedScope.id, noteId), 'CONFLICT');
  const conflicts = await catalogue.list(sharedScope.id, 'conflict');
  expect(conflicts.items).toHaveLength(1);
  expect(conflicts.items[0].warnings).toContain('duplicate_identity');
  expect((await catalogue.list(sharedScope.id, 'candidate')).items).toHaveLength(0);
});

test('returns a conflicted head when a parseable revision has a malformed duplicate', async () => {
  const root = makeVaultRoot();
  const noteId = nextUuid();
  const revision = makeRevision({ id: noteId });
  writeRevision(root, revision);
  const malformed = [
    '---',
    'title: Broken duplicate',
    'type: lesson',
    'brain_schema_version: 1',
    `brain_id: ${noteId}`,
    'brain_scope: freellmapi',
    'brain_status: candidate',
    'broken: [unclosed',
    '---',
    '',
    '## Situation',
    '',
    'Body'
  ].join('\n');
  writeRaw(root, `freellmapi/Notes/${noteId}/broken.md`, malformed);

  const { catalogue } = openCatalogue(root);
  await catalogue.reconcile(scopeConfig.id);
  await expectBrain(catalogue.get(scopeConfig.id, noteId), 'CONFLICT');

  const inspected = await catalogue.getRevision(scopeConfig.id, noteId, revision.revision_id);
  expect(inspected.revision.revision_id).toBe(revision.revision_id);
  expect(inspected.state).toBe('conflict');
  expect(inspected.source.warnings).toContain('conflict');
  expect(inspected.source.warnings).toContain('malformed');
});
