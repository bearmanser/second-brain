import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  openDocumentStore,
  type DocumentIndex,
  type DocumentIndexEntry
} from '../../src/storage/document-store.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';
import { LocalWriteJournal } from '../../src/storage/journal.js';
import { openRevisionStore } from '../../src/storage/revision-store.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { FileVault } from '../../src/storage/vault.js';

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
    const names = await readdir(join(state, 'history', id, 'revisions'));
    return names.filter((name) => name.endsWith('.md')).length;
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

test('a crash after replacement but before journal and catalogue updates is recovered without replaying the write', async () => {
  const s = await vaultSandbox();
  let crashed = false;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      afterReplace() {
        if (!crashed) {
          crashed = true;
          throw new Error('simulated crash after replacement');
        }
      }
    }
  });
  const path = 'Inbox/Post replace.md';
  let info;
  try {
    await expect(
      store.put({
        path,
        raw: '# Post replace\n',
        expectedEtag: null,
        idempotencyKey: 'post-replace',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    info = await stat(join(s.vault, path));
    expect(await readFile(join(s.vault, path), 'utf8')).toContain('Post replace');
  } finally {
    await store.close();
  }
  const index = recordingIndex();
  const restarted = await openDocumentStore({ vault: s.vault, state: s.state, index });
  try {
    const read = await restarted.readPath(path);
    expect(read.id).toBeTruthy();
    expect(read.revision_id).toBeTruthy();
    expect(read.raw).toContain('Post replace');
    const historical = await restarted.readRevision(read.id!, read.revision_id!);
    expect(historical.raw).toContain('Post replace');
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.path).toBe(path);
    const after = await stat(join(s.vault, path));
    expect(after.mtimeMs).toBe(info!.mtimeMs);
    expect(after.ino).toBe(info!.ino);
    const replay = await restarted.put({
      path,
      raw: '# Post replace\n',
      expectedEtag: null,
      idempotencyKey: 'post-replace',
      source: 'test'
    });
    expect(replay.indexed).toBe(true);
  } finally {
    await restarted.close();
    await s.dispose();
  }
});

test('a retry after a partially completed replacement resumes instead of conflicting', async () => {
  const s = await vaultSandbox();
  let fail = true;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      afterReplace() {
        if (fail) throw new Error('simulated crash after replacement');
      }
    }
  });
  try {
    const input = {
      path: 'Inbox/Resume.md',
      raw: '# Resume\n',
      expectedEtag: null,
      idempotencyKey: 'resume-after-replace',
      source: 'test'
    };
    await expect(store.put(input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    fail = false;
    const result = await store.put(input);
    expect(result.revision_id).toBeTruthy();
    expect(await revisionCount(s.state, result.id)).toBe(1);
    expect((await store.readPath(input.path)).revision_id).toBe(result.revision_id);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a quoted managed id survives interrupted replacement and same-key retry', async () => {
  const s = await vaultSandbox();
  let interrupt = true;
  const id = '44b093c5-71db-4785-b9a5-bb8118304278';
  const path = 'Inbox/Quoted retry.md';
  const raw = `---\nid: '${id}'\ntype: note\nstatus: candidate\n---\n\n# Quoted retry\n`;
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    afterReplace() { if (interrupt) throw new Error('interrupted after replacement'); }
  } });
  try {
    const input = { path, raw, expectedEtag: null, idempotencyKey: 'quoted-interrupted', source: 'test' };
    await expect(store.put(input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const before = await stat(join(s.vault, path));
    interrupt = false;
    const result = await store.put(input);
    expect(result.id).toBe(id);
    expect((await store.readPath(path)).raw).toBe(raw);
    expect((await store.readPath(path)).revision_id).toBe(result.revision_id);
    expect((await store.readRevision(id, result.revision_id)).raw).toBe(raw);
    const after = await stat(join(s.vault, path));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await revisionCount(s.state, id)).toBe(1);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('recovery does not catalogue a visible revision missing from durable history', async () => {
  const s = await vaultSandbox();
  const path = 'Inbox/Missing history.md';
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    afterReplace() { throw new Error('crash after replacement'); }
  } });
  try {
    await expect(store.put({ path, raw: '# Missing history\n', expectedEtag: null, idempotencyKey: 'missing-history', source: 'test' }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await store.close();
  }
  const journal = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
  const reservation = journal.findByKey('missing-history')!;
  journal.close();
  await rm(join(s.state, 'history', reservation.id!, 'revisions', `${reservation.revision_id}.md`));
  const restarted = await openDocumentStore(s);
  try {
    expect((await restarted.readPath(path)).revision_id).toBeUndefined();
    await expect(restarted.readRevision(reservation.id!, reservation.revision_id!)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const opened = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
    try { expect(opened.findDocumentByPath(path)).toBeUndefined(); }
    finally { opened.close(); }
  } finally {
    await restarted.close();
    await s.dispose();
  }
});

test('recovery binds the original revision after replacement before catalogue reconciliation', async () => {
  const s = await vaultSandbox();
  const id = randomUUID();
  const revisionId = randomUUID();
  const path = 'Inbox/Interrupted binding.md';
  const raw = `---\nid: ${id}\nbrain_schema_version: 2\ntype: note\nstatus: candidate\n---\n\n# Original revision\n`;
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    afterReplace() { throw new Error('stop before binding'); }
  } });
  try {
    await expect(store.put({ path, raw, expectedEtag: null, idempotencyKey: randomUUID(),
      source: 'test', revisionId, parents: [] })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally { await store.close(); }
  const restarted = await openDocumentStore({ vault: s.vault, state: s.state });
  const revisions = await openRevisionStore(s.state);
  const catalogue = CurrentCatalogue.open({ revisions, ids: { next: () => randomUUID() } });
  try {
    await restarted.recover();
    await reconcileCurrentVault({ vault: new FileVault(s.vault, []), catalogue });
    expect(await revisions.currentBinding(id, path, createHash('sha256').update(raw).digest('hex'))).toBe(revisionId);
    expect(catalogue.getByPath(path)?.revision_id).toBe(revisionId);
    expect((await restarted.readRevision(id, revisionId)).raw).toBe(raw);
  } finally { catalogue.close(); revisions.close(); await restarted.close(); await s.dispose(); }
});

test('recovery does not catalogue a revision with a corrupt history sidecar', async () => {
  const s = await vaultSandbox();
  const path = 'Inbox/Corrupt sidecar.md';
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    afterReplace() { throw new Error('crash after replacement'); }
  } });
  try {
    await expect(store.put({ path, raw: '# Corrupt sidecar\n', expectedEtag: null, idempotencyKey: 'corrupt-sidecar', source: 'test' }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await store.close();
  }
  const journal = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
  const reservation = journal.findByKey('corrupt-sidecar')!;
  journal.close();
  await writeFile(join(s.state, 'history', reservation.id!, 'revisions', `${reservation.revision_id}.sha256`), '0'.repeat(64));
  const restarted = await openDocumentStore(s);
  try {
    expect((await restarted.readPath(path)).revision_id).toBeUndefined();
    await expect(restarted.readRevision(reservation.id!, reservation.revision_id!)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const opened = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
    try { expect(opened.findDocumentByPath(path)).toBeUndefined(); } finally { opened.close(); }
  } finally {
    await restarted.close();
    await s.dispose();
  }
});

test('a sidecar lost after replacement cannot be catalogued or receipted', async () => {
  const s = await vaultSandbox();
  const path = 'Inbox/Lost sidecar.md';
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    async afterReplace() {
      const journal = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
      const reservation = journal.findByKey('lost-sidecar')!;
      journal.close();
      await rm(join(s.state, 'history', reservation.id!, 'revisions', `${reservation.revision_id}.sha256`));
    }
  } });
  try {
    await expect(store.put({ path, raw: '# Lost sidecar\n', expectedEtag: null, idempotencyKey: 'lost-sidecar', source: 'test' }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect((await store.readPath(path)).revision_id).toBeUndefined();
    const journal = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
    try { expect(journal.findDocumentByPath(path)).toBeUndefined(); }
    finally { journal.close(); }
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a retry preserves the reserved preimage when the visible note changes', async () => {
  const s = await vaultSandbox();
  let interrupt = false;
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    beforeReplace() { if (interrupt) throw new Error('crash before replacement'); }
  } });
  const path = 'Inbox/Preimage.md';
  try {
    const first = await store.put({ path, raw: '# Original\n', expectedEtag: null, idempotencyKey: 'preimage-create', source: 'test' });
    const before = (await store.readPath(path)).raw;
    interrupt = true;
    const input = { path, raw: '# Replacement\n', expectedEtag: first.etag, idempotencyKey: 'preimage-retry', source: 'test' };
    await expect(store.put(input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await writeFile(join(s.vault, path), '# Human edit\n');
    interrupt = false;
    await expect(store.put(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    const journal = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
    try { expect(journal.findByKey(input.idempotencyKey)?.preimage_hash).toBe(sha256(before)); }
    finally { journal.close(); }
    expect(await readFile(join(s.vault, path), 'utf8')).toBe('# Human edit\n');
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a materialized retry retains the original reserved preimage hash', async () => {
  const s = await vaultSandbox();
  let interrupt = false;
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    afterReplace() { if (interrupt) throw new Error('crash after replacement'); }
  } });
  const path = 'Inbox/Reserved preimage.md';
  try {
    const first = await store.put({ path, raw: '# Original\n', expectedEtag: null, idempotencyKey: 'reserved-preimage-create', source: 'test' });
    const before = (await store.readPath(path)).raw;
    interrupt = true;
    const input = { path, raw: '# Revised\n', expectedEtag: first.etag, idempotencyKey: 'reserved-preimage-revise', source: 'test' };
    await expect(store.put(input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    interrupt = false;
    await store.put(input);
    const journal = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
    try { expect(journal.findByKey(input.idempotencyKey)?.preimage_hash).toBe(sha256(before)); }
    finally { journal.close(); }
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('recovery requires the reserved preimage before cataloguing a replaced revision', async () => {
  const s = await vaultSandbox();
  let interrupt = false;
  const path = 'Inbox/Preimage recovery.md';
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    afterReplace() { if (interrupt) throw new Error('crash after replacement'); }
  } });
  let first: Awaited<ReturnType<typeof store.put>>;
  try {
    first = await store.put({ path, raw: '# Before\n', expectedEtag: null, idempotencyKey: 'preimage-recovery-create', source: 'test' });
    interrupt = true;
    await expect(store.put({ path, raw: '# After\n', expectedEtag: first.etag, idempotencyKey: 'preimage-recovery-revise', source: 'test' }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally { await store.close(); }
  const journal = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
  const reservation = journal.findByKey('preimage-recovery-revise')!;
  journal.close();
  await rm(join(s.state, 'history', reservation.id!, 'preimages', `${reservation.preimage_hash}.md`));
  const restarted = await openDocumentStore(s);
  try {
    expect((await restarted.readPath(path)).revision_id).toBeUndefined();
    const opened = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
    try { expect(opened.findDocumentByPath(path)?.revision_id).toBe(first.revision_id); }
    finally { opened.close(); }
  } finally {
    await restarted.close();
    await s.dispose();
  }
});

test('a materialized retry cannot catalogue an id duplicated by an uncatalogued note', async () => {
  const s = await vaultSandbox();
  let interrupt = true;
  const id = '44b093c5-71db-4785-b9a5-bb8118304278';
  const path = 'Inbox/Pending duplicate.md';
  const raw = `---\nid: ${id}\ntype: note\nstatus: candidate\n---\n\n# Pending\n`;
  const store = await openDocumentStore({ vault: s.vault, state: s.state, faults: {
    afterReplace() { if (interrupt) throw new Error('crash after replacement'); }
  } });
  try {
    const input = { path, raw, expectedEtag: null, idempotencyKey: 'materialized-duplicate', source: 'test' };
    await expect(store.put(input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await writeFile(join(s.vault, 'Inbox/Human duplicate.md'), raw);
    interrupt = false;
    await expect(store.put(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.readPath(path)).revision_id).toBeUndefined();
    expect(await readFile(join(s.vault, path), 'utf8')).toBe(raw);
  } finally {
    await store.close();
    await s.dispose();
  }
});

test('a write without a search index reports indexed false and completes once an index exists', async () => {
  const s = await vaultSandbox();
  const first = await openDocumentStore(s);
  try {
    const result = await first.put({
      path: 'Inbox/No index.md',
      raw: '# No index\n',
      expectedEtag: null,
      idempotencyKey: 'no-index',
      source: 'test'
    });
    expect(result.indexed).toBe(false);
  } finally {
    await first.close();
  }
  const index = recordingIndex();
  const restarted = await openDocumentStore({ vault: s.vault, state: s.state, index });
  try {
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.path).toBe('Inbox/No index.md');
    const replay = await restarted.put({
      path: 'Inbox/No index.md',
      raw: '# No index\n',
      expectedEtag: null,
      idempotencyKey: 'no-index',
      source: 'test'
    });
    expect(replay.indexed).toBe(true);
  } finally {
    await restarted.close();
    await s.dispose();
  }
});
