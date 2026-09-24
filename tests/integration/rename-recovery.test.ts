import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { planRename, type RenameFileSnapshot, type RenamePlan } from '../../src/notes/rename.js';
import { openDocumentStore, type DocumentStore } from '../../src/storage/document-store.js';
import { listVaultFilePaths } from '../../src/storage/vault.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

async function snapshots(vault: string): Promise<RenameFileSnapshot[]> {
  const paths = await listVaultFilePaths(vault);
  const files: RenameFileSnapshot[] = [];
  for (const path of paths) {
    const raw = await readFile(join(vault, path), 'utf8');
    files.push({ path, raw, hash: sha256(raw) });
  }
  return files;
}

async function planMove(
  vault: string,
  from: string,
  to: string,
  idempotencyKey: string
): Promise<RenamePlan> {
  return planRename({ from, to, files: await snapshots(vault), idempotency_key: idempotencyKey });
}

test('a move rewrites backlinks and preserves the note id and history', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const created = await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n\n## Limits\n',
      expectedEtag: null,
      idempotencyKey: 'laya-create',
      source: 'test'
    });
    const originalRaw = (await store.readPath('Knowledge/Laya.md')).raw;
    await writeFile(
      join(s.vault, 'Home.md'),
      '[[Knowledge/Laya#Limits|Classifier]]\n`[[Knowledge/Laya]]`\n'
    );
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Knowledge/Laya classifier.md', 'move-laya');
    const receipt = await store.applyRename(plan);
    expect(receipt.moved).toBe(true);
    expect(receipt.verified).toBe(true);
    expect(receipt.edited).toContain('Home.md');
    const moved = await store.readPath('Knowledge/Laya classifier.md');
    expect(moved.id).toBe(created.id);
    expect(moved.revision_id).toBe(created.revision_id);
    expect(moved.raw).toContain('## Limits');
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe(
      '[[Knowledge/Laya classifier#Limits|Classifier]]\n`[[Knowledge/Laya]]`\n'
    );
    await expect(store.readPath('Knowledge/Laya.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const historical = await store.readRevision(created.id, created.revision_id);
    expect(historical.raw).toBe(originalRaw);
    expect(historical.hash).toBe(sha256(originalRaw));
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('applying the same move twice replays one receipt', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'laya-create-replay',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Personal/Laya.md', 'move-replay');
    const first = await store.applyRename(plan);
    const second = await store.applyRename(plan);
    expect(second.operation_id).toBe(first.operation_id);
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('[[Personal/Laya]]\n');
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a target occupied after planning aborts without touching either file', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'laya-create-occupied',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Knowledge/Laya classifier.md', 'move-occupied');
    await writeFile(join(s.vault, 'Knowledge/Laya classifier.md'), '# Human occupied\n');
    await expect(store.applyRename(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.readPath('Knowledge/Laya.md')).raw).toContain('# Laya');
    expect(await readFile(join(s.vault, 'Knowledge/Laya classifier.md'), 'utf8')).toBe('# Human occupied\n');
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('[[Knowledge/Laya]]\n');
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('an edited backlink between planning and apply stops the move', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'laya-create-edited',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Knowledge/Laya classifier.md', 'move-edited');
    await writeFile(join(s.vault, 'Home.md'), 'Human edit [[Knowledge/Laya]]\n');
    await expect(store.applyRename(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('Human edit [[Knowledge/Laya]]\n');
    expect((await store.readPath('Knowledge/Laya.md')).raw).toContain('# Laya');
    await expect(store.readPath('Knowledge/Laya classifier.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('an interrupted multi-file move is not atomic but recovers on reopen', async () => {
  const s = await vaultSandbox();
  let failNextEdit = true;
  const first = await openDocumentStore({
    ...s,
    faults: {
      rename: {
        afterEdit: () => {
          if (failNextEdit) {
            failNextEdit = false;
            throw new Error('injected rename fault');
          }
        }
      }
    }
  });
  let createdId = '';
  let revisionId = '';
  try {
    const created = await first.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'laya-create-interrupted',
      source: 'test'
    });
    createdId = created.id;
    revisionId = created.revision_id;
    await writeFile(join(s.vault, 'Home1.md'), 'one [[Knowledge/Laya]]\n');
    await writeFile(join(s.vault, 'Home2.md'), 'two [[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Personal/Laya.md', 'move-interrupted');
    await expect(first.applyRename(plan)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(join(s.vault, 'Home1.md'), 'utf8')).toBe('one [[Personal/Laya]]\n');
    expect(await readFile(join(s.vault, 'Home2.md'), 'utf8')).toBe('two [[Knowledge/Laya]]\n');
    await expect(first.readPath('Knowledge/Laya.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await first.close();
  }
  const second = await openDocumentStore(s);
  try {
    expect(await readFile(join(s.vault, 'Home2.md'), 'utf8')).toBe('two [[Personal/Laya]]\n');
    const moved = await second.readPath('Personal/Laya.md');
    expect(moved.id).toBe(createdId);
    expect(moved.revision_id).toBe(revisionId);
    await second.readRevision(createdId, revisionId);
  } finally {
    await second.close();
    await s.dispose();
  }
});

test('a case-only rename preserves identity and rewrites references', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const created = await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'laya-create-case',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Knowledge/laya.md', 'move-case');
    await store.applyRename(plan);
    const moved = await store.readPath('Knowledge/laya.md');
    expect(moved.id).toBe(created.id);
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('[[Knowledge/laya]]\n');
    await expect(store.readPath('Knowledge/Laya.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a move rebases a relative link inside the moved note itself', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const created = await store.put({
      path: 'Knowledge/Sub/Laya.md',
      raw: '# Laya\n\n[Other](../Other.md)\n',
      expectedEtag: null,
      idempotencyKey: 'laya-create-rebase',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Knowledge/Other.md'), '# Other\n');
    const plan = await planMove(s.vault, 'Knowledge/Sub/Laya.md', 'Archive/Laya.md', 'move-rebase');
    expect(plan.edits.find(edit => edit.path === 'Knowledge/Sub/Laya.md')?.raw).toContain(
      '[Other](../Knowledge/Other.md)'
    );
    await store.applyRename(plan);
    const moved = await store.readPath('Archive/Laya.md');
    expect(moved.id).toBe(created.id);
    expect(moved.raw).toContain('[Other](../Knowledge/Other.md)');
    await expect(store.readPath('Knowledge/Sub/Laya.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('planning refuses to overwrite a case-variant occupied target', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'laya-create-case-conflict',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Knowledge/LAYALA.md'), '# Other\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Knowledge/LAYALA.md', 'move-case-conflict');
    expect(plan.conflicts.some(entry => entry.reason === 'target_occupied')).toBe(true);
    await expect(store.applyRename(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a move is refused when the plan already carries conflicts', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const files: RenameFileSnapshot[] = [
      { path: 'Knowledge/Laya.md', raw: '# Laya\n', hash: sha256('# Laya\n') },
      { path: 'Knowledge/Taken.md', raw: '# Taken\n', hash: sha256('# Taken\n') }
    ];
    const plan = planRename({
      from: 'Knowledge/Laya.md',
      to: 'Knowledge/Taken.md',
      files
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
    await expect(store.applyRename(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await store.close();
    await s.dispose();
  }
});
