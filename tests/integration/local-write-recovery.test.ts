import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  openDocumentStore,
  type DocumentIndex,
  type DocumentIndexEntry
} from '../../src/storage/document-store.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function enospc(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

function recordingIndex(): DocumentIndex & { entries: DocumentIndexEntry[] } {
  const entries: DocumentIndexEntry[] = [];
  return {
    entries,
    upsert(entry) {
      entries.push(entry);
    }
  };
}

function failingIndex(): DocumentIndex & { attempts: number } {
  return {
    attempts: 0,
    upsert() {
      this.attempts += 1;
      throw new Error('index unavailable');
    }
  };
}

async function revisionCount(state: string, id: string): Promise<number> {
  try {
    return (await readdir(join(state, 'history', id, 'revisions'))).length;
  } catch {
    return 0;
  }
}

test('fault at journal preparation leaves no visible file and can be retried', async () => {
  const s = await vaultSandbox();
  let fail = true;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      journalPrepare() {
        if (fail) throw new Error('journal unavailable');
      }
    }
  });
  try {
    await expect(
      store.put({
        path: 'Inbox/Prepared.md',
        raw: '# Prepared\n',
        expectedEtag: null,
        idempotencyKey: 'prepare-fault',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(stat(join(s.vault, 'Inbox/Prepared.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    fail = false;
    const result = await store.put({
      path: 'Inbox/Prepared.md',
      raw: '# Prepared\n',
      expectedEtag: null,
      idempotencyKey: 'prepare-fault',
      source: 'test'
    });
    expect(result.id).toMatch(UUID_PATTERN);
    expect(await revisionCount(s.state, result.id)).toBe(1);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('fault at history persistence leaves the vault untouched and does not duplicate history', async () => {
  const s = await vaultSandbox();
  let fail = true;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      historyPersist() {
        if (fail) throw enospc();
      }
    }
  });
  try {
    await expect(
      store.put({
        path: 'Inbox/History fault.md',
        raw: '# History fault\n',
        expectedEtag: null,
        idempotencyKey: 'history-fault',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(stat(join(s.vault, 'Inbox/History fault.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    fail = false;
    const result = await store.put({
      path: 'Inbox/History fault.md',
      raw: '# History fault\n',
      expectedEtag: null,
      idempotencyKey: 'history-fault',
      source: 'test'
    });
    expect(await revisionCount(s.state, result.id)).toBe(1);
    expect((await store.readPath(result.path)).id).toBe(result.id);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('fault at current-file replacement keeps the persisted revision and retries without duplication', async () => {
  const s = await vaultSandbox();
  let fail = true;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      beforeReplace() {
        if (fail) throw enospc();
      }
    }
  });
  try {
    await expect(
      store.put({
        path: 'Inbox/Replace fault.md',
        raw: '# Replace fault\n',
        expectedEtag: null,
        idempotencyKey: 'replace-fault',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(stat(join(s.vault, 'Inbox/Replace fault.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    fail = false;
    const result = await store.put({
      path: 'Inbox/Replace fault.md',
      raw: '# Replace fault\n',
      expectedEtag: null,
      idempotencyKey: 'replace-fault',
      source: 'test'
    });
    expect(await revisionCount(s.state, result.id)).toBe(1);
    expect((await store.readPath(result.path)).raw).toBe(await readFile(join(s.vault, result.path), 'utf8'));
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a failed index update is reported and replayed after restart without rewriting the file', async () => {
  const s = await vaultSandbox();
  const index = failingIndex();
  const store = await openDocumentStore({ vault: s.vault, state: s.state, index });
  let info;
  let result;
  try {
    result = await store.put({
      path: 'Inbox/Index fault.md',
      raw: '# Index fault\n',
      expectedEtag: null,
      idempotencyKey: 'index-fault',
      source: 'test'
    });
    expect(result.indexed).toBe(false);
    info = await stat(join(s.vault, result.path));
  } finally {
    await store.close();
  }
  const replay = recordingIndex();
  const restarted = await openDocumentStore({ vault: s.vault, state: s.state, index: replay });
  try {
    expect(replay.entries).toHaveLength(1);
    expect(replay.entries[0]?.path).toBe('Inbox/Index fault.md');
    expect(replay.entries[0]?.revision_id).toBe(result!.revision_id);
    const after = await stat(join(s.vault, result!.path));
    expect(after.mtimeMs).toBe(info!.mtimeMs);
    expect(after.ino).toBe(info!.ino);
    expect(await revisionCount(s.state, result!.id)).toBe(1);
    const replayed = await restarted.put({
      path: 'Inbox/Index fault.md',
      raw: '# Index fault\n',
      expectedEtag: null,
      idempotencyKey: 'index-fault',
      source: 'test'
    });
    expect(replayed.revision_id).toBe(result!.revision_id);
    expect(replayed.indexed).toBe(true);
  } finally {
    await restarted.close();
    await s.dispose();
  }
});

test('a disk-full history write is retryable and never leaves partial state', async () => {
  const s = await vaultSandbox();
  let fail = true;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      historyPersist() {
        if (fail) throw enospc();
      }
    }
  });
  try {
    await expect(
      store.put({
        path: 'Inbox/Disk full.md',
        raw: '# Disk full\n',
        expectedEtag: null,
        idempotencyKey: 'disk-full',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', retryable: true });
    fail = false;
    const result = await store.put({
      path: 'Inbox/Disk full.md',
      raw: '# Disk full\n',
      expectedEtag: null,
      idempotencyKey: 'disk-full',
      source: 'test'
    });
    expect((await store.readPath(result.path)).etag).toBe(result.etag);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('same-token parallel writes serialize into one durable revision', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const input = {
      path: 'Inbox/Token race.md',
      raw: '# Token race\n',
      expectedEtag: null,
      idempotencyKey: 'token-race',
      source: 'same-token'
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => store.put(input)));
    const revisions = new Set(results.map((entry) => entry.revision_id));
    expect(revisions.size).toBe(1);
    expect(await revisionCount(s.state, results[0]!.id)).toBe(1);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('revision destinations never reuse a vault path or an attachment destination', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const result = await store.put({
      path: 'Inbox/Placed.md',
      raw: '# Placed\n',
      expectedEtag: null,
      idempotencyKey: 'placed',
      source: 'test'
    });
    const historyId = join(s.state, 'history', result.id);
    const historyInfo = await lstat(historyId);
    expect(historyInfo.isDirectory()).toBe(true);
    expect(result.id).toMatch(UUID_PATTERN);
    expect(result.revision_id).toMatch(UUID_PATTERN);
    const revisionFile = join(historyId, 'revisions', `${result.revision_id}.md`);
    expect((await lstat(revisionFile)).isFile()).toBe(true);
    expect(await readFile(revisionFile, 'utf8')).toBe(await readFile(join(s.vault, result.path), 'utf8'));
    await expect(
      store.put({
        path: '.obsidian/Plugins.md',
        raw: '# Plugins\n',
        expectedEtag: null,
        idempotencyKey: 'obsidian-destination',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      store.put({
        path: 'Attachments/diagram.png',
        raw: 'not markdown',
        expectedEtag: null,
        idempotencyKey: 'attachment-destination',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('the vault root is never used as a revision destination', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    await store.put({
      path: 'Home.md',
      raw: '# Home\n',
      expectedEtag: null,
      idempotencyKey: 'home',
      source: 'test'
    });
    const entries = await readdir(s.vault);
    expect(entries).toEqual(['Home.md']);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a concurrent human write immediately before replacement is surfaced and preserved', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      async beforeReplace() {
        await mkdir(join(s.vault, 'Inbox'), { recursive: true });
        await writeFile(join(s.vault, 'Inbox/Concurrent.md'), '# Human\n');
      }
    }
  });
  try {
    await expect(
      store.put({
        path: 'Inbox/Concurrent.md',
        raw: '# Agent\n',
        expectedEtag: null,
        idempotencyKey: 'concurrent-divergence',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.vault, 'Inbox/Concurrent.md'), 'utf8')).toBe('# Human\n');
    expect(await readdir(join(s.vault, 'Inbox'))).toEqual(['Concurrent.md']);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('directory fsync constants are available on this platform', () => {
  expect(constants.O_NOFOLLOW).toBeTypeOf('number');
});

test('revision reads never return a partial or out-of-vault destination', async () => {
  const s = await vaultSandbox();
  const store = await openDocumentStore(s);
  try {
    const result = await store.put({
      path: 'Inbox/Partial.md',
      raw: '# Partial\n',
      expectedEtag: null,
      idempotencyKey: 'partial',
      source: 'test'
    });
    await expect(store.readRevision('not-a-uuid', result.revision_id)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
    await expect(store.readRevision(result.id, 'not-a-uuid')).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
    await expect(
      store.readRevision('../../etc', result.revision_id)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally {
    await store.close();
    await s.dispose();
  }
});
