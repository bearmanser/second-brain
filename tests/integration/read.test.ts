import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { RENDERED_NOTE_MAX_BYTES } from '../../src/core/limits.js';
import type { MutationReceipt, NoteInput, StoredRevision } from '../../src/core/types.js';
import { clampReadBudget, paginate, read, READ_WARNING_HISTORICAL } from '../../src/features/read.js';
import { review } from '../../src/features/review.js';
import { renderRevision } from '../../src/notes/codec.js';
import { relativePathFor } from '../../src/notes/identity.js';
import { countReferenceTokens } from '../../src/retrieval/budget.js';
import { signCursor } from '../../src/retrieval/cursor.js';
import { lessonFixture } from '../fixtures/content.js';
import { reviewerContext, scopeFixtures, workerContext } from '../fixtures/principals.js';
import { createHarness, type MemoryHarness } from '../support/harness.js';

const secretRoot = join(tmpdir(), 'brain-read-secret-tests');
const FILLER = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ';

async function installSecret(h: MemoryHarness, fill = 7): Promise<Uint8Array> {
  await mkdir(secretRoot, { recursive: true });
  const directory = await mkdtemp(join(secretRoot, 'case-'));
  const path = join(directory, 'cursor-key');
  const secret = new Uint8Array(32).fill(fill);
  await writeFile(path, Buffer.from(secret));
  h.deps.config.cursor_secret_file = path;
  return secret;
}

function vaultAbsolute(h: MemoryHarness, relativePath: string): string {
  return join(h.deps.config.mounts.vault, ...relativePath.split('/'));
}

async function writeVaultFile(
  h: MemoryHarness,
  relativePath: string,
  content: string
): Promise<void> {
  const absolute = vaultAbsolute(h, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

function forge(body: Record<string, unknown>, secret: Uint8Array): string {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  const signature = createHmac('sha256', secret).update(bytes).digest();
  return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
}

function longLesson(chars: number): NoteInput {
  return {
    ...lessonFixture,
    title: 'Long lesson fixture',
    content: {
      kind: 'lesson',
      situation: 'A note long enough to require more than one read page.',
      lesson: FILLER.repeat(Math.ceil(chars / FILLER.length)).slice(0, chars),
      applicability: 'Read pagination coverage.'
    }
  };
}

function emojiLesson(): NoteInput {  return {
    ...lessonFixture,
    title: 'Multibyte lesson fixture',
    content: {
      kind: 'lesson',
      situation: 'Unicode boundaries matter when paging.',
      lesson: '🚀✨🛰️ 星空 データ Ω≈ç√ '.repeat(200),
      applicability: 'Pagination must not split a code point.'
    }
  };
}

test('clamps the read budget to the documented range', () => {
  expect(clampReadBudget(undefined)).toBe(4000);
  expect(clampReadBudget(Number.NaN)).toBe(4000);
  expect(clampReadBudget(1)).toBe(256);
  expect(clampReadBudget(10_000_000)).toBe(8000);
  expect(clampReadBudget(1234.9)).toBe(1234);
});

test('paginate keeps progress and never splits a code point', () => {
  expect(paginate('abc', 5, 100)).toEqual({ page: '' });
  const tiny = paginate('🚀🚀🚀', 0, 0);
  expect(tiny.page).toBe('🚀');
  expect(tiny.nextOffset).toBe(1);
});

test('reads the current head with an etag and source reference', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(lessonFixture);
  const file = await h.deps.vault.read('freellmapi', head.source.relative_path);
  const result = await read(workerContext, { scope: 'freellmapi', id: head.revision.id }, h.deps);
  expect(result.markdown).toBe(file.raw);
  expect(result.next_cursor).toBeUndefined();
  expect(result.source.id).toBe(head.revision.id);
  expect(result.source.revision_id).toBe(head.revision.revision_id);
  expect(result.source.etag).toBe(head.source.etag);
  expect(result.source.relative_path).toBe(head.source.relative_path);
  await h.close();
});

test('rejects a scope the caller may not read', async () => {
  const h = await createHarness();
  await installSecret(h);
  await expect(
    read(workerContext, { scope: 'profile', id: randomUUID() }, h.deps)
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await h.close();
});

test('returns NOT_FOUND for an unknown id', async () => {
  const h = await createHarness();
  await installSecret(h);
  await expect(
    read(workerContext, { scope: 'freellmapi', id: randomUUID() }, h.deps)
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await h.close();
});

test('pages a long note and returns the next cursor only when more remains', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(longLesson(8000));
  const file = await h.deps.vault.read('freellmapi', head.source.relative_path);
  let cursor: string | undefined;
  let combined = '';
  let pages = 0;
  do {
    const result = await read(
      workerContext,
      cursor === undefined
        ? { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256 }
        : { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256, cursor },
      h.deps
    );
    expect(countReferenceTokens(result.markdown)).toBeLessThanOrEqual(256);
    expect(result.source.etag).toBe(head.source.etag);
    combined += result.markdown;
    pages += 1;
    cursor = result.next_cursor;
  } while (cursor !== undefined);
  expect(pages).toBeGreaterThan(1);
  expect(combined).toBe(file.raw);
  await h.close();
});

test('splits multi-byte text only at code-point boundaries', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(emojiLesson());
  const file = await h.deps.vault.read('freellmapi', head.source.relative_path);
  let cursor: string | undefined;
  let combined = '';
  let pages = 0;
  do {
    const result = await read(
      workerContext,
      cursor === undefined
        ? { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256 }
        : { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256, cursor },
      h.deps
    );
    expect(result.markdown.includes('\uFFFD')).toBe(false);
    expect(Buffer.from(result.markdown, 'utf8').toString('utf8')).toBe(result.markdown);
    combined += result.markdown;
    pages += 1;
    cursor = result.next_cursor;
  } while (cursor !== undefined);
  expect(pages).toBeGreaterThan(1);
  expect(combined).toBe(file.raw);
  await h.close();
});

test('returns an old revision with a historical warning', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(lessonFixture);
  const revised = (await review(
    reviewerContext,
    {
      scope: 'freellmapi',
      operation: {
        action: 'revise',
        idempotency_key: randomUUID(),
        id: head.revision.id,
        expected_etag: head.source.etag,
        rationale: 'test revision for read history',
        note: { ...lessonFixture, title: 'Revised lesson fixture' }
      }
    },
    h.deps
  )) as MutationReceipt;
  expect(revised.outcome).toBe('stored');
  const updated = await h.deps.catalogue.get('freellmapi', head.revision.id);
  expect(updated.revision.revision_id).not.toBe(head.revision.revision_id);
  const oldFile = await h.deps.vault.read('freellmapi', head.source.relative_path);
  const result = await read(
    workerContext,
    { scope: 'freellmapi', id: head.revision.id, revision_id: head.revision.revision_id },
    h.deps
  );
  expect(result.source.revision_id).toBe(head.revision.revision_id);
  expect(result.source.warnings).toContain(READ_WARNING_HISTORICAL);
  expect(result.markdown).toBe(oldFile.raw);
  await h.close();
});

test('refuses to continue a page after the file changed', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(longLesson(4000));
  const first = await read(
    workerContext,
    { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256 },
    h.deps
  );
  expect(first.next_cursor).toBeDefined();
  await h.externalEdit(head, (raw) => raw.replace('alpha beta', 'ALPHA BETA'));
  await expect(
    read(
      workerContext,
      { scope: 'freellmapi', id: head.revision.id, cursor: first.next_cursor as string },
      h.deps
    )
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await h.close();
});

test('returns NOT_FOUND when the source disappeared', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(longLesson(4000));
  const first = await read(
    workerContext,
    { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256 },
    h.deps
  );
  expect(first.next_cursor).toBeDefined();
  await rm(vaultAbsolute(h, head.source.relative_path));
  await expect(
    read(
      workerContext,
      { scope: 'freellmapi', id: head.revision.id, cursor: first.next_cursor as string },
      h.deps
    )
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(
    read(workerContext, { scope: 'freellmapi', id: head.revision.id }, h.deps)
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await h.close();
});

test("rejects another caller's cursor", async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(longLesson(4000));
  const first = await read(
    reviewerContext,
    { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256 },
    h.deps
  );
  await expect(
    read(
      workerContext,
      { scope: 'freellmapi', id: head.revision.id, cursor: first.next_cursor as string },
      h.deps
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await h.close();
});

test('rejects an expired cursor', async () => {
  const h = await createHarness();
  const secret = await installSecret(h);
  const head = await h.seed(longLesson(4000));
  const expired = signCursor(
    {
      principal_id: workerContext.principal.id,
      scope: 'freellmapi',
      id: head.revision.id,
      revision_id: head.revision.revision_id,
      raw_hash: head.raw_hash,
      offset: 10,
      expires_at: '2000-01-01T00:00:00Z'
    },
    secret
  );
  await expect(
    read(workerContext, { scope: 'freellmapi', id: head.revision.id, cursor: expired }, h.deps)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await h.close();
});

test('rejects truncated and tampered tokens', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(longLesson(4000));
  const first = await read(
    workerContext,
    { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256 },
    h.deps
  );
  const token = first.next_cursor as string;
  const [body] = token.split('.');
  await expect(
    read(workerContext, { scope: 'freellmapi', id: head.revision.id, cursor: body }, h.deps)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    read(
      workerContext,
      { scope: 'freellmapi', id: head.revision.id, cursor: `${body}.deadbeef` },
      h.deps
    )
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await h.close();
});

test('a cursor carries no path and cannot redirect the read outside its scope', async () => {
  const h = await createHarness();
  const secret = await installSecret(h);
  const head = await h.seed(longLesson(4000));
  const seen: string[] = [];
  const original = h.deps.vault.read.bind(h.deps.vault);
  h.deps.vault.read = async (scope, relativePath) => {
    seen.push(`${scope}:${relativePath}`);
    return original(scope, relativePath);
  };
  const first = await read(
    workerContext,
    { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256 },
    h.deps
  );
  const second = await read(
    workerContext,
    { scope: 'freellmapi', id: head.revision.id, cursor: first.next_cursor as string },
    h.deps
  );
  expect(second.markdown.length).toBeGreaterThan(0);
  expect(seen.length).toBeGreaterThan(0);
  for (const entry of seen) {
    expect(entry.startsWith('freellmapi:freellmapi/')).toBe(true);
    expect(entry).not.toContain('..');
  }

  const future = new Date(Date.now() + 600_000).toISOString();
  const forged = forge(
    {
      principal_id: workerContext.principal.id,
      scope: 'freellmapi',
      id: head.revision.id,
      revision_id: head.revision.revision_id,
      raw_hash: head.raw_hash,
      offset: 0,
      expires_at: future,
      relative_path: '../../etc/passwd'
    },
    secret
  );
  await expect(
    read(workerContext, { scope: 'freellmapi', id: head.revision.id, cursor: forged }, h.deps)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

  const otherScope = signCursor(
    {
      principal_id: workerContext.principal.id,
      scope: 'shared',
      id: head.revision.id,
      revision_id: head.revision.revision_id,
      raw_hash: head.raw_hash,
      offset: 0,
      expires_at: future
    },
    secret
  );
  await expect(
    read(workerContext, { scope: 'freellmapi', id: head.revision.id, cursor: otherScope }, h.deps)
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await h.close();
});

test('requires a unique valid head', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(lessonFixture);
  const raw = await readFile(vaultAbsolute(h, head.source.relative_path), 'utf8');
  const directory = head.source.relative_path.split('/').slice(0, -1).join('/');
  await writeVaultFile(h, `${directory}/duplicate.md`, raw);
  await h.deps.catalogue.reconcile('freellmapi');
  await expect(
    read(workerContext, { scope: 'freellmapi', id: head.revision.id }, h.deps)
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await h.close();
});

test('returns UNSUPPORTED_SCHEMA without inventing a source reference', async () => {
  const h = await createHarness();
  await installSecret(h);
  const id = randomUUID();
  const revisionId = randomUUID();
  const raw = [
    '---',
    'title: "Future schema"',
    'type: lesson',
    'brain_schema_version: 2',
    `brain_id: ${id}`,
    `brain_revision_id: ${revisionId}`,
    'brain_scope: freellmapi',
    'brain_status: candidate',
    '---',
    '',
    'body'
  ].join('\n');
  await writeVaultFile(h, `freellmapi/Lessons/${id}/${revisionId}.md`, raw);
  await h.deps.catalogue.reconcile('freellmapi');
  await expect(
    read(workerContext, { scope: 'freellmapi', id }, h.deps)
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
  await h.close();
});

test('fails closed when the cursor secret is not configured', async () => {
  const h = await createHarness();
  const head = await h.seed(longLesson(4000));
  await expect(
    read(workerContext, { scope: 'freellmapi', id: head.revision.id, budget_tokens: 256 }, h.deps)
  ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await h.close();
});

test('clamps an over-large requested budget to the documented maximum', async () => {
  const h = await createHarness();
  await installSecret(h);
  const head = await h.seed(longLesson(8000));
  const result = await read(
    workerContext,
    { scope: 'freellmapi', id: head.revision.id, budget_tokens: 999_999 },
    h.deps
  );
  expect(countReferenceTokens(result.markdown)).toBeLessThanOrEqual(8000);
  expect(result.next_cursor).toBeUndefined();
  await h.close();
});

test('reads a 64 KiB document across pages within the limit', async () => {
  const h = await createHarness();
  await installSecret(h);
  const scope = scopeFixtures.find((entry) => entry.id === 'freellmapi');
  if (scope === undefined) throw new Error('freellmapi scope fixture missing');
  const id = randomUUID();
  const revisionId = randomUUID();
  const words = `${FILLER}${FILLER}`;
  const limitation = (length: number): string => {
    const slice = words.repeat(Math.ceil(length / words.length) + 1).slice(0, length);
    return slice.endsWith(' ') ? `${slice.slice(0, -1)}x` : slice;
  };
  const itemCount = 10;
  const lengths = new Array<number>(itemCount).fill(1);
  const noteFor = (limitations: string[]): NoteInput => ({
    ...lessonFixture,
    title: 'Large lesson fixture',
    content: {
      kind: 'lesson',
      situation: 'A note large enough to exercise the 64 KiB read boundary.',
      lesson: 'Pagination must remain code-point safe.',
      applicability: 'Read boundary coverage.',
      limitations
    }
  });
  const revisionFor = (note: NoteInput): StoredRevision => ({
    id,
    revision_id: revisionId,
    parents: [],
    scope: 'freellmapi',
    status: 'candidate',
    note,
    created_at: '2026-09-20T00:00:00Z',
    modified_at: '2026-09-20T00:00:00Z',
    operation_id: randomUUID(),
    extra_frontmatter: {},
    extra_markdown: ''
  });
  const baseBytes = Buffer.byteLength(
    renderRevision(revisionFor(noteFor(lengths.map(limitation))), scope),
    'utf8'
  );
  let remaining = RENDERED_NOTE_MAX_BYTES - baseBytes;
  expect(remaining).toBeGreaterThan(0);
  for (let index = 0; remaining > 0; index = (index + 1) % itemCount) {
    const room = 8000 - lengths[index];
    if (room <= 0) continue;
    const add = Math.min(room, remaining);
    lengths[index] += add;
    remaining -= add;
  }
  const raw = renderRevision(revisionFor(noteFor(lengths.map(limitation))), scope);
  expect(Buffer.byteLength(raw, 'utf8')).toBe(RENDERED_NOTE_MAX_BYTES);
  await writeVaultFile(
    h,
    relativePathFor(scope.relative_root, 'lesson', id, lessonFixture.title, revisionId),
    raw
  );
  await h.deps.catalogue.reconcile('freellmapi');

  let cursor: string | undefined;
  let combined = '';
  let pages = 0;
  do {
    const result = await read(
      workerContext,
      cursor === undefined
        ? { scope: 'freellmapi', id }
        : { scope: 'freellmapi', id, cursor },
      h.deps
    );
    expect(countReferenceTokens(result.markdown)).toBeLessThanOrEqual(4000);
    expect(Buffer.byteLength(result.markdown, 'utf8')).toBeLessThanOrEqual(RENDERED_NOTE_MAX_BYTES);
    combined += result.markdown;
    pages += 1;
    cursor = result.next_cursor;
  } while (cursor !== undefined);
  expect(pages).toBeGreaterThan(1);
  expect(combined).toBe(raw);
  await h.close();
}, 60_000);
