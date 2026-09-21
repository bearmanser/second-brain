import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BrainError, type BrainErrorCode } from '../../src/contracts/errors.js';
import type { ScopeConfig, StoredRevision, VaultPort } from '../../src/core/types.js';
import { relativePathFor } from '../../src/notes/identity.js';
import {
  CURRENT_SCHEMA_VERSION,
  SchemaVersionRegistry,
  decodeRevision,
  payloadHash,
  renderRevision,
  type SchemaVersionTransform
} from '../../src/notes/codec.js';
import { migrateSchemaRevision, reconcileVault } from '../../src/notes/reconcile.js';
import {
  createCandidateIntent,
  createHarness,
  startHttpHarness,
  type MemoryHarness
} from '../support/harness.js';
import { lessonFixture } from '../fixtures/content.js';
import {
  ownerPrincipal,
  reviewerContext,
  reviewerPrincipal,
  workerPrincipal
} from '../fixtures/principals.js';

const MANUAL_CASES = join('tests', 'fixtures', 'vault', 'manual-cases');
const SCOPE = 'freellmapi';

const harnesses: MemoryHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness !== undefined) await harness.close().catch(() => undefined);
  }
});

async function openHarness(): Promise<MemoryHarness> {
  const harness = await createHarness();
  harnesses.push(harness);
  return harness;
}

async function manualCase(name: string): Promise<string> {
  return readFile(join(MANUAL_CASES, name), 'utf8');
}

function scopeOf(harness: MemoryHarness, id: string): ScopeConfig {
  const scope = harness.deps.config.scopes.find((candidate) => candidate.id === id);
  if (scope === undefined) throw new Error(`unknown scope ${id}`);
  return scope;
}

async function placeFixture(
  harness: MemoryHarness,
  relativePath: string,
  contents: string
): Promise<string> {
  const absolute = join(harness.deps.config.mounts.vault, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
  return absolute;
}

async function expectCode(
  action: Promise<unknown>,
  code: BrainErrorCode
): Promise<BrainError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).code).toBe(code);
    return error as BrainError;
  }
  throw new Error(`expected BrainError ${code} but the action resolved`);
}

test('manual content changes do not retain an unchanged approval claim', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await h.externalEdit(head, (raw) =>
    raw.replace(
      'Measure the direct and proxied request with the same prompt',
      'Measure only the direct request without a proxy'
    )
  );
  await h.deps.catalogue.reconcile('freellmapi');
  const changed = await h.deps.catalogue.get('freellmapi', head.source.id);
  expect(changed.state).toBe('manual_unreviewed');
  expect(changed.source.warnings).toContain('manual_unreviewed');
});

test('reconcileVault reports every report field and authorized detailed ids', async () => {
  const h = await openHarness();
  const scope = scopeOf(h, SCOPE);
  await placeFixture(
    h,
    `${scope.relative_root}/Lessons/0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d/managed.md`,
    await manualCase('managed-lesson.md')
  );
  await placeFixture(
    h,
    `${scope.relative_root}/Lessons/broken/malformed.md`,
    await manualCase('malformed-frontmatter.md')
  );
  await placeFixture(
    h,
    `${scope.relative_root}/Lessons/future/future.md`,
    await manualCase('future-schema.md')
  );
  await placeFixture(
    h,
    `${scope.relative_root}/Notes/unmanaged.md`,
    await manualCase('unmanaged-obsidian.md')
  );
  await placeFixture(h, `${scope.relative_root}/Notes/attachment.txt`, 'not markdown');

  const report = await reconcileVault(h.deps, SCOPE, {
    detailed: true,
    principal: ownerPrincipal
  });
  expect(report.scopes).toEqual([SCOPE]);
  expect(report.scanned).toBe(3);
  expect(report.updated).toBe(3);
  expect(report.unmanaged).toBe(2);
  expect(report.malformed).toBe(1);
  expect(report.conflicted).toBe(0);
  expect(report.manual_unreviewed).toBe(0);
  expect(report.unsupported_schema).toBe(1);
  expect(report.ids?.unsupported_schema).toEqual(['1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d']);
  expect(report.ids?.malformed).toEqual(['9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a']);
  expect(report.findings).toHaveLength(2);

  const again = await reconcileVault(h.deps, SCOPE);
  expect(again.updated).toBe(0);
  expect(again.findings).toBeUndefined();
});

test('reconciliation does not refresh observed_at for an unchanged file', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const database = new Database(
    join(h.deps.config.mounts.state, 'catalogue.db'),
    { readonly: true }
  );
  try {
    const readObserved = (): string =>
      (
        database
          .prepare(
            'SELECT observed_at FROM catalogue_revisions WHERE scope = ? AND relative_path = ?'
          )
          .get(SCOPE, head.source.relative_path) as { observed_at: string }
      ).observed_at;
    const before = readObserved();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const report = await reconcileVault(h.deps, SCOPE);
    expect(report.updated).toBe(0);
    expect(readObserved()).toBe(before);
  } finally {
    database.close();
  }
});

test('a changed current head becomes manual_unreviewed with candidate-effective status', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await h.externalEdit(head, (raw) =>
    raw.replace(/^brain_title: .*$/m, 'brain_title: Compare only the proxy')
  );
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.manual_unreviewed).toBe(1);
  const changed = await h.deps.catalogue.get(SCOPE, head.source.id);
  expect(changed.state).toBe('manual_unreviewed');
  expect(changed.source.status).toBe('candidate');
  expect(changed.revision.status).toBe('active');
});

test('an added section is preserved and flagged as manual_unreviewed', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await h.externalEdit(head, (raw) => `${raw}\n## Notes\n\nHuman-added notes.\n`);
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.manual_unreviewed).toBe(1);
  const changed = await h.deps.catalogue.get(SCOPE, head.source.id);
  expect(changed.state).toBe('manual_unreviewed');
  expect(changed.revision.extra_markdown).toContain('Human-added notes.');
});

test('a CRLF-only rewrite keeps the approval fingerprint valid', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await h.externalEdit(head, (raw) => raw.replace(/\n/g, '\r\n'));
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.manual_unreviewed).toBe(0);
  const changed = await h.deps.catalogue.get(SCOPE, head.source.id);
  expect(changed.state).toBe('ready');
  expect(changed.source.status).toBe('active');
  expect(changed.raw_hash).not.toBe(head.raw_hash);
  expect(changed.source.etag).not.toBe(head.source.etag);
});

test('renaming a file with valid identity updates the catalogue path', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const vault = h.deps.config.mounts.vault;
  const renamed = head.source.relative_path.replace(/\.md$/, '-renamed.md');
  await rename(join(vault, head.source.relative_path), join(vault, renamed));
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.scanned).toBe(1);
  expect(report.conflicted).toBe(0);
  const current = await h.deps.catalogue.get(SCOPE, head.source.id);
  expect(current.source.relative_path).toBe(renamed);
  expect(current.raw_hash).toBe(head.raw_hash);
});

test('a duplicated identity in two locations is a conflict, not a new note', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const vault = h.deps.config.mounts.vault;
  await cp(
    join(vault, head.source.relative_path),
    join(vault, head.source.relative_path.replace(/\.md$/, '-copy.md'))
  );
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.conflicted).toBe(2);
  expect(report.manual_unreviewed).toBe(0);
  await expectCode(h.deps.catalogue.get(SCOPE, head.source.id), 'CONFLICT');
});

test('a deleted file is removed from the catalogue without inventing a note', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await rm(join(h.deps.config.mounts.vault, head.source.relative_path));
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.scanned).toBe(0);
  expect(report.updated).toBe(1);
  await expectCode(h.deps.catalogue.get(SCOPE, head.source.id), 'NOT_FOUND');
});

test('a changed historical parent with children becomes a revision conflict', async () => {
  const h = await openHarness();
  const root = await h.seed(lessonFixture, { status: 'active' });
  const child = createCandidateIntent(
    { ...lessonFixture, title: 'Child lesson' },
    {
      idempotency_key: randomUUID(),
      expected_heads: [{ id: root.source.id, etag: root.source.etag }]
    }
  );
  const receipt = await h.deps.mutations.commit(reviewerContext, child.intent, child.build);
  expect(receipt.outcome).toBe('stored');

  await h.externalEdit(root, (raw) =>
    raw.replace('Measure the direct and proxied request', 'Measure only the direct request')
  );
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.conflicted).toBeGreaterThanOrEqual(1);
  expect(report.manual_unreviewed).toBe(1);
  const error = await expectCode(h.deps.catalogue.get(SCOPE, root.source.id), 'CONFLICT');
  expect(error.message).toMatch(/parent_hash_mismatch/);
});

test('a human edit during agent submission retains both files', async () => {
  const h = await openHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const request = createCandidateIntent(lessonFixture, {
    idempotency_key: randomUUID(),
    expected_heads: [{ id: head.source.id, etag: head.source.etag }]
  });
  h.backend.on_create = async () => {
    await h.externalEdit(head, (raw) =>
      raw.replace(
        'Measure the direct and proxied request with the same prompt',
        'Measure only the direct request without a proxy'
      )
    );
  };
  const receipt = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
  expect(receipt.outcome).toBe('stored_conflict');
  expect(receipt.materialized).toBe(true);
  expect(receipt.warnings).toContain('parent_changed');
  expect((await h.deps.vault.list(SCOPE)).length).toBe(2);
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.manual_unreviewed).toBe(1);
  expect(report.conflicted).toBeGreaterThanOrEqual(1);
});

test('malformed YAML is reported and never decoded', async () => {
  const h = await openHarness();
  const scope = scopeOf(h, SCOPE);
  const absolute = await placeFixture(
    h,
    `${scope.relative_root}/Lessons/broken/malformed.md`,
    await manualCase('malformed-frontmatter.md')
  );
  const report = await reconcileVault(h.deps, SCOPE, { detailed: true });
  expect(report.malformed).toBe(1);
  expect(report.unsupported_schema).toBe(0);
  expect(report.findings?.[0]?.relative_path).toContain('malformed.md');
  await expectCode(
    h.deps.catalogue.get(SCOPE, '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a'),
    'CONFLICT'
  );
  expect(await readFile(absolute, 'utf8')).toContain('[unclosed');
});

test('headings inside code fences stay in the body', async () => {
  const h = await openHarness();
  const scope = scopeOf(h, SCOPE);
  await placeFixture(
    h,
    `${scope.relative_root}/Notes/fenced/fenced.md`,
    await manualCase('fenced-headings.md')
  );
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.malformed).toBe(0);
  expect(report.conflicted).toBe(0);
  const head = await h.deps.catalogue.get(SCOPE, '3c4d5e6f-7081-4c9d-8e0f-1a2b3c4d5e6f');
  expect(head.state).toBe('ready');
  expect(head.revision.note.content.kind).toBe('note');
  const content = head.revision.note.content as { body_markdown: string };
  expect(content.body_markdown).toContain('## Evidence');
  expect(content.body_markdown).toContain('must not be parsed as a section');
  expect(head.revision.note.evidence).toHaveLength(1);
});

test('a future schema version is quarantined and never coerced', async () => {
  const h = await openHarness();
  const scope = scopeOf(h, SCOPE);
  const raw = await manualCase('future-schema.md');
  const absolute = await placeFixture(h, `${scope.relative_root}/Lessons/future/future.md`, raw);
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.unsupported_schema).toBe(1);
  expect(report.malformed).toBe(0);
  expect(report.conflicted).toBe(0);
  await expectCode(
    h.deps.catalogue.get(SCOPE, '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'),
    'UNSUPPORTED_SCHEMA'
  );
  expect((await h.deps.catalogue.list(SCOPE, 'conflict')).items).toHaveLength(0);
  expect(await readFile(absolute, 'utf8')).toBe(raw);
});

const versionZeroRaw = async (): Promise<string> =>
  (await manualCase('managed-lesson.md')).replace(
    `brain_schema_version: ${CURRENT_SCHEMA_VERSION}`,
    'brain_schema_version: 0'
  );

const versionZeroTransform: SchemaVersionTransform = {
  from: 0,
  to: CURRENT_SCHEMA_VERSION,
  apply: ({ frontmatter, body }) => ({
    frontmatter: { ...frontmatter, brain_schema_version: CURRENT_SCHEMA_VERSION },
    body
  })
};

test('ordinary decode and reconciliation never reinterpret an old schema version', async () => {
  const h = await openHarness();
  const scope = scopeOf(h, SCOPE);
  const raw = await versionZeroRaw();
  const registry = new SchemaVersionRegistry();
  registry.register(versionZeroTransform);

  const version = await expectCode(
    Promise.resolve().then(() => decodeRevision(raw)),
    'INVALID_INPUT'
  );
  expect(version.message).toMatch(/brain_schema_version/);
  expect(registry.support()).toEqual({ current: CURRENT_SCHEMA_VERSION, transforms: [0] });

  const absolute = await placeFixture(h, `${scope.relative_root}/Lessons/old/old.md`, raw);
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.malformed).toBe(1);
  expect(report.unsupported_schema).toBe(0);
  expect(await readFile(absolute, 'utf8')).toBe(raw);
});

test('an explicit migration writes a new revision and keeps the original', async () => {
  const h = await openHarness();
  const scope = scopeOf(h, SCOPE);
  const raw = await versionZeroRaw();
  const relativePath = `${scope.relative_root}/Lessons/old/old.md`;
  const original = await placeFixture(h, relativePath, raw);
  const registry = new SchemaVersionRegistry();
  registry.register(versionZeroTransform);

  const revisionId = randomUUID();
  const result = await migrateSchemaRevision(h.deps, SCOPE, {
    relative_path: relativePath,
    revision_id: revisionId,
    operation_id: randomUUID(),
    timestamp: '2026-09-21T00:00:00Z',
    registry
  });

  expect(result.plan.from_version).toBe(0);
  expect(result.plan.revision.id).toBe('0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d');
  expect(result.plan.revision.revision_id).toBe(revisionId);
  expect(result.plan.revision.parents).toEqual([]);
  expect(result.plan.migrated_from.revision_id).toBe(
    '1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
  );
  expect(await readFile(original, 'utf8')).toBe(raw);

  const migratedPath = relativePathFor(
    scope.relative_root,
    'lesson',
    result.plan.revision.id,
    result.plan.revision.note.title,
    revisionId
  );
  const migratedRaw = await readFile(join(h.deps.config.mounts.vault, migratedPath), 'utf8');
  const decoded = decodeRevision(migratedRaw);
  expect(decoded.id).toBe(result.plan.revision.id);
  expect(decoded.revision_id).toBe(revisionId);
  expect(decoded.extra_frontmatter.brain_migrated_from).toEqual({
    revision_id: '1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    raw_hash: result.plan.migrated_from.raw_hash,
    schema_version: 0
  });
});

test('unmanaged Obsidian files are counted but never imported', async () => {
  const h = await openHarness();
  const scope = scopeOf(h, SCOPE);
  await placeFixture(
    h,
    `${scope.relative_root}/Notes/unmanaged.md`,
    await manualCase('unmanaged-obsidian.md')
  );
  await placeFixture(h, `${scope.relative_root}/Notes/attachment.txt`, 'not markdown');
  const report = await reconcileVault(h.deps, SCOPE);
  expect(report.unmanaged).toBe(2);
  expect(report.scanned).toBe(0);
  expect((await h.deps.catalogue.list(SCOPE, 'candidate')).items).toHaveLength(0);
  expect((await h.deps.catalogue.list(SCOPE, 'conflict')).items).toHaveLength(0);
});

test('detailed ids are filtered to readable scopes while counts stay scoped', async () => {
  const h = await openHarness();
  const freellmapi = scopeOf(h, SCOPE);
  const profile = scopeOf(h, 'profile');
  await placeFixture(
    h,
    `${freellmapi.relative_root}/broken/a.md`,
    await manualCase('malformed-frontmatter.md')
  );
  const profileRaw = (await manualCase('malformed-frontmatter.md')).replace(
    '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a',
    '8e7d6c5b-4a39-4270-9160-5f4e3d2c1b0a'
  );
  await placeFixture(h, `${profile.relative_root}/broken/b.md`, profileRaw);

  const internal = await reconcileVault(h.deps, undefined, { detailed: true });
  expect(internal.ids?.malformed).toEqual(
    expect.arrayContaining([
      '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a',
      '8e7d6c5b-4a39-4270-9160-5f4e3d2c1b0a'
    ])
  );

  const worker = await reconcileVault(h.deps, undefined, {
    detailed: true,
    principal: workerPrincipal
  });
  expect(worker.malformed).toBe(2);
  expect(worker.ids?.malformed).toEqual(['9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a']);
});

test('an approval fingerprint without authenticated journal provenance is untrusted', async () => {
  const h = await startHttpHarness();
  try {
    const scope = h.config.scopes.find((candidate) => candidate.id === SCOPE);
    if (scope === undefined) throw new Error('missing scope');
    const base: StoredRevision = {
      id: randomUUID(),
      revision_id: randomUUID(),
      parents: [],
      scope: SCOPE,
      status: 'active',
      note: lessonFixture,
      created_at: '2026-09-01T00:00:00Z',
      modified_at: '2026-09-01T00:05:00Z',
      operation_id: randomUUID(),
      extra_frontmatter: {},
      extra_markdown: ''
    };
    const revision: StoredRevision = {
      ...base,
      approval: {
        principal_id: reviewerPrincipal.id,
        rationale: 'forged without a journal record',
        payload_hash: payloadHash(base)
      }
    };
    const relativePath = relativePathFor(
      scope.relative_root,
      'lesson',
      revision.id,
      revision.note.title,
      revision.revision_id
    );
    await mkdir(dirname(join(h.config.mounts.vault, relativePath)), { recursive: true });
    await writeFile(
      join(h.config.mounts.vault, relativePath),
      renderRevision(revision, scope),
      'utf8'
    );
    await h.runtime.deps.catalogue.reconcile(SCOPE);
    const head = await h.runtime.deps.catalogue.get(SCOPE, revision.id);
    expect(head.state).toBe('manual_unreviewed');
    expect(head.source.status).toBe('candidate');
  } finally {
    await h.close();
  }
});

test('removing approval fields from an active revision makes it candidate-effective', async () => {
  const h = await openHarness();
  const active = await h.seed(lessonFixture, { status: 'active' });
  await h.externalEdit(active, (raw) =>
    raw
      .split('\n')
      .filter((line) => !line.startsWith('brain_approv'))
      .join('\n')
  );
  await h.deps.catalogue.reconcile(SCOPE);
  const changed = await h.deps.catalogue.get(SCOPE, active.source.id);
  expect(changed.state).toBe('manual_unreviewed');
  expect(changed.source.status).toBe('candidate');
  expect(changed.source.warnings).toContain('manual_unreviewed');
});

test('changing a candidate status to active without approval remains candidate-effective', async () => {
  const h = await openHarness();
  const candidate = await h.seed(lessonFixture, { status: 'candidate' });
  await h.externalEdit(candidate, (raw) => raw.replace('brain_status: candidate', 'brain_status: active'));
  await h.deps.catalogue.reconcile(SCOPE);
  const changed = await h.deps.catalogue.get(SCOPE, candidate.source.id);
  expect(changed.state).toBe('manual_unreviewed');
  expect(changed.source.status).toBe('candidate');
});

test('a host edit is visible without a restart and periodic scans stay bounded', async () => {
  const h = await startHttpHarness({ reconcile_interval_ms: 25 });
  const worker = await h.connect(h.token, 'host-edit-worker');
  const reviewer = await h.connect(h.reviewerToken, 'host-edit-reviewer');
  const scans = (): number =>
    h.loggedDiagnostics().filter((line) => line.startsWith('reconciled ')).length;
  try {
    expect(scans()).toBeGreaterThanOrEqual(1);

    const captured = await worker.callTool({
      name: 'brain_capture',
      arguments: { idempotency_key: randomUUID(), scope: SCOPE, note: lessonFixture }
    });
    const receipt = (captured as { structuredContent: Record<string, unknown> })
      .structuredContent;
    const firstRead = await worker.callTool({
      name: 'brain_read',
      arguments: { scope: SCOPE, id: receipt.id as string }
    });
    const source = (
      (firstRead as { structuredContent: Record<string, unknown> }).structuredContent
        .source as Record<string, unknown>
    );
    await reviewer.callTool({
      name: 'brain_review',
      arguments: {
        scope: SCOPE,
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: receipt.id as string,
          expected_etag: source.etag as string,
          rationale: 'Approve so the host edit can invalidate the fingerprint'
        }
      }
    });

    const approvedRead = await worker.callTool({
      name: 'brain_read',
      arguments: { scope: SCOPE, id: receipt.id as string }
    });
    const approvedSource = (
      (approvedRead as { structuredContent: Record<string, unknown> }).structuredContent
        .source as Record<string, unknown>
    );
    expect(approvedSource.status).toBe('active');

    const absolute = join(h.config.mounts.vault, approvedSource.relative_path as string);
    const before = await readFile(absolute, 'utf8');
    const beforeScans = scans();
    await writeFile(
      absolute,
      before.replace(
        'Measure the direct and proxied request with the same prompt',
        'Measure only the direct request without a proxy'
      ),
      'utf8'
    );
    const deadline = Date.now() + 5000;
    while (scans() <= beforeScans && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(scans()).toBeGreaterThan(beforeScans);

    const finalRead = await worker.callTool({
      name: 'brain_read',
      arguments: { scope: SCOPE, id: receipt.id as string }
    });
    const structured = (finalRead as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(structured.markdown as string).toContain('Measure only the direct request without a proxy');
    const finalSource = structured.source as Record<string, unknown>;
    expect(finalSource.warnings as string[]).toContain('manual_unreviewed');
  } finally {
    await worker.close();
    await reviewer.close();
    await h.close();
  }
});

test('startup fails when the initial full scan cannot enumerate the vault', async () => {
  const failingVault: VaultPort = {
    list: async () => {
      throw new BrainError({
        code: 'RECOVERY_REQUIRED',
        message: 'simulated vault enumeration failure'
      });
    },
    read: async () => {
      throw new BrainError({ code: 'NOT_FOUND', message: 'simulated vault read failure' });
    }
  };
  await expect(startHttpHarness({ vault: failingVault })).rejects.toThrow(
    /simulated vault enumeration failure/
  );
});
