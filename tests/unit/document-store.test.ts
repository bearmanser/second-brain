import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDocumentStore } from '../../src/storage/document-store.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

async function revisionFileNames(state: string, id: string): Promise<string[]> {
  try {
    return (await readdir(join(state, 'history', id, 'revisions'))).sort();
  } catch {
    return [];
  }
}

test('an old etag cannot overwrite a manual edit', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const first = await store.put({
      path: 'Inbox/Example.md', raw: '# Example\n\nFirst version.\n',
      expectedEtag: null, idempotencyKey: 'create-example', source: 'test'
    });
    const current = await store.readPath(first.path);
    const manual = current.raw.replace('First version.', 'Human version.');
    await writeFile(join(s.vault, first.path), manual);
    await expect(store.put({
      path: first.path, raw: current.raw.replace('First version.', 'Agent version.'),
      expectedEtag: first.etag, idempotencyKey: 'revise-example', source: 'test'
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.readPath(first.path)).raw).toBe(manual);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a managed write allocates and persists a logical id', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const result = await store.put({
      path: 'Inbox/Managed.md',
      raw: '# Managed\n\nBody.\n',
      expectedEtag: null,
      idempotencyKey: 'managed-create',
      source: 'test'
    });
    expect(result.id).toMatch(UUID_PATTERN);
    expect(result.revision_id).toMatch(UUID_PATTERN);
    expect(result.etag).toMatch(HASH_PATTERN);
    const read = await store.readPath(result.path);
    expect(read.raw).toContain(`id: ${result.id}`);
    expect(read.id).toBe(result.id);
    expect(read.revision_id).toBe(result.revision_id);
    expect(read.etag).toBe(sha256(read.raw));
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('an existing managed id cannot be reused at another path', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const id = '44b093c5-71db-4785-b9a5-bb8118304278';
    await store.put({
      path: 'Inbox/First.md',
      raw: `---\nid: ${id}\ntype: note\nstatus: candidate\n---\n\n# First\n`,
      expectedEtag: null,
      idempotencyKey: 'first-id',
      source: 'test'
    });
    await expect(
      store.put({
        path: 'Inbox/Second.md',
        raw: `---\nid: ${id}\ntype: note\nstatus: candidate\n---\n\n# Second\n`,
        expectedEtag: null,
        idempotencyKey: 'second-id',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.readPath('Inbox/Second.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a pre-existing target rejects a no-clobber create and stays untouched', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await mkdir(join(s.vault, 'Inbox'), { recursive: true });
    await writeFile(join(s.vault, 'Inbox/Taken.md'), '# Human\n');
    await expect(
      store.put({
        path: 'Inbox/Taken.md',
        raw: '# Agent\n',
        expectedEtag: null,
        idempotencyKey: 'take-it',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.vault, 'Inbox/Taken.md'), 'utf8')).toBe('# Human\n');
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('an expected etag for a missing path rejects the write', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await expect(
      store.put({
        path: 'Inbox/Missing.md',
        raw: '# Missing\n',
        expectedEtag: 'a'.repeat(64),
        idempotencyKey: 'missing-etag',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.readPath('Inbox/Missing.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a case-variant occupied path rejects a create that a plain O_EXCL would miss', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await store.put({
      path: 'Inbox/Example.md',
      raw: '# Example\n',
      expectedEtag: null,
      idempotencyKey: 'upper-example',
      source: 'test'
    });
    await expect(
      store.put({
        path: 'Inbox/example.md',
        raw: '# Lower\n',
        expectedEtag: null,
        idempotencyKey: 'lower-example',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.readPath('Inbox/example.md')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a symlink in the destination chain aborts the write', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const outside = join(s.state, '..', 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(s.vault, 'Linked'));
    await expect(
      store.put({
        path: 'Linked/Escape.md',
        raw: '# Escape\n',
        expectedEtag: null,
        idempotencyKey: 'symlink-escape',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('hidden and attachment destinations are rejected before any write', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    for (const path of ['.obsidian/app.md', '.git/hooks.md', 'Attachments/diagram.png', '../Escape.md', '/etc/passwd.md']) {
      await expect(
        store.put({
          path,
          raw: '# Nope\n',
          expectedEtag: null,
          idempotencyKey: `reject-${path}`,
          source: 'test'
        })
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(await readdir(s.vault)).toEqual([]);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('historical revisions preserve exact bytes and never live in the vault', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const first = await store.put({
      path: 'Inbox/History.md',
      raw: '# History\n\nFirst.\n',
      expectedEtag: null,
      idempotencyKey: 'history-create',
      source: 'test'
    });
    const firstRaw = (await store.readPath(first.path)).raw;
    const second = await store.put({
      path: 'Inbox/History.md',
      raw: '# History\n\nSecond.\n',
      expectedEtag: first.etag,
      idempotencyKey: 'history-revise',
      source: 'test'
    });
    const historical = await store.readRevision(first.id, first.revision_id);
    expect(historical.raw).toBe(firstRaw);
    expect(historical.hash).toBe(sha256(firstRaw));
    expect(historical.id).toBe(first.id);
    expect(historical.revision_id).toBe(first.revision_id);
    const revisions = await revisionFileNames(s.state, first.id);
    expect(revisions).toHaveLength(2);
    expect(revisions).toContain(`${first.revision_id}.md`);
    expect(revisions).toContain(`${second.revision_id}.md`);
    const vaultEntries = await readdir(s.vault);
    expect(vaultEntries).not.toContain('history');
    await expect(store.readRevision(first.id, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('ordinary reads never allocate an id for an unmanaged note', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await mkdir(join(s.vault, 'Knowledge'), { recursive: true });
    await writeFile(join(s.vault, 'Knowledge/Plain.md'), '# Plain\n\nNot managed.\n');
    const read = await store.readPath('Knowledge/Plain.md');
    expect(read.id).toBeUndefined();
    expect(read.revision_id).toBeUndefined();
    expect(read.etag).toBe(sha256(read.raw));
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('reusing an idempotency key with the same payload replays one revision', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const input = {
      path: 'Inbox/Replay.md',
      raw: '# Replay\n',
      expectedEtag: null,
      idempotencyKey: 'replay-key',
      source: 'test'
    };
    const first = await store.put(input);
    const second = await store.put(input);
    expect(second.revision_id).toBe(first.revision_id);
    expect(second.id).toBe(first.id);
    expect(await revisionFileNames(s.state, first.id)).toHaveLength(1);
    await expect(
      store.put({ ...input, raw: '# Replay\n\nDifferent.\n' })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('concurrent no-clobber creates admit exactly one writer', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const results = await Promise.allSettled([
      store.put({
        path: 'Inbox/Race.md',
        raw: '# One\n',
        expectedEtag: null,
        idempotencyKey: 'race-one',
        source: 'test'
      }),
      store.put({
        path: 'Inbox/Race.md',
        raw: '# Two\n',
        expectedEtag: null,
        idempotencyKey: 'race-two',
        source: 'test'
      })
    ]);
    const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
    const rejected = results.filter((entry) => entry.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    const raw = (await store.readPath('Inbox/Race.md')).raw;
    expect(['# One\n', '# Two\n'].some((candidate) => raw.endsWith(candidate))).toBe(true);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('parallel writes with one idempotency key converge on one receipt', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const input = {
      path: 'Inbox/Parallel.md',
      raw: '# Parallel\n',
      expectedEtag: null,
      idempotencyKey: 'parallel-key',
      source: 'test'
    };
    const [first, second] = await Promise.all([store.put(input), store.put(input)]);
    expect(first.revision_id).toBe(second.revision_id);
    expect(await revisionFileNames(s.state, first.id)).toHaveLength(1);
  } finally {
    await store.close();
    await s.dispose();
  }
});
