import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import fixtureJson from '../fixtures/vault-v2/manifest-cases.json' with { type: 'json' };
import { applyVaultMigration } from '../../src/operations/vault-v2/apply.js';
import { planVaultMigration, buildMigrationBackupReceipt } from '../../src/operations/vault-v2/plan.js';
import { rollbackVaultMigration } from '../../src/operations/vault-v2/rollback.js';
import { openDocumentStore, type DocumentIndex, type DocumentIndexEntry } from '../../src/storage/document-store.js';
import { LocalWriteJournal } from '../../src/storage/journal.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

interface ManifestFileFixture {
  path: string;
  bytes: number;
  sha256: string;
  base64: string;
}

const fixture = fixtureJson as unknown as { files: ManifestFileFixture[] };
const PROJECT_NAMES = { freellmapi: 'FreeLLM API' };
const FIXED_CLOCK = { now: () => new Date('2026-09-24T00:00:00.000Z') };

async function materialize(vault: string): Promise<void> {
  for (const entry of fixture.files) {
    const bytes = Buffer.from(entry.base64, 'base64');
    const destination = join(vault, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

interface MigrationBackup {
  root: string;
  receipt: unknown;
}

async function makeMigrationBackup(
  vault: string,
  state: string,
  plan: Awaited<ReturnType<typeof planVaultMigration>>
): Promise<MigrationBackup> {
  const root = join(dirname(vault), 'migration-backup-media');
  for (const file of plan.source_fingerprint.vault) {
    const destination = join(root, 'vault', file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(vault, file.path)));
  }
  for (const file of plan.source_fingerprint.state) {
    const destination = join(root, 'state', file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(state, file.path)));
  }
  return { root, receipt: buildMigrationBackupReceipt(plan.source_fingerprint) };
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

test('an interrupted write that a human later edits is not replayed over the newer version', async () => {
  const s = await vaultSandbox();
  const path = 'Inbox/Human edit.md';
  let crash = true;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      afterReplace() {
        if (crash) throw new Error('simulated crash after replacement');
      }
    }
  });
  try {
    await expect(
      store.put({
        path,
        raw: '# Agent version\n',
        expectedEtag: null,
        idempotencyKey: 'human-edit-crash',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await store.close();
  }
  await writeFile(join(s.vault, path), '# Human version\n', 'utf8');
  const restarted = await openDocumentStore({ vault: s.vault, state: s.state, index: recordingIndex() });
  try {
    const observed = await restarted.readPath(path);
    expect(observed.raw).toBe('# Human version\n');
    await expect(
      restarted.put({
        path,
        raw: '# Agent version\n',
        expectedEtag: null,
        idempotencyKey: 'human-edit-crash',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.vault, path), 'utf8')).toBe('# Human version\n');
  } finally {
    await restarted.close();
    await s.dispose();
  }
});

test('a materialized write is finalized with a durable receipt after a restart', async () => {
  const s = await vaultSandbox();
  const path = 'Inbox/Receipt.md';
  let crash = true;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      afterReplace() {
        if (crash) throw new Error('simulated crash before receipt');
      }
    }
  });
  try {
    await expect(
      store.put({
        path,
        raw: '# Receipt\n',
        expectedEtag: null,
        idempotencyKey: 'receipt-finalization',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await store.close();
  }
  const index = recordingIndex();
  const restarted = await openDocumentStore({ vault: s.vault, state: s.state, index });
  try {
    expect(index.entries).toHaveLength(1);
    const journal = LocalWriteJournal.open(join(s.state, 'documents.sqlite'));
    try {
      const record = journal.findByKey('receipt-finalization');
      expect(record?.state).toBe('complete');
      expect(record?.receipt_json).not.toBeNull();
    } finally {
      journal.close();
    }
    const read = await restarted.readPath(path);
    expect(read.raw).toContain('# Receipt\n');
  } finally {
    await restarted.close();
    await s.dispose();
  }
});

test('a restart after a crash before history persistence completes the write exactly once', async () => {
  const s = await vaultSandbox();
  const path = 'Inbox/History restart.md';
  let crash = true;
  const store = await openDocumentStore({
    vault: s.vault,
    state: s.state,
    faults: {
      historyPersist() {
        if (crash) throw new Error('simulated disk failure');
      }
    }
  });
  try {
    await expect(
      store.put({
        path,
        raw: '# History restart\n',
        expectedEtag: null,
        idempotencyKey: 'history-restart',
        source: 'test'
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await store.close();
  }
  crash = false;
  const restarted = await openDocumentStore({ vault: s.vault, state: s.state });
  try {
    const result = await restarted.put({
      path,
      raw: '# History restart\n',
      expectedEtag: null,
      idempotencyKey: 'history-restart',
      source: 'test'
    });
    expect(result.revision_id).toBeTruthy();
    expect((await restarted.readPath(path)).raw).toContain('# History restart\n');
  } finally {
    await restarted.close();
    await s.dispose();
  }
});

test('a rollback attempted after a new human edit preserves the human version', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const plan = await planVaultMigration({
      vault: s.vault,
      state: s.state,
      projectNames: PROJECT_NAMES,
      clock: FIXED_CLOCK
    });
    const backup = await makeMigrationBackup(s.vault, s.state, plan);
    const applied = await applyVaultMigration(plan, {
      maintenance: true,
      backupReceipt: backup.receipt,
      backupRoot: backup.root,
      partial: true,
      clock: FIXED_CLOCK
    });
    expect(applied.status).toBe('applied');
    const move = plan.moves[0];
    expect(move).toBeDefined();
    const human = '# Human curation\n';
    await writeFile(join(s.vault, move!.current_path), human, 'utf8');
    await expect(
      rollbackVaultMigration(plan, { maintenance: true, clock: FIXED_CLOCK })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.vault, move!.current_path), 'utf8')).toBe(human);
  } finally {
    await s.dispose();
  }
});
