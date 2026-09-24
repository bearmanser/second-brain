import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  CurrentCatalogue,
  observeCurrentVault,
  readCurrentSource,
  reconcileCurrentVault
} from '../../src/notes/current-catalogue.js';
import { openDocumentStore } from '../../src/storage/document-store.js';
import { openRevisionStore, type RevisionStore } from '../../src/storage/revision-store.js';
import { FileVault } from '../../src/storage/vault.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

interface Fixture {
  vault: string;
  state: string;
  catalogue: CurrentCatalogue;
  revisions: RevisionStore;
  fileVault: FileVault;
  dispose: () => Promise<void>;
}

const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    if (dispose !== undefined) await dispose().catch(() => undefined);
  }
});

async function fixture(): Promise<Fixture> {
  const sandbox = await vaultSandbox();
  const fileVault = new FileVault(sandbox.vault, []);
  const revisions = await openRevisionStore(sandbox.state);
  const catalogue = CurrentCatalogue.open({ revisions });
  disposers.push(async () => {
    catalogue.close();
    await sandbox.dispose();
  });
  return { ...sandbox, catalogue, revisions, fileVault, dispose: sandbox.dispose };
}

function hash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function managedNote(
  id: string,
  title: string,
  options: { status?: string; type?: string; body?: string } = {}
): string {
  const status = options.status ?? 'candidate';
  const type = options.type ?? 'note';
  const body = options.body ?? `# ${title}\n`;
  return `---\nid: ${id}\nbrain_schema_version: 2\ntype: ${type}\nstatus: ${status}\n---\n\n${body}`;
}

async function writeVault(vault: string, relativePath: string, raw: string): Promise<void> {
  const absolute = join(vault, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, raw, 'utf8');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('a new plain Markdown note is indexed by path without rewriting it', async () => {
  const f = await fixture();
  const raw = '# Human note\n\nThis was written in Obsidian.\n';
  await writeVault(f.vault, 'Knowledge/Human note.md', raw);

  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  expect(report.added.map((entry) => entry.path)).toEqual(['Knowledge/Human note.md']);
  expect(report.malformed).toEqual([]);

  const entry = f.catalogue.getByPath('Knowledge/Human note.md');
  expect(entry?.id).toBeUndefined();
  expect(entry?.title).toBe('Human note');
  expect(entry?.hash).toBe(hash(raw));
  expect(await readFile(join(f.vault, 'Knowledge/Human note.md'), 'utf8')).toBe(raw);
});

test('a new managed ID registers the current document', async () => {
  const f = await fixture();
  const id = randomUUID();
  await writeVault(f.vault, 'Knowledge/Managed.md', managedNote(id, 'Managed'));

  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  expect(report.added).toHaveLength(1);
  expect(report.added[0].id).toBe(id);

  const entry = f.catalogue.getById(id);
  expect(entry?.path).toBe('Knowledge/Managed.md');
  expect(f.catalogue.resolve({ id })?.path).toBe('Knowledge/Managed.md');
  expect(f.catalogue.historyFor(id)?.revision_id).toBeDefined();
});

test('an external rename preserves the managed ID and its history', async () => {
  const f = await fixture();
  const id = randomUUID();
  const original = managedNote(id, 'Moved', { body: '# Moved\n\nOriginal bytes.\n' });
  await writeVault(f.vault, 'Knowledge/Before.md', original);
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  const before = f.catalogue.getById(id);
  expect(before?.revision_id).toBeDefined();

  await mkdir(join(f.vault, 'Knowledge'), { recursive: true });
  const { rename } = await import('node:fs/promises');
  await rename(join(f.vault, 'Knowledge/Before.md'), join(f.vault, 'Knowledge/After.md'));

  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  expect(report.moved).toEqual([
    { id, from: 'Knowledge/Before.md', to: 'Knowledge/After.md' }
  ]);
  expect(report.removed).toEqual([]);

  const after = f.catalogue.getById(id);
  expect(after?.path).toBe('Knowledge/After.md');
  expect(after?.revision_id).toBe(before?.revision_id);
  expect(f.catalogue.getByPath('Knowledge/Before.md')).toBeUndefined();
  const stored = await f.revisions.readRevision(id, before?.revision_id ?? '');
  expect(stored.raw).toBe(original);
});

test('changed bytes preserve the observed prior snapshot and invalidate the old etag', async () => {
  const f = await fixture();
  const id = randomUUID();
  await writeVault(f.vault, 'Knowledge/Changing.md', managedNote(id, 'Changing', { body: '# Changing\n\nAlpha.\n' }));
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  const before = f.catalogue.getById(id);
  expect(before?.revision_id).toBeDefined();

  await sleep(5);
  await writeVault(f.vault, 'Knowledge/Changing.md', managedNote(id, 'Changing', { body: '# Changing\n\nBeta.\n' }));
  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  expect(report.changed).toEqual([
    {
      path: 'Knowledge/Changing.md',
      id,
      previous_etag: before?.etag,
      etag: hash(await readFile(join(f.vault, 'Knowledge/Changing.md'), 'utf8'))
    }
  ]);
  const after = f.catalogue.getById(id);
  expect(after?.etag).not.toBe(before?.etag);
  expect(after?.revision_id).not.toBe(before?.revision_id);

  await f.revisions.verifyPreimage(id, before?.hash ?? '');
  const prior = await f.revisions.readRevision(id, before?.revision_id ?? '');
  expect(prior.raw).toContain('Alpha.');
});

test('a missing path removes current search entries but retains history', async () => {
  const f = await fixture();
  const id = randomUUID();
  await writeVault(f.vault, 'Knowledge/Deleted.md', managedNote(id, 'Deleted'));
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  const before = f.catalogue.getById(id);

  await rm(join(f.vault, 'Knowledge/Deleted.md'));
  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  expect(report.removed).toEqual([{ path: 'Knowledge/Deleted.md', id, retained_revision_id: before?.revision_id }]);
  expect(f.catalogue.getById(id)).toBeUndefined();
  expect(f.catalogue.getByPath('Knowledge/Deleted.md')).toBeUndefined();
  expect(f.catalogue.historyFor(id)?.revision_id).toBe(before?.revision_id);
  const stored = await f.revisions.readRevision(id, before?.revision_id ?? '');
  expect(stored.raw).toContain('# Deleted');
});

test('a duplicated managed ID is a conflict report, never a silent replacement', async () => {
  const f = await fixture();
  const id = randomUUID();
  const raw = managedNote(id, 'Duplicated');
  await writeVault(f.vault, 'Knowledge/Original.md', raw);
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  await writeVault(f.vault, 'Knowledge/Copy.md', raw);
  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  expect(report.duplicate_ids).toEqual([
    { id, paths: ['Knowledge/Copy.md', 'Knowledge/Original.md'] }
  ]);
  expect(f.catalogue.getById(id)?.path).toBe('Knowledge/Original.md');
  expect(f.catalogue.getByPath('Knowledge/Copy.md')).toBeUndefined();
  expect(report.moved).toEqual([]);
});

test('invalid managed metadata is reported without stopping unrelated search', async () => {
  const f = await fixture();
  await writeVault(f.vault, 'Knowledge/Broken.md', '---\nid: [unclosed\n---\n\n# Broken\n');
  await writeVault(f.vault, 'Knowledge/Searchable.md', '# Searchable\n\nFind me here.\n');

  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  expect(report.malformed.map((entry) => entry.path)).toEqual(['Knowledge/Broken.md']);
  expect(report.added.map((entry) => entry.path)).toEqual(['Knowledge/Searchable.md']);
  expect(f.catalogue.getByPath('Knowledge/Searchable.md')?.title).toBe('Searchable');
  expect(f.catalogue.getByPath('Knowledge/Broken.md')).toBeUndefined();
});

test('a normal Obsidian note without frontmatter is readable by path and title', async () => {
  const f = await fixture();
  const raw = '# My Human Note\n\nJust prose.\n';
  await writeVault(f.vault, 'Personal/My Human Note.md', raw);
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  const byPath = await readCurrentSource({
    vault: f.fileVault,
    catalogue: f.catalogue,
    reference: { path: 'Personal/My Human Note.md' }
  });
  expect(byPath.state).toBe('current');
  expect(byPath.state === 'current' ? byPath.source.title : undefined).toBe('My Human Note');

  const byTitle = await readCurrentSource({
    vault: f.fileVault,
    catalogue: f.catalogue,
    reference: { title: 'My Human Note' }
  });
  expect(byTitle.state).toBe('current');
  expect(byTitle.state === 'current' ? byTitle.source.path : undefined).toBe('Personal/My Human Note.md');
});

test('a read verifies the source hash and omits or refreshes stale content', async () => {
  const f = await fixture();
  const id = randomUUID();
  await writeVault(f.vault, 'Knowledge/Stale.md', managedNote(id, 'Stale', { body: '# Stale\n\nFirst.\n' }));
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  const before = f.catalogue.getById(id);

  await writeVault(f.vault, 'Knowledge/Stale.md', managedNote(id, 'Stale', { body: '# Stale\n\nSecond.\n' }));

  const stale = await readCurrentSource({
    vault: f.fileVault,
    catalogue: f.catalogue,
    reference: { id },
    refresh: false
  });
  expect(stale.state).toBe('stale');
  expect(stale.state === 'stale' ? stale.source.hash : undefined).toBe(before?.hash);

  const refreshed = await readCurrentSource({
    vault: f.fileVault,
    catalogue: f.catalogue,
    reference: { id }
  });
  expect(refreshed.state).toBe('refreshed');
  expect(refreshed.state === 'refreshed' ? refreshed.source.hash : undefined).not.toBe(before?.hash);

  await rm(join(f.vault, 'Knowledge/Stale.md'));
  const missing = await readCurrentSource({
    vault: f.fileVault,
    catalogue: f.catalogue,
    reference: { id }
  });
  expect(missing.state).toBe('missing');
  expect(f.catalogue.getById(id)).toBeUndefined();
});

test('a server write updates the current index immediately', async () => {
  const f = await fixture();
  const store = await openDocumentStore({
    vault: f.vault,
    state: f.state,
    index: f.catalogue
  });
  try {
    const result = await store.put({
      path: 'Inbox/Server.md',
      raw: '# Server written\n\nBody.\n',
      expectedEtag: null,
      idempotencyKey: 'server-write-1',
      source: 'test'
    });
    expect(f.catalogue.getById(result.id)?.path).toBe('Inbox/Server.md');
    expect(f.catalogue.getById(result.id)?.hash).toBe(result.etag);
  } finally {
    await store.close();
  }
});

test('manual metadata edits are user data and are not gated by creator privileges', async () => {
  const f = await fixture();
  const active = randomUUID();
  const candidate = randomUUID();
  await writeVault(f.vault, 'Knowledge/Active.md', managedNote(active, 'Active', { status: 'active' }));
  await writeVault(f.vault, 'Knowledge/Candidate.md', managedNote(candidate, 'Candidate', { status: 'candidate' }));
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  expect(f.catalogue.getById(active)?.status).toBe('active');
  expect(f.catalogue.getById(candidate)?.status).toBe('candidate');
  const read = await readCurrentSource({
    vault: f.fileVault,
    catalogue: f.catalogue,
    reference: { id: active }
  });
  expect(read.state).toBe('current');
});

test('an edited title is preserved without renaming the file', async () => {
  const f = await fixture();
  const id = randomUUID();
  await writeVault(f.vault, 'Knowledge/Title.md', managedNote(id, 'Original title', { body: '# Original title\n' }));
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  await writeVault(f.vault, 'Knowledge/Title.md', managedNote(id, 'Edited title', { body: '# Edited title\n' }));
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  const entry = f.catalogue.getById(id);
  expect(entry?.title).toBe('Edited title');
  expect(entry?.path).toBe('Knowledge/Title.md');
  await expect(readFile(join(f.vault, 'Knowledge/Title.md'), 'utf8')).resolves.toContain('# Edited title');
  expect((await f.fileVault.listMarkdown()).filter((path) => path.endsWith('Title.md'))).toEqual([
    'Knowledge/Title.md'
  ]);
});

test('unresolved links are reported while resolvable links are not', async () => {
  const f = await fixture();
  const linker = randomUUID();
  const target = randomUUID();
  await writeVault(f.vault, 'Knowledge/Target.md', managedNote(target, 'Target'));
  await writeVault(
    f.vault,
    'Knowledge/Linker.md',
    managedNote(linker, 'Linker', {
      body: '# Linker\n\n[[Knowledge/Missing]] and [[Knowledge/Target|the target]]\n'
    })
  );
  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  expect(report.unresolved_links).toEqual([
    { path: 'Knowledge/Linker.md', target: 'Knowledge/Missing', state: 'unresolved' }
  ]);
});

test('symlink changes never read outside the vault and never invent an identity', async () => {
  const f = await fixture();
  const secretPath = join(f.state, 'secret.md');
  await writeFile(secretPath, '# Secret\n\nDo not index.\n', 'utf8');
  await mkdir(join(f.vault, 'Knowledge'), { recursive: true });
  await symlink(secretPath, join(f.vault, 'Knowledge/Symlinked.md'));

  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  expect(f.catalogue.getByPath('Knowledge/Symlinked.md')).toBeUndefined();
  expect(report.added.map((entry) => entry.title)).not.toContain('Secret');
  expect(f.catalogue.all().every((entry) => !entry.title.includes('Secret'))).toBe(true);

  const id = randomUUID();
  await writeVault(f.vault, 'Knowledge/Replaced.md', managedNote(id, 'Replaced'));
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  expect(f.catalogue.getById(id)).toBeDefined();

  await rm(join(f.vault, 'Knowledge/Replaced.md'));
  await symlink(secretPath, join(f.vault, 'Knowledge/Replaced.md'));
  const second = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  expect(second.removed.map((entry) => entry.path)).toEqual(['Knowledge/Replaced.md']);
  expect(f.catalogue.getById(id)).toBeUndefined();
  expect(f.catalogue.all().every((entry) => !entry.title.includes('Secret'))).toBe(true);
});

test('reconciliation settles when files change while they are scanned', async () => {
  const f = await fixture();
  const path = 'Knowledge/Churn.md';
  await writeVault(f.vault, path, '# Churn\n\n0\n');

  let counter = 0;
  const timer = setInterval(() => {
    counter += 1;
    void writeFile(join(f.vault, path), `# Churn\n\n${counter}\n`, 'utf8');
  }, 2);
  try {
    for (let round = 0; round < 12; round += 1) {
      await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
    }
  } finally {
    clearInterval(timer);
  }
  await sleep(20);
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  const finalRaw = await readFile(join(f.vault, path), 'utf8');
  expect(f.catalogue.getByPath(path)?.hash).toBe(hash(finalRaw));
});

test('filesystem events reconcile after the debounce and the periodic rescan', async () => {
  const f = await fixture();
  const reports: number[] = [];
  const observer = observeCurrentVault({
    root: f.vault,
    vault: f.fileVault,
    catalogue: f.catalogue,
    debounce_ms: 10,
    interval_ms: 50,
    onReconcile: (report) => reports.push(report.scanned)
  });
  try {
    await observer.reconcileNow();
    expect(reports.length).toBeGreaterThanOrEqual(1);

    const path = 'Knowledge/Watched.md';
    await writeVault(f.vault, path, '# Watched\n');
    const deadline = Date.now() + 4000;
    while (f.catalogue.getByPath(path) === undefined && Date.now() < deadline) {
      await sleep(20);
    }
    expect(f.catalogue.getByPath(path)?.title).toBe('Watched');
  } finally {
    await observer.close();
  }
});

test('legacy revision documents are left to migration rather than reported malformed', async () => {
  const f = await fixture();
  const legacyId = randomUUID();
  const legacy = `---\nbrain_schema_version: 1\nbrain_id: ${legacyId}\nbrain_revision_id: ${randomUUID()}\nbrain_scope: legacy\nbrain_status: candidate\n---\n\n# Legacy revision\n`;
  await writeVault(f.vault, 'Legacy/revision.md', legacy);

  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  expect(report.malformed).toEqual([]);
  expect(report.added).toEqual([]);
  expect(f.catalogue.getById(legacyId)).toBeUndefined();
  expect(f.catalogue.getByPath('Legacy/revision.md')).toBeUndefined();
});

test('a managed ID replaced at the same path keeps the prior identity history', async () => {
  const f = await fixture();
  const originalId = randomUUID();
  const replacementId = randomUUID();
  await writeVault(f.vault, 'Knowledge/Slot.md', managedNote(originalId, 'Slot'));
  await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });
  const original = f.catalogue.getById(originalId);
  expect(original?.revision_id).toBeDefined();

  await writeVault(f.vault, 'Knowledge/Slot.md', managedNote(replacementId, 'Slot'));
  const report = await reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue });

  expect(report.changed).toEqual([
    {
      path: 'Knowledge/Slot.md',
      id: replacementId,
      previous_etag: original?.etag,
      etag: hash(await readFile(join(f.vault, 'Knowledge/Slot.md'), 'utf8'))
    }
  ]);
  expect(f.catalogue.getById(replacementId)?.path).toBe('Knowledge/Slot.md');
  expect(f.catalogue.getById(originalId)).toBeUndefined();
  expect(f.catalogue.historyFor(originalId)?.revision_id).toBe(original?.revision_id);
  await expect(f.revisions.readRevision(originalId, original?.revision_id ?? '')).resolves.toMatchObject({
    id: originalId
  });
});

test('reconciliation can be cancelled before it starts', async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    reconcileCurrentVault({ vault: f.fileVault, catalogue: f.catalogue, signal: controller.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' });
});
