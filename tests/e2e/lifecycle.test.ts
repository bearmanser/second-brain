import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { verifyManifest } from '../../src/operations/backup.js';
import { recoverPending } from '../../src/operations/recovery.js';
import { lessonFixture } from '../fixtures/content.js';
import { reviewerContext } from '../fixtures/principals.js';
import {
  createCandidateIntent,
  createHarness,
  makeBackupFixture,
  startDockerHarness,
  type DockerHarness,
  type DockerToolResponse,
  type MemoryHarness
} from '../support/harness.js';

const DOCKER_TIMEOUT = 2_400_000;

const UNICODE_LESSON = 'Ünicode café 漢字 🧠 e\u0301 — preserved';

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function recallWhenReady(
  h: DockerHarness,
  principalId: string,
  scope: string,
  query: string,
  attempts = 45
): Promise<DockerToolResponse> {
  let last: DockerToolResponse | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await h.recallAs(principalId, scope, query);
    if (!last.isError) return last;
    await pause(2_000);
  }
  return last as DockerToolResponse;
}

async function readUntilSettled(
  h: DockerHarness,
  id: string,
  attempts = 10
): Promise<DockerToolResponse> {
  let last: DockerToolResponse | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await h.callAs('project-reviewer', 'brain_read', { scope: 'freellmapi', id });
    if (!last.isError) return last;
    await pause(1_000);
  }
  return last as DockerToolResponse;
}

function lessonNote(title: string, lesson: string, tag = 'lifecycle'): unknown {
  return {
    title,
    tags: [tag],
    content: {
      kind: 'lesson',
      situation: 'A lifecycle scenario exercises materialization and authority.',
      lesson,
      applicability: 'Synthetic release-candidate lifecycle verification.'
    },
    evidence: [
      { kind: 'observation', ref: 'lifecycle-e2e', description: 'synthetic lifecycle fixture' }
    ],
    related_ids: []
  };
}

async function approveNote(
  h: DockerHarness,
  scope: string,
  principalId: string,
  note: unknown
): Promise<{ id: string; revision_id: string; etag: string }> {
  const candidate = await h.seedNote(principalId, scope, note);
  expect(candidate.etag).toBeDefined();
  const approved = await h.approveAs(
    principalId,
    scope,
    candidate.id,
    candidate.etag as string,
    'synthetic lifecycle approval'
  );
  expect(approved.isError).toBe(false);
  const structured = approved.structured as { id: string; revision_id: string; etag: string };
  expect(typeof structured.etag).toBe('string');
  return { id: structured.id, revision_id: structured.revision_id, etag: structured.etag };
}

describe('release-candidate lifecycle (real Docker gateway)', () => {
  let h: DockerHarness;

  beforeAll(async () => {
    h = await startDockerHarness();
    await recallWhenReady(h, 'owner', 'profile', 'warm the embedding model', 30);
  }, DOCKER_TIMEOUT);

  afterAll(async () => {
    await h?.close();
  }, DOCKER_TIMEOUT);

  test('a capture survives a gateway restart with the same revision identity', async () => {
    const note = lessonNote('Restart durability', 'restart durability marker delta');
    const approved = await approveNote(h, 'freellmapi', 'project-reviewer', note);

    await h.restartBrain();

    const recall = await recallWhenReady(h, 'project-reviewer', 'freellmapi', 'restart durability marker');
    expect(recall.isError).toBe(false);
    const items = (recall.structured as { items?: { id?: string; revision_id?: string }[] }).items ?? [];
    const found = items.find((item) => item.id === approved.id);
    expect(found).toBeDefined();
    expect(found?.revision_id).toBe(approved.revision_id);

    const read = await readUntilSettled(h, approved.id);
    expect(read.isError, JSON.stringify(read)).toBe(false);
    expect((read.structured as { markdown?: string }).markdown).toContain('restart durability marker delta');
  }, 900_000);

  test('a SIGKILL and container recreation reclaims the retained instance lock', async () => {
    const note = lessonNote('Crash lock recovery', 'sigkill retained lock marker');
    const approved = await approveNote(h, 'freellmapi', 'project-reviewer', note);
    expect(h.compose(['kill', '-s', 'SIGKILL', 'brain']).status).toBe(0);
    expect(h.compose(['rm', '-f', 'brain']).status).toBe(0);
    expect(h.compose(['up', '-d', 'brain']).status).toBe(0);
    await h.waitForHealth(240_000);
    const read = await readUntilSettled(h, approved.id);
    expect(read.isError, JSON.stringify(read)).toBe(false);
    expect((read.structured as { markdown?: string }).markdown).toContain('sigkill retained lock marker');
  }, 900_000);

  test('a human Obsidian edit is detected and never silently overwritten', async () => {
    const note = lessonNote('Human edit case', 'human edit marker epsilon');
    const approved = await approveNote(h, 'freellmapi', 'project-reviewer', note);

    const files = await h.vaultFiles();
    const relativePath = files.find((file) => file.includes(approved.revision_id) && file.endsWith('.md'));
    expect(relativePath).toBeDefined();
    const absolute = join(h.vaultPath, relativePath as string);
    const raw = await readFile(absolute, 'utf8');
    const edited = raw
      .replace('brain_schema_version: 1', 'brain_schema_version: 1\nowner_extra: keep-me')
      .concat('\n## Extra section\n\nHuman-appended content.\n');
    expect(edited).not.toBe(raw);
    await writeFile(absolute, edited, 'utf8');

    await h.callAs('project-reviewer', 'brain_review', {
      scope: 'freellmapi',
      operation: { action: 'list', filter: 'conflict' }
    });

    const read = await readUntilSettled(h, approved.id);
    expect(read.isError, JSON.stringify(read)).toBe(false);
    const structured = read.structured as { markdown?: string; source?: { warnings?: string[] } };
    expect(structured.source?.warnings ?? []).toContain('manual_unreviewed');
    expect(structured.markdown).toContain('Human-appended content.');
    expect(structured.markdown).toContain('owner_extra: keep-me');

    const staleApprove = await h.approveAs(
      'project-reviewer',
      'freellmapi',
      approved.id,
      approved.etag,
      'stale synthetic approval'
    );
    expect(staleApprove.isError).toBe(true);
    expect(JSON.stringify(staleApprove.structured)).toMatch(/CONFLICT/);

    const after = await readFile(absolute, 'utf8');
    expect(after).toContain('Human-appended content.');
    expect(after).toContain('owner_extra: keep-me');
  }, 900_000);

  test('a superseded note is not returned as current authority', async () => {
    const first = await approveNote(
      h,
      'freellmapi',
      'project-reviewer',
      lessonNote('Superseded authority', 'authority marker alpha one')
    );
    const second = await approveNote(
      h,
      'freellmapi',
      'project-reviewer',
      lessonNote('Replacement authority', 'authority marker beta two')
    );

    const supersede = await h.callAs('project-reviewer', 'brain_review', {
      scope: 'freellmapi',
      operation: {
        action: 'supersede',
        idempotency_key: randomUUID(),
        id: first.id,
        expected_etag: first.etag,
        rationale: 'synthetic supersession',
        replacement_id: second.id
      }
    });
    expect(supersede.isError).toBe(false);

    const oldAuthority = await h.recallAs('project-reviewer', 'freellmapi', 'authority marker alpha');
    expect(oldAuthority.isError).toBe(false);
    const oldItems = (oldAuthority.structured as { items?: { id?: string }[] }).items ?? [];
    expect(oldItems.some((item) => item.id === first.id)).toBe(false);

    const newAuthority = await h.recallAs('project-reviewer', 'freellmapi', 'authority marker beta');
    expect(newAuthority.isError).toBe(false);
    const newItems = (newAuthority.structured as { items?: { id?: string }[] }).items ?? [];
    expect(newItems.some((item) => item.id === second.id)).toBe(true);
  }, 900_000);

  test('a cross-project note is never returned as project authority', async () => {
    await h.seedForbiddenMarker('CROSS_PROJECT_AUTHORITY_MARKER');
    const recall = await h.recallAs('project-reviewer', 'freellmapi', 'private project marker');
    expect(recall.isError).toBe(false);
    expect(JSON.stringify(recall)).not.toContain('CROSS_PROJECT_AUTHORITY_MARKER');
  }, 900_000);

  test('Unicode content is preserved through capture, review, read, and disk', async () => {
    const approved = await approveNote(
      h,
      'freellmapi',
      'project-reviewer',
      lessonNote('Unicode preservation', UNICODE_LESSON)
    );
    const read = await readUntilSettled(h, approved.id);
    expect(read.isError, JSON.stringify(read)).toBe(false);
    expect((read.structured as { markdown?: string }).markdown).toContain(UNICODE_LESSON);

    const files = await h.vaultFiles();
    const relativePath = files.find((file) => file.includes(approved.revision_id) && file.endsWith('.md'));
    const onDisk = await readFile(join(h.vaultPath, relativePath as string), 'utf8');
    expect(onDisk).toContain(UNICODE_LESSON);
  }, 900_000);

  test('a future-schema revision is quarantined and its file is preserved', async () => {
    const approved = await approveNote(
      h,
      'freellmapi',
      'project-reviewer',
      lessonNote('Future schema case', 'future schema marker zeta')
    );
    const files = await h.vaultFiles();
    const relativePath = files.find((file) => file.includes(approved.revision_id) && file.endsWith('.md'));
    const absolute = join(h.vaultPath, relativePath as string);
    const raw = await readFile(absolute, 'utf8');
    const edited = raw.replace('brain_schema_version: 1', 'brain_schema_version: 999');
    expect(edited).not.toBe(raw);
    await writeFile(absolute, edited, 'utf8');

    await h.callAs('project-reviewer', 'brain_review', {
      scope: 'freellmapi',
      operation: { action: 'list', filter: 'conflict' }
    });

    const recall = await h.recallAs('project-reviewer', 'freellmapi', 'future schema marker zeta');
    expect(recall.isError).toBe(false);
    expect(JSON.stringify(recall)).not.toContain('future schema marker zeta');

    const read = await h.callAs('project-reviewer', 'brain_read', {
      scope: 'freellmapi',
      id: approved.id
    });
    expect(read.isError).toBe(true);

    const after = await readFile(absolute, 'utf8');
    expect(after).toContain('brain_schema_version: 999');
    expect(after).toContain('future schema marker zeta');
  }, 900_000);
});

describe('lifecycle recovery and restore verification', () => {
  test('an absent pre-write failure settles without ever being blindly resubmitted', async () => {
    const h: MemoryHarness = await createHarness();
    try {
      h.backend.fail_once = 'before_write';
      const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
      const first = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
      expect(first.outcome).toBe('pending');
      expect(h.backend.create_calls).toHaveLength(1);

      await h.restart();
      const afterRestart = await recoverPending(h.deps);
      expect(afterRestart.blocking_operations).toHaveLength(0);
      expect(h.deps.journal.get(first.operation_id)?.state).toBe('failed');
      expect(h.backend.create_calls).toHaveLength(1);

      await expect(
        h.deps.mutations.commit(reviewerContext, request.intent, request.build)
      ).rejects.toThrow(/operation failed definitively/);

      const files = (await h.deps.vault.list('freellmapi')).filter((path) => path.endsWith('.md'));
      expect(files).toHaveLength(0);
      const candidates = await h.deps.catalogue.list('freellmapi', 'candidate');
      expect(candidates.items.filter((item) => item.id === first.id)).toHaveLength(0);
      expect(h.backend.create_calls).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 120_000);

  test('a persisted but unacknowledged write is finalized by recovery exactly once', async () => {
    const h: MemoryHarness = await createHarness();
    try {
      h.backend.fail_once = 'after_write';
      const request = createCandidateIntent(lessonFixture, { idempotency_key: randomUUID() });
      const first = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
      expect(['pending', 'stored']).toContain(first.outcome);
      expect(h.backend.create_calls).toHaveLength(1);

      await h.restart();
      const report = await recoverPending(h.deps);
      if (first.outcome === 'pending') expect(report.finalized).toBe(1);
      expect(h.deps.journal.get(first.operation_id)?.state).toBe('complete');

      const replay = await h.deps.mutations.commit(reviewerContext, request.intent, request.build);
      expect(replay.outcome).toBe('stored');
      expect(replay.revision_id).toBe(first.revision_id);
      expect(h.backend.create_calls).toHaveLength(1);

      const files = (await h.deps.vault.list('freellmapi')).filter((path) => path.endsWith('.md'));
      expect(files).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 120_000);

  test('a corrupt cold backup is rejected before restore', async () => {
    const fixture = await makeBackupFixture();
    try {
      await expect(verifyManifest(fixture.root, fixture.manifest)).resolves.toBeUndefined();
      await fixture.corrupt('vault/Projects/freellmapi/Notes/test.md');
      await expect(verifyManifest(fixture.root, fixture.manifest)).rejects.toThrow(/checksum/);
    } finally {
      await fixture.close();
    }
  }, 120_000);
});
