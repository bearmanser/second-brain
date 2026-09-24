import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  collectRenameSnapshots,
  planRename,
  type RenameFileSnapshot,
  type RenamePlan
} from '../../src/notes/rename.js';
import { openDocumentStore } from '../../src/storage/document-store.js';
import { listVaultFilePaths } from '../../src/storage/vault.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

function sha256(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function snapshots(vault: string): Promise<RenameFileSnapshot[]> {
  const paths = await listVaultFilePaths(vault);
  const files: RenameFileSnapshot[] = [];
  for (const path of paths) {
    const buffer = await readFile(join(vault, path));
    files.push({ path, raw: buffer.toString('utf8'), hash: sha256(buffer) });
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
    expect(moved.revision_id).toBeDefined();
    expect(moved.revision_id).not.toBe(created.revision_id);
    const rewritten = await store.readRevision(created.id, moved.revision_id as string);
    expect(rewritten.raw).toContain('[Other](../Knowledge/Other.md)');
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

test('a target created between the check and the move is never overwritten', async () => {
  const s = await vaultSandbox();
  let injected = false;
  const store = await openDocumentStore({
    ...s,
    faults: {
      rename: {
        beforeMoveStep: async () => {
          if (injected) return;
          injected = true;
          await writeFile(join(s.vault, 'Personal/Laya.md'), '# Human arrived\n');
        }
      }
    }
  });
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'race-create',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Personal/Laya.md', 'move-race');
    await expect(store.applyRename(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.vault, 'Personal/Laya.md'), 'utf8')).toBe('# Human arrived\n');
    expect((await store.readPath('Knowledge/Laya.md')).raw).toContain('# Laya');
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('[[Knowledge/Laya]]\n');
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a backlink changed during the rewrite keeps the human bytes', async () => {
  const s = await vaultSandbox();
  let injected = false;
  const store = await openDocumentStore({
    ...s,
    faults: {
      rename: {
        beforeEditReplace: async (path) => {
          if (injected || path !== 'Home.md') return;
          injected = true;
          await writeFile(join(s.vault, 'Home.md'), 'human [[Knowledge/Laya]]\n');
        }
      }
    }
  });
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'clobber-create',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Personal/Laya.md', 'move-clobber');
    await expect(store.applyRename(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('human [[Knowledge/Laya]]\n');
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a case-only rename interrupted after its temporary step recovers', async () => {
  const s = await vaultSandbox();
  let failed = false;
  const first = await openDocumentStore({
    ...s,
    faults: {
      rename: {
        afterMoveStep: (ordinal) => {
          if (failed || ordinal !== '0') return;
          failed = true;
          throw new Error('injected temporary step fault');
        }
      }
    }
  });
  let id = '';
  let revisionId = '';
  try {
    const created = await first.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'case-resume-create',
      source: 'test'
    });
    id = created.id;
    revisionId = created.revision_id;
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Knowledge/laya.md', 'move-case-resume');
    await expect(first.applyRename(plan)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(first.readPath('Knowledge/Laya.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(first.readPath('Knowledge/laya.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await first.close();
  }
  const second = await openDocumentStore(s);
  try {
    const moved = await second.readPath('Knowledge/laya.md');
    expect(moved.id).toBe(id);
    expect(moved.revision_id).toBe(revisionId);
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('[[Knowledge/laya]]\n');
    await expect(second.readPath('Knowledge/Laya.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await second.close();
    await s.dispose();
  }
});

test('a divergent backlink prevents a verified receipt', async () => {
  const s = await vaultSandbox();
  let mutated = false;
  const store = await openDocumentStore({
    ...s,
    faults: {
      rename: {
        afterRecords: async () => {
          if (mutated) return;
          mutated = true;
          await writeFile(join(s.vault, 'Home.md'), 'human [[Personal/Laya]] edit\n');
        }
      }
    }
  });
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'verify-create',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Personal/Laya.md', 'move-verify');
    await expect(store.applyRename(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('human [[Personal/Laya]] edit\n');
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('an incomplete multi-file reservation is rejected instead of partially applied', async () => {
  const s = await vaultSandbox();
  const first = await openDocumentStore({
    ...s,
    faults: {
      rename: {
        afterReserve: () => {
          throw new Error('injected reservation fault');
        }
      }
    }
  });
  try {
    await first.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'partial-create',
      source: 'test'
    });
    await writeFile(join(s.vault, 'Home1.md'), 'one [[Knowledge/Laya]]\n');
    await writeFile(join(s.vault, 'Home2.md'), 'two [[Knowledge/Laya]]\n');
    const plan = await planMove(s.vault, 'Knowledge/Laya.md', 'Personal/Laya.md', 'move-partial');
    await expect(first.applyRename(plan)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await first.close();
  }
  const database = new Database(join(s.state, 'documents.sqlite'));
  database.prepare("DELETE FROM local_move_files WHERE role = 'edit' AND path = 'Home2.md'").run();
  database.close();
  const second = await openDocumentStore(s);
  try {
    expect((await second.readPath('Knowledge/Laya.md')).raw).toContain('# Laya');
    await expect(second.readPath('Personal/Laya.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readFile(join(s.vault, 'Home1.md'), 'utf8')).toBe('one [[Knowledge/Laya]]\n');
    expect(await readFile(join(s.vault, 'Home2.md'), 'utf8')).toBe('two [[Knowledge/Laya]]\n');
  } finally {
    await second.close();
    await s.dispose();
  }
});

test('a binary attachment move preserves bytes and rewrites embeds', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await mkdir(join(s.vault, 'Attachments'), { recursive: true });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0xfe]);
    await writeFile(join(s.vault, 'Attachments/diagram.png'), bytes);
    await writeFile(join(s.vault, 'Home.md'), '![[Attachments/diagram.png]]\n');
    const files = await snapshots(s.vault);
    const plan = planRename({
      from: 'Attachments/diagram.png',
      to: 'Attachments/diagram final.png',
      files,
      idempotency_key: 'move-binary'
    });
    await store.applyRename(plan);
    expect(await readFile(join(s.vault, 'Attachments/diagram final.png'))).toEqual(bytes);
    await expect(readFile(join(s.vault, 'Attachments/diagram.png'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe(
      '![[Attachments/diagram final.png]]\n'
    );
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a managed backlink gets a durable revision after a rewrite', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'revision-source',
      source: 'test'
    });
    const home = await store.put({
      path: 'Inbox/Home.md',
      raw: '# Home\n\n[[Knowledge/Laya]]\n',
      expectedEtag: null,
      idempotencyKey: 'revision-home',
      source: 'test'
    });
    const plan = await planMove(
      s.vault,
      'Knowledge/Laya.md',
      'Knowledge/Laya classifier.md',
      'move-revision'
    );
    await store.applyRename(plan);
    const after = await store.readPath('Inbox/Home.md');
    expect(after.id).toBe(home.id);
    expect(after.revision_id).toBeDefined();
    expect(after.revision_id).not.toBe(home.revision_id);
    const rewritten = await store.readRevision(home.id, after.revision_id as string);
    expect(rewritten.raw).toContain('[[Knowledge/Laya classifier]]');
    const original = await store.readRevision(home.id, home.revision_id);
    expect(original.raw).toContain('[[Knowledge/Laya]]');
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('planning includes obsidian bookmarks read-only', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await store.put({
      path: 'Knowledge/Laya.md',
      raw: '# Laya\n',
      expectedEtag: null,
      idempotencyKey: 'obsidian-create',
      source: 'test'
    });
    await mkdir(join(s.vault, '.obsidian'), { recursive: true });
    const bookmarks = `${JSON.stringify(
      { items: [{ type: 'file', path: 'Knowledge/Laya.md', title: 'Laya' }] },
      null,
      2
    )}\n`;
    await writeFile(join(s.vault, '.obsidian/bookmarks.json'), bookmarks);
    await writeFile(join(s.vault, 'Home.md'), '[[Knowledge/Laya]]\n');
    const files = await collectRenameSnapshots(s.vault);
    const plan = planRename({
      from: 'Knowledge/Laya.md',
      to: 'Knowledge/Laya classifier.md',
      files,
      idempotency_key: 'move-obsidian'
    });
    expect(plan.edits.find(edit => edit.path === '.obsidian/bookmarks.json')).toBeUndefined();
    expect(
      plan.unresolved.some(
        entry => entry.path === '.obsidian/bookmarks.json' && entry.reason === 'manual'
      )
    ).toBe(true);
    await store.applyRename(plan);
    expect(await readFile(join(s.vault, '.obsidian/bookmarks.json'), 'utf8')).toBe(bookmarks);
  } finally {
    await store.close();
    await s.dispose();
  }
});
