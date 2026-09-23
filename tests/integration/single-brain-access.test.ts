import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type {
  NoteContent,
  NoteInput,
  RecallRequest,
  AuthenticatedContext,
  ReviewListResult,
  MutationReceipt
} from '../../src/core/types.js';
import { SYSTEM_ACTOR } from '../../src/core/types.js';
import { capture } from '../../src/features/capture.js';
import { feedback } from '../../src/features/feedback.js';
import { ensureProject } from '../../src/features/project-ensure.js';
import { read } from '../../src/features/read.js';
import { recall } from '../../src/features/recall.js';
import { review } from '../../src/features/review.js';
import { createHarness, type MemoryHarness } from '../support/harness.js';

function roleFreeContext(): AuthenticatedContext {
  return {
    actor: SYSTEM_ACTOR,
    request_id: randomUUID(),
    signal: new AbortController().signal
  };
}

function noteFor(content: NoteContent, title: string): NoteInput {
  return { title, tags: ['single-brain'], content, evidence: [], related_ids: [] };
}

const preference = (text: string): NoteContent => ({
  kind: 'preference',
  preference: text,
  applicability: 'The former profile project',
  source_statement_ref: 'single-brain-access-fixture'
});

const flexible = (text: string): NoteContent => ({
  kind: 'note',
  summary: text,
  body_markdown: `# ${text}\n\nFree-form body.`
});

function asReceipt(result: MutationReceipt | ReviewListResult): MutationReceipt {
  if ('items' in result) throw new Error('expected a mutation receipt');
  return result;
}

async function headOf(h: MemoryHarness, scope: string, id: string) {
  return h.deps.catalogue.get(scope, id);
}

async function forkInVault(h: MemoryHarness, scope: string, relativePath: string): Promise<void> {
  const absolute = join(h.deps.config.mounts.vault, relativePath);
  const raw = await readFile(absolute, 'utf8');
  const revisionId = randomUUID();
  const forked = raw.replace(/^brain_revision_id:.*$/m, `brain_revision_id: ${revisionId}`);
  const forkedPath = relativePath.replace(/\.md$/, `-${revisionId}.md`);
  await writeFile(join(h.deps.config.mounts.vault, forkedPath), forked, 'utf8');
  await h.deps.catalogue.reconcile(scope);
}

test('one role-free context runs the whole lifecycle including a former profile note', async () => {
  const h = await createHarness();
  try {
    const ctx = roleFreeContext();
    const captured = await capture(
      ctx,
      { idempotency_key: randomUUID(), scope: 'profile', note: noteFor(preference('Prefer local retrieval.'), 'Profile preference') },
      h.deps
    );
    const candidate = await headOf(h, 'profile', captured.id);
    expect(candidate.source.status).toBe('candidate');

    const readBack = await read(ctx, { scope: 'profile', id: captured.id }, h.deps);
    expect(readBack.markdown).toContain('Prefer local retrieval.');

    const approved = asReceipt(
      await review(
        ctx,
        {
          scope: 'profile',
          operation: {
            action: 'approve',
            idempotency_key: randomUUID(),
            id: captured.id,
            expected_etag: candidate.source.etag,
            rationale: 'single trust domain approval'
          }
        },
        h.deps
      )
    );
    expect(approved.outcome).toBe('stored');

    const active = await headOf(h, 'profile', captured.id);
    const revised = asReceipt(
      await review(
        ctx,
        {
          scope: 'profile',
          operation: {
            action: 'revise',
            idempotency_key: randomUUID(),
            id: captured.id,
            expected_etag: active.source.etag,
            rationale: 'single trust domain revision',
            note: noteFor(preference('Prefer local retrieval with Laya.'), 'Profile preference')
          }
        },
        h.deps
      )
    );
    expect(revised.outcome).toBe('stored');

    const revisedHead = await headOf(h, 'profile', captured.id);
    const reApproved = asReceipt(
      await review(
        ctx,
        {
          scope: 'profile',
          operation: {
            action: 'approve',
            idempotency_key: randomUUID(),
            id: captured.id,
            expected_etag: revisedHead.source.etag,
            rationale: 'single trust domain re-approval'
          }
        },
        h.deps
      )
    );
    expect(reApproved.outcome).toBe('stored');

    const second = await capture(
      ctx,
      { idempotency_key: randomUUID(), scope: 'profile', note: noteFor(flexible('Second profile note'), 'Second profile note') },
      h.deps
    );
    const secondHead = await headOf(h, 'profile', second.id);
    await review(
      ctx,
      {
        scope: 'profile',
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: second.id,
          expected_etag: secondHead.source.etag,
          rationale: 'single trust domain approval'
        }
      },
      h.deps
    );
    const secondActive = await headOf(h, 'profile', second.id);
    const superseded = asReceipt(
      await review(
        ctx,
        {
          scope: 'profile',
          operation: {
            action: 'supersede',
            idempotency_key: randomUUID(),
            id: second.id,
            expected_etag: secondActive.source.etag,
            rationale: 'superseded by the preference',
            replacement_id: captured.id
          }
        },
        h.deps
      )
    );
    expect(superseded.outcome).toBe('stored');

    const archiveTarget = await headOf(h, 'profile', captured.id);
    const archived = asReceipt(
      await review(
        ctx,
        {
          scope: 'profile',
          operation: {
            action: 'archive',
            idempotency_key: randomUUID(),
            id: captured.id,
            expected_etag: archiveTarget.source.etag,
            rationale: 'single trust domain archive'
          }
        },
        h.deps
      )
    );
    expect(archived.outcome).toBe('stored');

    const feedbackResult = await feedback(
      ctx,
      {
        idempotency_key: randomUUID(),
        scope: 'profile',
        id: captured.id,
        revision_id: archived.revision_id,
        verdict: 'useful',
        reason: 'single trust domain feedback'
      },
      h.deps
    );
    expect(feedbackResult.recorded).toBe(true);
  } finally {
    await h.close();
  }
});

test('one role-free context resolves a genuine revision fork', async () => {
  const h = await createHarness();
  try {
    const ctx = roleFreeContext();
    const captured = await capture(
      ctx,
      { idempotency_key: randomUUID(), scope: 'freellmapi', note: noteFor(flexible('Fork target'), 'Fork target') },
      h.deps
    );
    const head = await headOf(h, 'freellmapi', captured.id);
    await forkInVault(h, 'freellmapi', head.source.relative_path);

    const conflictedState = await h.deps.catalogue.list('freellmapi', 'conflict');
    const conflictHeads = conflictedState.items.filter((item) => item.id === captured.id);
    expect(conflictHeads.length).toBeGreaterThan(1);

    const resolved = asReceipt(
      await review(
        ctx,
        {
          scope: 'freellmapi',
          operation: {
            action: 'resolve',
            idempotency_key: randomUUID(),
            id: captured.id,
            expected_heads: conflictHeads.map((entry) => ({
              revision_id: entry.revision_id,
              etag: entry.etag
            })),
            rationale: 'single trust domain resolution',
            note: noteFor(flexible('Resolved content'), 'Resolved content')
          }
        },
        h.deps
      )
    );
    expect(resolved.outcome).not.toBe('pending');
  } finally {
    await h.close();
  }
});

test('project creation adds organization without a permission grant', async () => {
  const h = await createHarness();
  try {
    const ctx = roleFreeContext();
    const result = await ensureProject(
      ctx,
      { idempotency_key: randomUUID(), remote_url: 'https://github.com/example/local-brain.git' },
      h.deps
    );
    expect(result.repository_identity).toBe('github.com/example/local-brain');
    expect(result.created).toBe(true);
    expect(result).not.toHaveProperty('permissions');

    const captured = await capture(
      ctx,
      { idempotency_key: randomUUID(), scope: result.scope, note: noteFor(flexible('New project note'), 'New project note') },
      h.deps
    );
    expect(captured.outcome).toBe('stored');
  } finally {
    await h.close();
  }
});

test('a project filter narrows retrieval without denying access to another project', async () => {
  const h = await createHarness();
  try {
    const ctx = roleFreeContext();
    await h.seed(noteFor(flexible('freellmapi filtered marker'), 'freellmapi marker'), {
      scope: 'freellmapi',
      status: 'active'
    });
    const shared = await h.seed(noteFor(flexible('shared marker'), 'shared marker'), {
      scope: 'shared',
      status: 'active'
    });

    const filtered = await recall(ctx, { scope: 'freellmapi', query: 'marker' }, h.deps);
    expect(filtered.items.every((item) => item.scope === 'freellmapi')).toBe(true);

    const other = await read(ctx, { scope: 'shared', id: shared.revision.id }, h.deps);
    expect(other.source.id).toBe(shared.revision.id);

    const wholeBrain = await recall(ctx, { query: 'marker' } as unknown as RecallRequest, h.deps);
    expect(wholeBrain.items.length).toBeGreaterThanOrEqual(1);
  } finally {
    await h.close();
  }
});
