import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { inventoryTree } from '../../src/operations/vault-v2/inventory.js';
import { decodeRevision } from '../../src/notes/codec.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';
import manifest from '../fixtures/vault-v2/manifest-cases.json' with { type: 'json' };

test('inventory does not rewrite source bytes', async () => {
  const s = await vaultSandbox();
  try {
    const path = join(s.vault, 'Legacy note.md');
    const raw = Buffer.from('# Legacy note\r\n\r\nKeep these bytes.\r\n');
    await writeFile(path, raw);
    const rows = await inventoryTree(s.vault);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('Legacy note.md');
    expect(rows[0].bytes).toBe(raw.length);
    expect(rows[0].sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(await readFile(path)).toEqual(raw);
  } finally {
    await s.dispose();
  }
});

test('inventory orders paths deterministically and includes non-retrieval files', async () => {
  const s = await vaultSandbox();
  try {
    await mkdir(join(s.vault, 'Attachments'));
    await mkdir(join(s.vault, '.obsidian'));
    await writeFile(join(s.vault, 'z.md'), 'last');
    await writeFile(join(s.vault, 'Attachments', 'b.png'), Buffer.from([0, 255]));
    await writeFile(join(s.vault, '.obsidian', 'settings.json'), '{}');
    await writeFile(join(s.vault, 'Ærlig.md'), 'utf8');
    const first = await inventoryTree(s.vault);
    expect(first.map((row) => row.path)).toEqual([
      '.obsidian/settings.json', 'Attachments/b.png', 'z.md', 'Ærlig.md'
    ]);
    expect(await inventoryTree(s.vault)).toEqual(first);
  } finally {
    await s.dispose();
  }
});

test('inventory rejects symlink escapes, including directory links and the root', async () => {
  const s = await vaultSandbox();
  const outside = await mkdtemp(join(tmpdir(), 'second-brain-outside-'));
  try {
    await writeFile(join(outside, 'secret'), 'outside');
    await symlink(outside, join(s.vault, 'escape'));
    await expect(inventoryTree(s.vault)).rejects.toThrow(/symbolic link/i);
    await expect(inventoryTree(join(s.vault, 'escape'))).rejects.toThrow(/symbolic link/i);
  } finally {
    await s.dispose();
    const { rm } = await import('node:fs/promises');
    await rm(outside, { recursive: true, force: true });
  }
});

test('sandbox disposal leaves a sibling sandbox intact', async () => {
  const first = await vaultSandbox();
  const second = await vaultSandbox();
  try {
    await writeFile(join(second.state, 'journal'), 'untouched');
    await first.dispose();
    expect(await readFile(join(second.state, 'journal'), 'utf8')).toBe('untouched');
  } finally {
    await second.dispose();
  }
});

test('frozen V1 corpus inventories exact bytes and records unresolved logical heads', async () => {
  const s = await vaultSandbox();
  try {
    const hashes = new Map<string, string>();
    for (const entry of manifest.files) {
      const bytes = Buffer.from(entry.base64, 'base64');
      expect(bytes.length).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      const destination = join(s.vault, entry.path);
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, bytes);
      hashes.set(entry.path, entry.sha256);
    }
    expect(await inventoryTree(s.vault)).toEqual(manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
    for (const row of manifest.revisions) {
      const raw = await readFile(join(s.vault, row.path), 'utf8');
      const revision = decodeRevision(raw);
      expect(revision.id).toBe(row.id);
      expect(revision.revision_id).toBe(row.revision_id);
      expect(revision.parents.map((parent) => parent.revision_id)).toEqual(row.parent_revision_ids);
      expect(revision.status).toBe(row.status);
      expect(Boolean(revision.approval)).toBe(row.approved);
      for (const parent of revision.parents) {
        const parentRow = manifest.revisions.find((candidate) => candidate.revision_id === parent.revision_id);
        expect(parentRow).toBeDefined();
        expect(parent.raw_hash).toBe(hashes.get(parentRow!.path));
      }
    }
    expect(manifest.logical_heads[0].heads).toHaveLength(2);
    expect(manifest.logical_heads[0].resolution).toMatch(/conflict/);
  } finally {
    await s.dispose();
  }
});
