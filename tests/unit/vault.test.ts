import { afterEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BrainError, type BrainErrorCode } from '../../src/contracts/errors.js';
import type { ScopeConfig, StoredRevision } from '../../src/core/types.js';
import { renderRevision } from '../../src/notes/codec.js';
import { hashRaw, relativePathFor } from '../../src/notes/identity.js';
import { FileVault } from '../../src/storage/vault.js';
import { fixtureIds, lessonFixture } from '../fixtures/content.js';

const temporaryRoot = join('/tmp/opencode', 'brain-vault-tests');
const temporaryDirectories: string[] = [];

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

const writeFile = (root: string, relativePath: string, contents: string): string => {
  const absolute = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
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

const managedPath = (revision: StoredRevision): string =>
  relativePathFor(
    scopeConfig.relative_root,
    revision.note.content.kind,
    revision.id,
    revision.note.title,
    revision.revision_id
  );

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

test('lists only managed Markdown inside the configured scope root', async () => {
  const root = makeVaultRoot();
  const first = makeRevision();
  const nested = makeRevision();
  const otherScopeRevision = makeRevision({ scope: sharedScope.id });

  const firstPath = managedPath(first);
  writeFile(root, firstPath, renderRevision(first, scopeConfig));
  const nestedPath = managedPath(nested);
  writeFile(root, nestedPath, renderRevision(nested, scopeConfig));
  writeFile(root, 'freellmapi/.obsidian/hidden.md', renderRevision(otherScopeRevision, sharedScope));
  writeFile(root, 'freellmapi/.git/config', 'not markdown');
  writeFile(root, 'freellmapi/README.txt', renderRevision(otherScopeRevision, sharedScope));
  writeFile(root, 'freellmapi/Notes/plain.md', '# A human note with no Brain schema marker\n');
  writeFile(root, 'freellmapi/Lessons/notes.txt', 'ignored');
  writeFile(root, 'shared/Projects/kept.md', renderRevision(otherScopeRevision, sharedScope));

  const vault = new FileVault(root, [scopeConfig, sharedScope]);
  const listed = await vault.list(scopeConfig.id);
  expect(listed).toEqual([firstPath, nestedPath].sort());
  expect(await vault.list(sharedScope.id)).toEqual(['shared/Projects/kept.md']);
});

test('reads managed bytes and returns their exact hash and relative path', async () => {
  const root = makeVaultRoot();
  const revision = makeRevision();
  const path = managedPath(revision);
  const raw = renderRevision(revision, scopeConfig);
  writeFile(root, path, raw);

  const vault = new FileVault(root, [scopeConfig]);
  const read = await vault.read(scopeConfig.id, path);
  expect(read.raw).toBe(raw);
  expect(read.raw_hash).toBe(hashRaw(raw));
  expect(read.raw_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(read.relative_path).toBe(path);
  expect(await vault.read(scopeConfig.id, path)).toEqual(read);
});

test('rejects traversal, encoded traversal, absolute, and foreign-root paths', async () => {
  const root = makeVaultRoot();
  const vault = new FileVault(root, [scopeConfig, sharedScope]);

  await expectBrain(vault.read(scopeConfig.id, 'freellmapi/../shared/secret.md'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, 'freellmapi/Notes/%2e%2e/%2e%2e/secret.md'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, 'freellmapi/Notes/%2E%2E/secret.md'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, '/etc/passwd'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, 'freellmapi\\Notes\\lesson.md'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, 'shared/secret.md'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, 'freellmapi'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, 'freellmapi/Notes/./lesson.md'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, 'freellmapi/Notes//lesson.md'), 'FORBIDDEN');
  await expectBrain(vault.read(scopeConfig.id, 'freellmapi/Notes/lesson.txt'), 'INVALID_INPUT');
});

test('rejects a symlinked directory and a symlinked Markdown leaf', async () => {
  const root = makeVaultRoot();
  const outside = makeVaultRoot();
  const revision = makeRevision();
  writeFile(outside, 'secret.md', renderRevision(revision, scopeConfig));

  mkdirSync(join(root, 'freellmapi', 'Lessons'), { recursive: true });
  symlinkSync(outside, join(root, 'freellmapi', 'Lessons', 'linked'), 'dir');
  mkdirSync(join(root, 'freellmapi', 'Notes', revision.id), { recursive: true });
  symlinkSync(
    join(outside, 'secret.md'),
    join(root, 'freellmapi', 'Notes', revision.id, 'leaf.md'),
    'file'
  );

  const vault = new FileVault(root, [scopeConfig]);
  expect(await vault.list(scopeConfig.id)).toEqual([]);
  await expectBrain(
    vault.read(scopeConfig.id, 'freellmapi/Lessons/linked/secret.md'),
    'FORBIDDEN'
  );
  await expectBrain(
    vault.read(scopeConfig.id, `freellmapi/Notes/${revision.id}/leaf.md`),
    'FORBIDDEN'
  );
});

test('bounds the file size at the rendered-note limit', async () => {
  const root = makeVaultRoot();
  writeFile(root, 'freellmapi/Notes/big.md', 'x'.repeat(70 * 1024));
  const vault = new FileVault(root, [scopeConfig]);
  await expectBrain(vault.read(scopeConfig.id, 'freellmapi/Notes/big.md'), 'LIMIT_EXCEEDED');
});

test('reports missing files and unconfigured scopes distinctly', async () => {
  const root = makeVaultRoot();
  const vault = new FileVault(root, [scopeConfig]);
  await expectBrain(
    vault.read(scopeConfig.id, 'freellmapi/Notes/00000000-0000-4000-8000-000000000000/x.md'),
    'NOT_FOUND'
  );
  await expectBrain(vault.read('profile', 'profile/x.md'), 'FORBIDDEN');
  await expectBrain(vault.list('profile'), 'FORBIDDEN');
});
