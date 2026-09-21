import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { BrainError, type BrainErrorCode } from '../../src/contracts/errors.js';
import type {
  Head,
  MutationReceipt,
  NoteContent,
  NoteInput,
  Principal,
  RequestContext,
  ReviewListResult
} from '../../src/core/types.js';
import { makeEtag, payloadHash } from '../../src/notes/codec.js';
import { review } from '../../src/features/review.js';
import { lessonFixture } from '../fixtures/content.js';
import {
  ownerContext,
  reviewerContext,
  reviewerPrincipal,
  workerContext
} from '../fixtures/principals.js';
import { createHarness, type MemoryHarness } from '../support/harness.js';

const SCOPE = 'freellmapi';

const key = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type LessonContent = Extract<NoteContent, { kind: 'lesson' }>;

const lessonContentOf = (overrides: Partial<LessonContent> = {}): NoteContent => ({
  ...(lessonFixture.content as LessonContent),
  ...overrides
});

const decisionContent: NoteContent = {
  kind: 'decision',
  context: 'The gateway needs a private backend.',
  decision: 'Use the Basic Memory adapter over private HTTP.',
  rationale: 'It preserves the documented note envelope.'
};

const preferenceContent: NoteContent = {
  kind: 'preference',
  preference: 'Prefer hybrid recall over text-only recall.',
  applicability: 'Routine planning and debugging.',
  source_statement_ref: 'user-statement-1'
};

const sessionContent: NoteContent = {
  kind: 'session',
  task: 'Implement review transitions.',
  state: 'Under test.',
  next_actions: ['Run the suite'],
  session_id: 'session-review'
};

const flexibleContent: NoteContent = {
  kind: 'note',
  summary: 'Flexible record',
  body_markdown: '# Body\n\nFree-form Markdown.'
};

function noteWith(content: NoteContent, overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    ...lessonFixture,
    title: `review ${content.kind}`,
    content,
    ...overrides
  };
}

function asReceipt(result: MutationReceipt | ReviewListResult): MutationReceipt {
  if ('items' in result) throw new Error('expected a mutation receipt');
  return result;
}

function asList(result: MutationReceipt | ReviewListResult): ReviewListResult {
  if ('items' in result) return result;
  throw new Error('expected a list result');
}

async function expectCode(action: Promise<unknown>, code: BrainErrorCode): Promise<void> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).code).toBe(code);
    return;
  }
  throw new Error(`expected BrainError ${code}, but the action resolved`);
}

async function currentHead(h: MemoryHarness, id: string, scope = SCOPE): Promise<Head> {
  return h.deps.catalogue.get(scope, id);
}

function vaultPath(h: MemoryHarness, relative: string): string {
  return join(h.deps.config.mounts.vault, relative);
}

async function scopeFiles(h: MemoryHarness, scope = SCOPE): Promise<Map<string, Buffer>> {
  const scopeConfig = h.deps.config.scopes.find((candidate) => candidate.id === scope);
  if (scopeConfig === undefined) throw new Error(`no configured scope ${scope}`);
  const root = join(h.deps.config.mounts.vault, scopeConfig.relative_root);
  const files = new Map<string, Buffer>();
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.set(absolute, await readFile(absolute));
      }
    }
  };
  await walk(root);
  return files;
}

function expectUntouched(before: Map<string, Buffer>, after: Map<string, Buffer>): void {
  for (const [path, raw] of before) {
    const current = after.get(path);
    expect(current).toBeDefined();
    expect(current?.equals(raw)).toBe(true);
  }
}

async function duplicateRevisionFile(
  h: MemoryHarness,
  head: Head,
  label: string
): Promise<{ revisionId: string; path: string }> {
  const absolute = vaultPath(h, head.source.relative_path);
  const raw = await readFile(absolute, 'utf8');
  const revisionId = randomUUID();
  const operationId = randomUUID();
  const copy = raw
    .replace(/^(brain_revision_id:[ \t]*).*$/m, `$1${revisionId}`)
    .replace(/^(brain_operation_id:[ \t]*).*$/m, `$1${operationId}`);
  const path = join(dirname(absolute), `${label}.md`);
  await writeFile(path, copy, 'utf8');
  await h.deps.catalogue.reconcile(head.source.scope);
  return { revisionId, path };
}

async function duplicateIdentityFile(h: MemoryHarness, head: Head, label: string): Promise<string> {
  const absolute = vaultPath(h, head.source.relative_path);
  const raw = await readFile(absolute, 'utf8');
  const path = join(dirname(absolute), `${label}.md`);
  await writeFile(path, raw, 'utf8');
  await h.deps.catalogue.reconcile(head.source.scope);
  return path;
}

function rawHashOf(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

const reviewOnlyPrincipal: Principal = {
  id: '00000000-0000-4000-8000-0000000000a1',
  role: 'reviewer',
  read_scopes: [SCOPE],
  write_scopes: [],
  review_scopes: [SCOPE]
};

const reviewOnlyContext: RequestContext = {
  principal: reviewOnlyPrincipal,
  request_id: randomUUID(),
  signal: new AbortController().signal
};

const scopedReviewerPrincipal: Principal = {
  id: '00000000-0000-4000-8000-0000000000a2',
  role: 'reviewer',
  read_scopes: ['shared', 'profile'],
  write_scopes: ['shared', 'profile'],
  review_scopes: ['shared', 'profile']
};

const scopedReviewerContext: RequestContext = {
  principal: scopedReviewerPrincipal,
  request_id: randomUUID(),
  signal: new AbortController().signal
};

test('a worker cannot approve its own candidate by naming a review action', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'candidate' });
  await expect(review(workerContext, {
    scope: 'freellmapi', operation: {
      action: 'approve', id: head.source.id, expected_etag: head.source.etag,
      idempotency_key: '22222222-2222-4222-8222-222222222222',
      rationale: 'The referenced benchmark supports this scoped lesson.'
    }
  }, h.deps)).rejects.toThrow(/FORBIDDEN/);
  await h.close();
});

test('lists candidates and conflicts for a readable scope only', async () => {
  const h = await createHarness();
  const candidate = await h.seed(noteWith(flexibleContent), { status: 'candidate' });
  const active = await h.seed(noteWith({ ...flexibleContent, summary: 'Active record' }), {
    status: 'active'
  });

  const listed = asList(
    await review(reviewerContext, { scope: SCOPE, operation: { action: 'list', filter: 'candidate' } }, h.deps)
  );
  expect(listed.items.map((item) => item.id)).toContain(candidate.source.id);
  expect(listed.items.map((item) => item.id)).not.toContain(active.source.id);

  await duplicateRevisionFile(h, candidate, 'listed-conflict');
  const conflicts = asList(
    await review(reviewerContext, { scope: SCOPE, operation: { action: 'list', filter: 'conflict' } }, h.deps)
  );
  expect(conflicts.items.map((item) => item.id)).toContain(candidate.source.id);
  expect(conflicts.items.map((item) => item.id)).not.toContain(active.source.id);
  await h.close();
});

test('never exposes candidates from a scope the principal cannot read', async () => {
  const h = await createHarness();
  await h.seed(noteWith(preferenceContent), { scope: 'profile', status: 'candidate' });
  const visible = await h.seed(noteWith(flexibleContent), { status: 'candidate' });

  const listed = asList(
    await review(workerContext, { scope: SCOPE, operation: { action: 'list', filter: 'candidate' } }, h.deps)
  );
  expect(listed.items.every((item) => item.scope === SCOPE)).toBe(true);
  expect(listed.items.map((item) => item.id)).toContain(visible.source.id);

  await expectCode(
    review(workerContext, { scope: 'profile', operation: { action: 'list', filter: 'candidate' } }, h.deps),
    'FORBIDDEN'
  );
  await h.close();
});

test('approves an evidenced candidate and records the approval fingerprint', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'candidate' });
  const before = await scopeFiles(h);

  const receipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(1),
        rationale: 'The referenced benchmark supports this scoped lesson.'
      }
    }, h.deps)
  );
  expect(receipt.outcome).toBe('stored');
  expect(receipt.etag).toBeDefined();

  const active = await currentHead(h, head.source.id);
  expect(active.state).toBe('ready');
  expect(active.revision.status).toBe('active');
  expect(active.revision.approval?.principal_id).toBe(reviewerPrincipal.id);
  expect(active.revision.approval?.rationale).toBe('The referenced benchmark supports this scoped lesson.');
  expect(active.revision.approval?.payload_hash).toBe(payloadHash(active.revision));
  expect(active.revision.parents.map((parent) => parent.revision_id)).toEqual([head.source.revision_id]);

  expectUntouched(before, await scopeFiles(h));
  await h.close();
});

test('refuses to approve a lesson without non-hypothesis evidence', async () => {
  const h = await createHarness();
  const head = await h.seed(
    { ...lessonFixture, evidence: [{ kind: 'hypothesis', ref: 'h-1', description: 'An untested guess' }] },
    { status: 'candidate' }
  );
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(2),
        rationale: 'The guess is plausible.'
      }
    }, h.deps),
    'INVALID_INPUT'
  );
  expect((await currentHead(h, head.source.id)).revision.status).toBe('candidate');
  await h.close();
});

test('accepts flexible notes and sessions as useful records without a factual claim', async () => {
  const h = await createHarness();
  const flexible = await h.seed(noteWith(flexibleContent, { evidence: [] }), { status: 'candidate' });
  const session = await h.seed(noteWith(sessionContent, { evidence: [] }), { status: 'candidate' });

  const flexibleReceipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: flexible.source.id,
        expected_etag: flexible.source.etag,
        idempotency_key: key(3),
        rationale: 'Useful record for later context.'
      }
    }, h.deps)
  );
  const sessionReceipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: session.source.id,
        expected_etag: session.source.etag,
        idempotency_key: key(4),
        rationale: 'Handoff note without a verification claim.'
      }
    }, h.deps)
  );
  expect(flexibleReceipt.outcome).toBe('stored');
  expect(sessionReceipt.outcome).toBe('stored');
  expect((await currentHead(h, flexible.source.id)).revision.status).toBe('active');
  expect((await currentHead(h, session.source.id)).revision.status).toBe('active');
  await h.close();
});

test('rejects an approval whose etag no longer matches the head', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'candidate' });
  await h.externalEdit(head, (raw) =>
    raw.replace('Measure the direct and proxied request', 'Always measure the direct and proxied request')
  );
  await h.deps.catalogue.reconcile(SCOPE);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(5),
        rationale: 'Stale etag should be rejected.'
      }
    }, h.deps),
    'CONFLICT'
  );
  expect((await currentHead(h, head.source.id)).revision.status).toBe('candidate');
  await h.close();
});

test('approves manually changed content and refreshes the approval fingerprint', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await h.externalEdit(head, (raw) =>
    raw.replace('Measure the direct and proxied request', 'Always measure direct and proxied requests')
  );
  await h.deps.catalogue.reconcile(SCOPE);

  const manual = await currentHead(h, head.source.id);
  expect(manual.state).toBe('manual_unreviewed');

  const receipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: manual.source.id,
        expected_etag: manual.source.etag,
        idempotency_key: key(6),
        rationale: 'Manual edit reviewed.'
      }
    }, h.deps)
  );
  expect(receipt.outcome).toBe('stored');
  const reapproved = await currentHead(h, head.source.id);
  expect(reapproved.state).toBe('ready');
  expect(reapproved.revision.status).toBe('active');
  expect(reapproved.revision.approval?.payload_hash).toBe(payloadHash(reapproved.revision));
  expect((reapproved.revision.note.content as LessonContent).lesson).toBe(
    'Always measure direct and proxied requests with the same prompt before attributing the difference to the proxy.'
  );
  await h.close();
});

test('requires owner permission to approve or revise a protected preference', async () => {
  const h = await createHarness();
  const head = await h.seed(noteWith(preferenceContent, { evidence: [] }), { status: 'candidate' });

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(7),
        rationale: 'A reviewer must not approve a protected preference.'
      }
    }, h.deps),
    'FORBIDDEN'
  );
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(8),
        rationale: 'A reviewer must not revise a protected preference.',
        note: noteWith(preferenceContent)
      }
    }, h.deps),
    'FORBIDDEN'
  );

  const approved = asReceipt(
    await review(ownerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(9),
        rationale: 'Owner approves the preference.'
      }
    }, h.deps)
  );
  expect(approved.outcome).toBe('stored');
  const active = await currentHead(h, head.source.id);
  expect(active.revision.status).toBe('active');

  const revised = asReceipt(
    await review(ownerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: active.source.id,
        expected_etag: active.source.etag,
        idempotency_key: key(10),
        rationale: 'Owner refines the preference.',
        note: noteWith(preferenceContent)
      }
    }, h.deps)
  );
  expect(revised.outcome).toBe('stored');
  expect((await currentHead(h, head.source.id)).revision.status).toBe('candidate');
  await h.close();
});

test('requires owner permission to revise an already-approved decision', async () => {
  const h = await createHarness();
  const head = await h.seed(noteWith(decisionContent, { evidence: [] }), { status: 'active' });
  const before = await scopeFiles(h);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(11),
        rationale: 'A reviewer must not revise an approved decision.',
        note: noteWith(decisionContent)
      }
    }, h.deps),
    'FORBIDDEN'
  );

  const revised = asReceipt(
    await review(ownerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(12),
        rationale: 'Owner supersedes the earlier decision content.',
        note: noteWith(decisionContent)
      }
    }, h.deps)
  );
  expect(revised.outcome).toBe('stored');
  expect((await currentHead(h, head.source.id)).revision.status).toBe('candidate');
  expectUntouched(before, await scopeFiles(h));
  await h.close();
});

test('revises with supplied typed fields while preserving manual extras', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'candidate' });

  await h.externalEdit(head, (raw) =>
    raw
      .replace(/^(brain_status:.*)$/m, '$1\ncustom_review_key: custom-value')
      .concat('\n## Custom notes\n\nManual section kept.\n')
  );
  await h.deps.catalogue.reconcile(SCOPE);
  const edited = await currentHead(h, head.source.id);
  expect(edited.revision.extra_frontmatter.custom_review_key).toBe('custom-value');
  expect(edited.revision.extra_markdown).toContain('Manual section kept.');
  const before = await scopeFiles(h);

  const receipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: edited.source.id,
        expected_etag: edited.source.etag,
        idempotency_key: key(13),
        rationale: 'Tighten the lesson wording.',
        note: noteWith(lessonContentOf({ lesson: 'A revised lesson statement.' }))
      }
    }, h.deps)
  );
  expect(receipt.outcome).toBe('stored');

  const revised = await currentHead(h, head.source.id);
  expect(revised.revision.status).toBe('candidate');
  expect(revised.revision.note.content).toMatchObject({ lesson: 'A revised lesson statement.' });
  expect(revised.revision.extra_frontmatter.custom_review_key).toBe('custom-value');
  expect(revised.revision.extra_markdown).toContain('Manual section kept.');
  expect(revised.revision.approval).toBeUndefined();
  expectUntouched(before, await scopeFiles(h));
  await h.close();
});

test('revise authorizes every related note before reserving an operation', async () => {
  const h = await createHarness();
  const target = await h.seed(lessonFixture, { status: 'candidate' });
  const authorized = await h.seed(noteWith(flexibleContent), { scope: 'shared', status: 'active' });
  const inaccessible = await h.seed(noteWith(flexibleContent), { scope: 'profile', status: 'active' });
  for (const relatedId of [randomUUID(), inaccessible.source.id]) {
    await expectCode(
      review(
        reviewerContext,
        {
          scope: SCOPE,
          operation: {
            action: 'revise',
            id: target.source.id,
            expected_etag: target.source.etag,
            idempotency_key: randomUUID(),
            rationale: 'Authorize links before persistence.',
            note: noteWith(lessonContentOf(), { related_ids: [relatedId] })
          }
        },
        h.deps
      ),
      'FORBIDDEN'
    );
  }
  const receipt = asReceipt(
    await review(
      reviewerContext,
      {
        scope: SCOPE,
        operation: {
          action: 'revise',
          id: target.source.id,
          expected_etag: target.source.etag,
          idempotency_key: randomUUID(),
          rationale: 'The shared link is readable.',
          note: noteWith(lessonContentOf(), { related_ids: [authorized.source.id] })
        }
      },
      h.deps
    )
  );
  expect(receipt.outcome).toBe('stored');
  await h.close();
});

test('archives a note without physically deleting its earlier revisions', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  const before = await scopeFiles(h);

  const receipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'archive',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(14),
        rationale: 'No longer current.'
      }
    }, h.deps)
  );
  expect(receipt.outcome).toBe('stored');
  const archived = await currentHead(h, head.source.id);
  expect(archived.revision.status).toBe('archived');
  expect(archived.revision.parents.map((parent) => parent.revision_id)).toEqual([
    head.source.revision_id
  ]);
  expectUntouched(before, await scopeFiles(h));
  await h.close();
});

test('supersedes an active source with a readable active replacement in the same scope', async () => {
  const h = await createHarness();
  const source = await h.seed(lessonFixture, { status: 'active' });
  const replacement = await h.seed(noteWith(lessonContentOf({ lesson: 'Replacement lesson.' })), {
    status: 'active'
  });
  const before = await scopeFiles(h);

  const receipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: source.source.id,
        expected_etag: source.source.etag,
        idempotency_key: key(15),
        rationale: 'Replaced by a stronger lesson.',
        replacement_id: replacement.source.id
      }
    }, h.deps)
  );
  expect(receipt.outcome).toBe('stored');

  const superseded = await currentHead(h, source.source.id);
  expect(superseded.revision.status).toBe('superseded');
  expect(superseded.revision.replacement_id).toBe(replacement.source.id);
  expect((await currentHead(h, replacement.source.id)).revision.status).toBe('active');
  expectUntouched(before, await scopeFiles(h));
  await h.close();
});

test('rejects a replacement note from a different scope', async () => {
  const h = await createHarness();
  const source = await h.seed(lessonFixture, { status: 'active' });
  const other = await h.seed(noteWith(lessonContentOf({ lesson: 'Shared replacement.' })), {
    scope: 'shared',
    status: 'active'
  });
  const before = await scopeFiles(h);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: source.source.id,
        expected_etag: source.source.etag,
        idempotency_key: key(16),
        rationale: 'A cross-scope replacement is not readable here.',
        replacement_id: other.source.id
      }
    }, h.deps),
    'CONFLICT'
  );
  expect((await currentHead(h, source.source.id)).revision.status).toBe('active');
  expectUntouched(before, await scopeFiles(h));
  await h.close();
});

test('rejects self-supersession', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'active' });
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(17),
        rationale: 'A note cannot replace itself.',
        replacement_id: head.source.id
      }
    }, h.deps),
    'INVALID_INPUT'
  );
  await h.close();
});

test('rejects a supersession that would create a replacement cycle', async () => {
  const h = await createHarness();
  const first = await h.seed(lessonFixture, { status: 'active' });
  const second = await h.seed(noteWith(lessonContentOf({ lesson: 'Cycle candidate.' })), {
    status: 'active'
  });

  await h.externalEdit(second, (raw) =>
    raw.replace(/^(brain_status:.*)$/m, `$1\nbrain_replacement_id: ${first.source.id}`)
  );
  await h.deps.catalogue.reconcile(SCOPE);
  const secondHead = await currentHead(h, second.source.id);
  expect(secondHead.revision.replacement_id).toBe(first.source.id);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: first.source.id,
        expected_etag: first.source.etag,
        idempotency_key: key(18),
        rationale: 'This would form a replacement loop.',
        replacement_id: second.source.id
      }
    }, h.deps),
    'CONFLICT'
  );
  expect((await currentHead(h, first.source.id)).revision.status).toBe('active');
  await h.close();
});

test('replays the same receipt for an idempotent review and rejects a changed payload', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'candidate' });
  const operation = {
    action: 'approve' as const,
    id: head.source.id,
    expected_etag: head.source.etag,
    idempotency_key: key(19),
    rationale: 'Evidence supports approval.'
  };

  const first = asReceipt(await review(reviewerContext, { scope: SCOPE, operation }, h.deps));
  const second = asReceipt(await review(reviewerContext, { scope: SCOPE, operation }, h.deps));
  expect(second).toEqual(first);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: { ...operation, rationale: 'A different payload under the same key.' }
    }, h.deps),
    'IDEMPOTENCY_CONFLICT'
  );
  await h.close();
});

test('resolves a structurally valid revision fork with every head as a parent', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  const copy = await duplicateRevisionFile(h, root, 'fork-valid');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  const copyHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, copy.revisionId);
  expect(rootHead.state).toBe('conflict');
  expect(copyHead.state).toBe('conflict');
  const before = await scopeFiles(h);

  const receipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(20),
        rationale: 'Resolve the fork with a merged candidate.',
        expected_heads: [
          { revision_id: root.source.revision_id, etag: rootHead.source.etag },
          { revision_id: copy.revisionId, etag: copyHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'Resolved lesson statement.' }))
      }
    }, h.deps)
  );
  expect(receipt.outcome).toBe('stored');

  const resolved = await currentHead(h, root.source.id);
  expect(resolved.state).toBe('ready');
  expect(resolved.revision.status).toBe('candidate');
  expect(resolved.revision.parents.map((parent) => parent.revision_id).sort()).toEqual(
    [root.source.revision_id, copy.revisionId].sort()
  );
  expectUntouched(before, await scopeFiles(h));
  await h.close();
});

test('resolve rejects nonexistent and inaccessible related notes and accepts an authorized link', async () => {
  const cases: Array<{ related: 'missing' | 'inaccessible' | 'authorized'; accepted: boolean }> = [
    { related: 'missing', accepted: false },
    { related: 'inaccessible', accepted: false },
    { related: 'authorized', accepted: true }
  ];
  for (const item of cases) {
    const h = await createHarness();
    const root = await h.seed(lessonFixture, { status: 'candidate' });
    const copy = await duplicateRevisionFile(h, root, `related-${item.related}`);
    const authorized = await h.seed(noteWith(flexibleContent), { scope: 'shared', status: 'active' });
    const inaccessible = await h.seed(noteWith(flexibleContent), { scope: 'profile', status: 'active' });
    const relatedId =
      item.related === 'authorized'
        ? authorized.source.id
        : item.related === 'inaccessible'
          ? inaccessible.source.id
          : randomUUID();
    const request = review(
      reviewerContext,
      {
        scope: SCOPE,
        operation: {
          action: 'resolve',
          id: root.source.id,
          expected_heads: [
            { revision_id: root.source.revision_id, etag: root.source.etag },
            {
              revision_id: copy.revisionId,
              etag: (await h.deps.catalogue.getRevision(SCOPE, root.source.id, copy.revisionId)).source.etag
            }
          ],
          idempotency_key: randomUUID(),
          rationale: 'Resolve with an authorized reference.',
          note: noteWith(lessonContentOf(), { related_ids: [relatedId] })
        }
      },
      h.deps
    );
    if (item.accepted) expect(asReceipt(await request).outcome).toBe('stored');
    else await expectCode(request, 'FORBIDDEN');
    await h.close();
  }
});

test('rejects a partial conflict-head submission', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  await duplicateRevisionFile(h, root, 'fork-partial');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(21),
        rationale: 'Only one of two conflict heads is supplied.',
        expected_heads: [{ revision_id: root.source.revision_id, etag: rootHead.source.etag }],
        note: noteWith(lessonContentOf({ lesson: 'Partial resolve attempt.' }))
      }
    }, h.deps),
    'CONFLICT'
  );
  await h.close();
});

test('requires owner permission to resolve a protected preference fork', async () => {
  const h = await createHarness();
  const root = await h.seed(noteWith(preferenceContent, { evidence: [] }), { status: 'candidate' });
  const copy = await duplicateRevisionFile(h, root, 'fork-preference');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  const copyHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, copy.revisionId);
  const expected_heads = [
    { revision_id: root.source.revision_id, etag: rootHead.source.etag },
    { revision_id: copy.revisionId, etag: copyHead.source.etag }
  ];

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(22),
        rationale: 'A reviewer must not resolve a protected preference fork.',
        expected_heads,
        note: noteWith(preferenceContent)
      }
    }, h.deps),
    'FORBIDDEN'
  );

  const receipt = asReceipt(
    await review(ownerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(23),
        rationale: 'Owner resolves the preference fork.',
        expected_heads,
        note: noteWith(preferenceContent)
      }
    }, h.deps)
  );
  expect(receipt.outcome).toBe('stored');
  expect((await currentHead(h, root.source.id)).revision.status).toBe('candidate');
  await h.close();
});

test('refuses to resolve over a missing parent, changed parent hash, or unsupported schema', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });

  const missing = await duplicateRevisionFile(h, root, 'fork-missing');
  const missingRaw = await readFile(missing.path, 'utf8');
  await writeFile(
    missing.path,
    missingRaw.replace(
      /^brain_parents: \[\]$/m,
      `brain_parents:\n  - ${randomUUID()}@${'d'.repeat(64)}`
    ),
    'utf8'
  );
  await h.deps.catalogue.reconcile(SCOPE);
  const missingHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, missing.revisionId);
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(24),
        rationale: 'Missing parent is corruption, not a fork.',
        expected_heads: [
          { revision_id: root.source.revision_id, etag: rootHead.source.etag },
          { revision_id: missing.revisionId, etag: missingHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'Should not be written.' }))
      }
    }, h.deps),
    'RECOVERY_REQUIRED'
  );
  await h.close();

  const hashCase = await createHarness();
  const hashRoot = await hashCase.seed(lessonFixture, { status: 'candidate' });
  const changed = await duplicateRevisionFile(hashCase, hashRoot, 'fork-hash');
  const changedRaw = await readFile(changed.path, 'utf8');
  await writeFile(
    changed.path,
    changedRaw.replace(
      /^brain_parents: \[\]$/m,
      `brain_parents:\n  - ${hashRoot.source.revision_id}@${'e'.repeat(64)}`
    ),
    'utf8'
  );
  await hashCase.deps.catalogue.reconcile(SCOPE);
  const changedHead = await hashCase.deps.catalogue.getRevision(SCOPE, hashRoot.source.id, changed.revisionId);
  const hashRootHead = await hashCase.deps.catalogue.getRevision(
    SCOPE,
    hashRoot.source.id,
    hashRoot.source.revision_id
  );
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: hashRoot.source.id,
        idempotency_key: key(25),
        rationale: 'A changed historical-parent hash is corruption.',
        expected_heads: [
          { revision_id: hashRoot.source.revision_id, etag: hashRootHead.source.etag },
          { revision_id: changed.revisionId, etag: changedHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'Should not be written either.' }))
      }
    }, hashCase.deps),
    'RECOVERY_REQUIRED'
  );
  await hashCase.close();

  const schemaCase = await createHarness();
  const schemaRoot = await schemaCase.seed(lessonFixture, { status: 'candidate' });
  const unsupported = await duplicateRevisionFile(schemaCase, schemaRoot, 'fork-schema');
  const unsupportedRaw = await readFile(unsupported.path, 'utf8');
  await writeFile(
    unsupported.path,
    unsupportedRaw.replace(/^brain_schema_version: 1$/m, 'brain_schema_version: 2'),
    'utf8'
  );
  await schemaCase.deps.catalogue.reconcile(SCOPE);
  const schemaRootHead = await schemaCase.deps.catalogue.getRevision(
    SCOPE,
    schemaRoot.source.id,
    schemaRoot.source.revision_id
  );
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: schemaRoot.source.id,
        idempotency_key: key(26),
        rationale: 'An unsupported schema is corruption.',
        expected_heads: [
          { revision_id: schemaRoot.source.revision_id, etag: schemaRootHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'Still should not be written.' }))
      }
    }, schemaCase.deps),
    'RECOVERY_REQUIRED'
  );
  await schemaCase.close();
});

test('merges two notes in staged, separately keyed calls without deleting either', async () => {
  const h = await createHarness();
  const first = await h.seed(lessonFixture, { status: 'candidate' });
  const second = await h.seed(noteWith(lessonContentOf({ lesson: 'Second note lesson.' })), {
    status: 'candidate'
  });
  const before = await scopeFiles(h);

  asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: first.source.id,
        expected_etag: first.source.etag,
        idempotency_key: key(27),
        rationale: 'Fold the second note into the first as a source.',
        note: noteWith(lessonContentOf({ lesson: 'Merged lesson statement.' }), {
          related_ids: [second.source.id]
        })
      }
    }, h.deps)
  );
  const revised = await currentHead(h, first.source.id);
  asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: revised.source.id,
        expected_etag: revised.source.etag,
        idempotency_key: key(28),
        rationale: 'The merged candidate keeps its evidence.'
      }
    }, h.deps)
  );
  const approved = await currentHead(h, first.source.id);
  expect(approved.revision.status).toBe('active');

  asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: second.source.id,
        expected_etag: second.source.etag,
        idempotency_key: key(29),
        rationale: 'The source note is now folded into the merged note.',
        replacement_id: first.source.id
      }
    }, h.deps)
  );

  const superseded = await currentHead(h, second.source.id);
  expect(superseded.revision.status).toBe('superseded');
  expect(superseded.revision.replacement_id).toBe(first.source.id);
  expect((await currentHead(h, first.source.id)).revision.status).toBe('active');

  const files = await scopeFiles(h);
  expect(files.has(vaultPath(h, first.source.relative_path))).toBe(true);
  expect(files.has(vaultPath(h, second.source.relative_path))).toBe(true);
  expectUntouched(before, files);
  await h.close();
});

test('keeps both notes when the final merge step fails', async () => {
  const h = await createHarness();
  const first = await h.seed(lessonFixture, { status: 'candidate' });
  const second = await h.seed(noteWith(lessonContentOf({ lesson: 'Kept because the merge fails.' })), {
    status: 'candidate'
  });

  asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: first.source.id,
        expected_etag: first.source.etag,
        idempotency_key: key(30),
        rationale: 'Prepare the merged candidate.',
        note: noteWith(lessonContentOf({ lesson: 'Merged, but not yet ready.' }), {
          related_ids: [second.source.id]
        })
      }
    }, h.deps)
  );
  const revised = await currentHead(h, first.source.id);
  const before = await scopeFiles(h);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: second.source.id,
        expected_etag: second.source.etag,
        idempotency_key: key(31),
        rationale: 'The candidate is not active, so this must fail.',
        replacement_id: first.source.id
      }
    }, h.deps),
    'CONFLICT'
  );

  expect((await currentHead(h, second.source.id)).revision.status).toBe('candidate');
  expect((await currentHead(h, first.source.id)).revision.status).toBe('candidate');
  expect((await currentHead(h, first.source.id)).source.revision_id).toBe(revised.source.revision_id);
  expectUntouched(before, await scopeFiles(h));
  await h.close();
});

test('enforces non-hypothesis evidence for every factual kind', async () => {
  const h = await createHarness();
  const contents: NoteContent[] = [
    lessonContentOf(),
    { kind: 'fact', claim: 'The pinned backend reports 4.0.0b1.', applicability: 'This repository.' },
    decisionContent,
    {
      kind: 'playbook',
      use_when: 'A candidate needs promotion.',
      prerequisites: ['Reviewer credential'],
      steps: ['Read the candidate'],
      verification: ['The head is active.']
    }
  ];
  const hypothesisOnly = [{ kind: 'hypothesis' as const, ref: 'h-1', description: 'An untested guess' }];

  let index = 0;
  for (const content of contents) {
    index += 1;
    const head = await h.seed(noteWith(content, { evidence: hypothesisOnly }), { status: 'candidate' });
    await expectCode(
      review(reviewerContext, {
        scope: SCOPE,
        operation: {
          action: 'approve',
          id: head.source.id,
          expected_etag: head.source.etag,
          idempotency_key: key(40 + index),
          rationale: 'Only a hypothesis is offered.'
        }
      }, h.deps),
      'INVALID_INPUT'
    );
  }
  await h.close();
});

test('rejects a review mutation without a rationale', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'candidate' });
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(50),
        rationale: ''
      }
    }, h.deps),
    'INVALID_INPUT'
  );
  await h.close();
});

test('rejects a revise whose etag is stale', async () => {
  const h = await createHarness();
  const head = await h.seed(lessonFixture, { status: 'candidate' });
  await h.externalEdit(head, (raw) =>
    raw.replace('Measure the direct and proxied request', 'Always measure the direct and proxied request')
  );
  await h.deps.catalogue.reconcile(SCOPE);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(51),
        rationale: 'The etag is stale.',
        note: noteWith(lessonContentOf({ lesson: 'Should not be written.' }))
      }
    }, h.deps),
    'CONFLICT'
  );
  await h.close();
});

test('a review-only principal can approve, archive, supersede, and resolve without write scope', async () => {
  const h = await createHarness();
  const candidate = await h.seed(lessonFixture, { status: 'candidate' });
  const approved = asReceipt(
    await review(reviewOnlyContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: candidate.source.id,
        expected_etag: candidate.source.etag,
        idempotency_key: key(90),
        rationale: 'Review-only approval.'
      }
    }, h.deps)
  );
  expect(approved.outcome).toBe('stored');

  const archivable = await h.seed(noteWith(lessonContentOf({ lesson: 'Archive me.' })), { status: 'active' });
  const archived = asReceipt(
    await review(reviewOnlyContext, {
      scope: SCOPE,
      operation: {
        action: 'archive',
        id: archivable.source.id,
        expected_etag: archivable.source.etag,
        idempotency_key: key(91),
        rationale: 'Review-only archive.'
      }
    }, h.deps)
  );
  expect(archived.outcome).toBe('stored');

  const source = await h.seed(noteWith(lessonContentOf({ lesson: 'Supersede source.' })), { status: 'active' });
  const replacement = await h.seed(noteWith(lessonContentOf({ lesson: 'Supersede replacement.' })), {
    status: 'active'
  });
  const superseded = asReceipt(
    await review(reviewOnlyContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: source.source.id,
        expected_etag: source.source.etag,
        idempotency_key: key(92),
        rationale: 'Review-only supersede.',
        replacement_id: replacement.source.id
      }
    }, h.deps)
  );
  expect(superseded.outcome).toBe('stored');

  const root = await h.seed(noteWith(lessonContentOf({ lesson: 'Fork root.' })), { status: 'candidate' });
  const copy = await duplicateRevisionFile(h, root, 'review-only-fork');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  const copyHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, copy.revisionId);
  const resolved = asReceipt(
    await review(reviewOnlyContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(93),
        rationale: 'Review-only resolve.',
        expected_heads: [
          { revision_id: root.source.revision_id, etag: rootHead.source.etag },
          { revision_id: copy.revisionId, etag: copyHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'Resolved by a review-only principal.' }))
      }
    }, h.deps)
  );
  expect(resolved.outcome).toBe('stored');

  const reviseCandidate = await h.seed(noteWith(lessonContentOf({ lesson: 'Revise needs write.' })), {
    status: 'candidate'
  });
  await expectCode(
    review(reviewOnlyContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: reviseCandidate.source.id,
        expected_etag: reviseCandidate.source.etag,
        idempotency_key: key(94),
        rationale: 'A review-only principal cannot revise.',
        note: noteWith(lessonContentOf({ lesson: 'nope' }))
      }
    }, h.deps),
    'FORBIDDEN'
  );
  await h.close();
});

test('requires owner permission to approve notes in shared and profile scopes', async () => {
  const h = await createHarness();
  const sharedNote = await h.seed(noteWith(lessonContentOf({ lesson: 'Shared scope lesson.' })), {
    scope: 'shared',
    status: 'candidate'
  });
  const profileNote = await h.seed(noteWith(lessonContentOf({ lesson: 'Profile scope lesson.' })), {
    scope: 'profile',
    status: 'candidate'
  });

  await expectCode(
    review(scopedReviewerContext, {
      scope: 'shared',
      operation: {
        action: 'approve',
        id: sharedNote.source.id,
        expected_etag: sharedNote.source.etag,
        idempotency_key: key(95),
        rationale: 'Shared promotion needs an owner.'
      }
    }, h.deps),
    'FORBIDDEN'
  );
  await expectCode(
    review(scopedReviewerContext, {
      scope: 'profile',
      operation: {
        action: 'approve',
        id: profileNote.source.id,
        expected_etag: profileNote.source.etag,
        idempotency_key: key(96),
        rationale: 'Profile change needs an owner.'
      }
    }, h.deps),
    'FORBIDDEN'
  );

  const shared = asReceipt(
    await review(ownerContext, {
      scope: 'shared',
      operation: {
        action: 'approve',
        id: sharedNote.source.id,
        expected_etag: sharedNote.source.etag,
        idempotency_key: key(97),
        rationale: 'Owner promotes the shared lesson.'
      }
    }, h.deps)
  );
  expect(shared.outcome).toBe('stored');
  const profile = asReceipt(
    await review(ownerContext, {
      scope: 'profile',
      operation: {
        action: 'approve',
        id: profileNote.source.id,
        expected_etag: profileNote.source.etag,
        idempotency_key: key(98),
        rationale: 'Owner approves the profile lesson.'
      }
    }, h.deps)
  );
  expect(profile.outcome).toBe('stored');
  await h.close();
});

test('protects archived decisions and candidate descendants of approved decisions from reviewer revision', async () => {
  const h = await createHarness();
  const archivedSource = await h.seed(noteWith(decisionContent, { evidence: [] }), { status: 'active' });
  asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'archive',
        id: archivedSource.source.id,
        expected_etag: archivedSource.source.etag,
        idempotency_key: key(99),
        rationale: 'Archive the approved decision.'
      }
    }, h.deps)
  );
  const archived = await currentHead(h, archivedSource.source.id);
  expect(archived.revision.status).toBe('archived');
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: archived.source.id,
        expected_etag: archived.source.etag,
        idempotency_key: key(100),
        rationale: 'Reviewer must not revise an approved decision.',
        note: noteWith(decisionContent)
      }
    }, h.deps),
    'FORBIDDEN'
  );
  const ownerRevised = asReceipt(
    await review(ownerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: archived.source.id,
        expected_etag: archived.source.etag,
        idempotency_key: key(101),
        rationale: 'Owner revises the archived decision.',
        note: noteWith(decisionContent)
      }
    }, h.deps)
  );
  expect(ownerRevised.outcome).toBe('stored');

  const approved = await h.seed(noteWith(decisionContent, { evidence: [] }), { status: 'active' });
  asReceipt(
    await review(ownerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: approved.source.id,
        expected_etag: approved.source.etag,
        idempotency_key: key(102),
        rationale: 'Owner creates a candidate descendant.',
        note: noteWith(decisionContent)
      }
    }, h.deps)
  );
  const child = await currentHead(h, approved.source.id);
  expect(child.revision.status).toBe('candidate');
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: child.source.id,
        expected_etag: child.source.etag,
        idempotency_key: key(103),
        rationale: 'Reviewer must not revise an approved-decision descendant.',
        note: noteWith(decisionContent)
      }
    }, h.deps),
    'FORBIDDEN'
  );
  await h.close();
});

test('requires owner permission to resolve a fork of approved decisions', async () => {
  const h = await createHarness();
  const root = await h.seed(noteWith(decisionContent, { evidence: [] }), { status: 'active' });
  const copy = await duplicateRevisionFile(h, root, 'decision-fork');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  const copyHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, copy.revisionId);
  const expected_heads = [
    { revision_id: root.source.revision_id, etag: rootHead.source.etag },
    { revision_id: copy.revisionId, etag: copyHead.source.etag }
  ];
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(104),
        rationale: 'Reviewer must not resolve an approved decision fork.',
        expected_heads,
        note: noteWith(decisionContent)
      }
    }, h.deps),
    'FORBIDDEN'
  );
  const resolved = asReceipt(
    await review(ownerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(105),
        rationale: 'Owner resolves the decision fork.',
        expected_heads,
        note: noteWith(decisionContent)
      }
    }, h.deps)
  );
  expect(resolved.outcome).toBe('stored');
  await h.close();
});

test('refuses to resolve a structural cycle', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'revise',
        id: root.source.id,
        expected_etag: root.source.etag,
        idempotency_key: key(106),
        rationale: 'Create a child revision.',
        note: noteWith(lessonContentOf({ lesson: 'Child lesson.' }))
      }
    }, h.deps)
  );
  const child = await currentHead(h, root.source.id);
  expect(child.revision.parents.map((parent) => parent.revision_id)).toEqual([
    root.source.revision_id
  ]);

  const rootPath = vaultPath(h, root.source.relative_path);
  const raw = await readFile(rootPath, 'utf8');
  await writeFile(
    rootPath,
    raw.replace(
      /^brain_parents: \[\]$/m,
      `brain_parents:\n  - ${child.source.revision_id}@${child.raw_hash}`
    ),
    'utf8'
  );
  await h.deps.catalogue.reconcile(SCOPE);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(107),
        rationale: 'Cycles are corruption, not ordinary forks.',
        expected_heads: [{ revision_id: child.source.revision_id, etag: child.source.etag }],
        note: noteWith(lessonContentOf({ lesson: 'Should not be written.' }))
      }
    }, h.deps),
    'RECOVERY_REQUIRED'
  );
  await h.close();
});

test('fails closed on malformed and duplicate revision identities', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  const malformed = await duplicateRevisionFile(h, root, 'fork-malformed');
  const malformedRaw = await readFile(malformed.path, 'utf8');
  await writeFile(
    malformed.path,
    malformedRaw.replace(/^brain_parents: \[\]$/m, 'brain_parents: [not-a-uuid]'),
    'utf8'
  );
  await h.deps.catalogue.reconcile(SCOPE);
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(108),
        rationale: 'Malformed revisions are corruption.',
        expected_heads: [{ revision_id: root.source.revision_id, etag: rootHead.source.etag }],
        note: noteWith(lessonContentOf({ lesson: 'Should not be written.' }))
      }
    }, h.deps),
    'RECOVERY_REQUIRED'
  );
  await h.close();

  const dup = await createHarness();
  const dupRoot = await dup.seed(lessonFixture, { status: 'candidate' });
  await duplicateIdentityFile(dup, dupRoot, 'fork-duplicate-identity');
  const dupRootHead = await dup.deps.catalogue.getRevision(SCOPE, dupRoot.source.id, dupRoot.source.revision_id);
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: dupRoot.source.id,
        idempotency_key: key(109),
        rationale: 'Duplicate identities are corruption.',
        expected_heads: [{ revision_id: dupRoot.source.revision_id, etag: dupRootHead.source.etag }],
        note: noteWith(lessonContentOf({ lesson: 'Should not be written.' }))
      }
    }, dup.deps),
    'RECOVERY_REQUIRED'
  );
  await dup.close();
});

test('fails with RECOVERY_REQUIRED when a fork entry cannot be read under the lock', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  await duplicateRevisionFile(h, root, 'fork-unreadable');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);

  let armed = false;
  const originalReconcile = h.deps.catalogue.reconcile.bind(h.deps.catalogue);
  h.deps.catalogue.reconcile = async (scope) => {
    await originalReconcile(scope);
    armed = true;
  };
  const originalRead = h.deps.vault.read.bind(h.deps.vault);
  h.deps.vault.read = async (scope, path) => {
    if (armed && path.includes('fork-unreadable')) {
      throw new BrainError({ code: 'RECOVERY_REQUIRED', message: 'simulated unreadable entry' });
    }
    return originalRead(scope, path);
  };

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(110),
        rationale: 'An unreadable retained entry is structural uncertainty.',
        expected_heads: [{ revision_id: root.source.revision_id, etag: rootHead.source.etag }],
        note: noteWith(lessonContentOf({ lesson: 'Should not be written.' }))
      }
    }, h.deps),
    'RECOVERY_REQUIRED'
  );
  await h.close();
});

test('normalizes a submitted unsupported head to RECOVERY_REQUIRED', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  const unsupported = await duplicateRevisionFile(h, root, 'fork-unsupported-submitted');
  const raw = await readFile(unsupported.path, 'utf8');
  await writeFile(unsupported.path, raw.replace(/^brain_schema_version: 1$/m, 'brain_schema_version: 2'), 'utf8');
  await h.deps.catalogue.reconcile(SCOPE);
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  const unsupportedEtag = makeEtag(unsupported.revisionId, rawHashOf(await readFile(unsupported.path)));

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(111),
        rationale: 'A submitted unsupported head is corruption.',
        expected_heads: [
          { revision_id: root.source.revision_id, etag: rootHead.source.etag },
          { revision_id: unsupported.revisionId, etag: unsupportedEtag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'Should not be written.' }))
      }
    }, h.deps),
    'RECOVERY_REQUIRED'
  );
  await h.close();
});

test('rejects duplicate, extra, and stale conflict-head submissions', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  const copy = await duplicateRevisionFile(h, root, 'fork-sets');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  const copyHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, copy.revisionId);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(112),
        rationale: 'A duplicated conflict head is not the exact set.',
        expected_heads: [
          { revision_id: root.source.revision_id, etag: rootHead.source.etag },
          { revision_id: root.source.revision_id, etag: rootHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'no write' }))
      }
    }, h.deps),
    'CONFLICT'
  );
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(113),
        rationale: 'An extra conflict head is not the exact set.',
        expected_heads: [
          { revision_id: root.source.revision_id, etag: rootHead.source.etag },
          { revision_id: copy.revisionId, etag: copyHead.source.etag },
          { revision_id: randomUUID(), etag: 'a'.repeat(64) }
        ],
        note: noteWith(lessonContentOf({ lesson: 'no write' }))
      }
    }, h.deps),
    'CONFLICT'
  );

  const copyRaw = await readFile(copy.path, 'utf8');
  await writeFile(
    copy.path,
    copyRaw.replace(
      'Measure the direct and proxied request',
      'Measure the direct and proxied request now'
    ),
    'utf8'
  );
  await h.deps.catalogue.reconcile(SCOPE);
  const refreshedRoot = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(114),
        rationale: 'A stale conflict-head etag is not the exact set.',
        expected_heads: [
          { revision_id: root.source.revision_id, etag: refreshedRoot.source.etag },
          { revision_id: copy.revisionId, etag: copyHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'no write' }))
      }
    }, h.deps),
    'CONFLICT'
  );
  await h.close();
});

test('rejects a resolve when a new fork head appeared after the caller read the fork', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  const copy = await duplicateRevisionFile(h, root, 'fork-concurrent-a');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  const copyHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, copy.revisionId);
  await duplicateRevisionFile(h, root, 'fork-concurrent-b');

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(115),
        rationale: 'A third head appeared after the caller read the fork.',
        expected_heads: [
          { revision_id: root.source.revision_id, etag: rootHead.source.etag },
          { revision_id: copy.revisionId, etag: copyHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'no write' }))
      }
    }, h.deps),
    'CONFLICT'
  );
  await h.close();
});

test('rejects a supersession when the replacement became inactive before the locked check', async () => {
  const h = await createHarness();
  const source = await h.seed(lessonFixture, { status: 'active' });
  const replacement = await h.seed(noteWith(lessonContentOf({ lesson: 'Replacement goes inactive.' })), {
    status: 'active'
  });

  const originalGet = h.deps.catalogue.get.bind(h.deps.catalogue);
  h.deps.catalogue.get = async (scope, id) => {
    const head = await originalGet(scope, id);
    if (id === replacement.source.id) {
      return {
        ...head,
        revision: { ...head.revision, status: 'superseded' as const },
        source: { ...head.source, status: 'superseded' as const }
      };
    }
    return head;
  };

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: source.source.id,
        expected_etag: source.source.etag,
        idempotency_key: key(116),
        rationale: 'The replacement went inactive concurrently.',
        replacement_id: replacement.source.id
      }
    }, h.deps),
    'CONFLICT'
  );
  await h.close();
});

test('releases the reservation when a review request is rejected before submission', async () => {
  const h = await createHarness();
  const root = await h.seed(lessonFixture, { status: 'candidate' });
  const copy = await duplicateRevisionFile(h, root, 'abort-fork');
  const rootHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, root.source.revision_id);
  const copyHead = await h.deps.catalogue.getRevision(SCOPE, root.source.id, copy.revisionId);
  const rationale = 'Partial conflict-head set aborts the reservation.';

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(117),
        rationale,
        expected_heads: [{ revision_id: root.source.revision_id, etag: rootHead.source.etag }],
        note: noteWith(lessonContentOf({ lesson: 'first attempt' }))
      }
    }, h.deps),
    'CONFLICT'
  );
  expect(h.deps.journal.pending()).toHaveLength(0);

  const receipt = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'resolve',
        id: root.source.id,
        idempotency_key: key(117),
        rationale,
        expected_heads: [
          { revision_id: root.source.revision_id, etag: rootHead.source.etag },
          { revision_id: copy.revisionId, etag: copyHead.source.etag }
        ],
        note: noteWith(lessonContentOf({ lesson: 'first attempt' }))
      }
    }, h.deps)
  );
  expect(receipt.outcome).toBe('stored');
  await h.close();
});

test('rejects a supersession whose replacement chain contains a conflicted link', async () => {
  const h = await createHarness();
  const source = await h.seed(lessonFixture, { status: 'active' });
  const replacement = await h.seed(noteWith(lessonContentOf({ lesson: 'Chain head.' })), {
    status: 'active'
  });
  const chainLink = await h.seed(noteWith(lessonContentOf({ lesson: 'Chain link.' })), {
    status: 'active'
  });
  await h.externalEdit(replacement, (raw) =>
    raw.replace(/^(brain_status:.*)$/m, `$1\nbrain_replacement_id: ${chainLink.source.id}`)
  );
  await duplicateRevisionFile(h, chainLink, 'chain-link-conflict');
  await h.deps.catalogue.reconcile(SCOPE);

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'supersede',
        id: source.source.id,
        expected_etag: source.source.etag,
        idempotency_key: key(119),
        rationale: 'A conflicted replacement-chain link must not be concealed.',
        replacement_id: replacement.source.id
      }
    }, h.deps),
    'CONFLICT'
  );
  await h.close();
});

test('releases the reservation when a builder rejects a review request before submission', async () => {
  const h = await createHarness();
  const head = await h.seed(
    { ...lessonFixture, evidence: [{ kind: 'hypothesis', ref: 'h-1', description: 'An untested guess' }] },
    { status: 'candidate' }
  );

  await expectCode(
    review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'approve',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(118),
        rationale: 'Only a hypothesis is offered.'
      }
    }, h.deps),
    'INVALID_INPUT'
  );
  expect(h.deps.journal.pending()).toHaveLength(0);

  const archived = asReceipt(
    await review(reviewerContext, {
      scope: SCOPE,
      operation: {
        action: 'archive',
        id: head.source.id,
        expected_etag: head.source.etag,
        idempotency_key: key(118),
        rationale: 'Archive with the released key.'
      }
    }, h.deps)
  );
  expect(archived.outcome).toBe('stored');
  await h.close();
});
