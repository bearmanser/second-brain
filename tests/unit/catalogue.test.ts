import { afterEach, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BrainError, type BrainErrorCode } from '../../src/contracts/errors.js';
import type { ScopeConfig, StoredRevision } from '../../src/core/types.js';
import { makeEtag, payloadHash, renderRevision } from '../../src/notes/codec.js';
import { hashRaw, relativePathFor } from '../../src/notes/identity.js';
import { RevisionCatalogue, resolveHead, type ParsedRevision } from '../../src/notes/catalogue.js';
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

const openCatalogue = (root: string): { vault: FileVault; catalogue: RevisionCatalogue } => {
  const vault = new FileVault(root, [scopeConfig, sharedScope]);
  const catalogue = RevisionCatalogue.open(join(root, 'catalogue.sqlite'), {
    vault,
    scopes: [scopeConfig, sharedScope]
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
  expect(versions).toEqual([{ version: 1 }, { version: 2 }]);
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
  expect(conflicts.items).toHaveLength(1);
  expect(conflicts.items[0].warnings).toContain('malformed');
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
  expect(conflicts.items).toHaveLength(1);
  expect(conflicts.items[0].warnings).toContain('unsupported_schema');
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
