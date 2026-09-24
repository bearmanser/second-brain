import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import {
  importLocalVault,
  inspectDurableJournal,
  rebuildLocalIndex,
  restoreLocalBackup,
  snapshotSqliteDatabase,
  takeLocalBackup,
  verifyLocalBackup
} from '../../src/operations/local-rebuild.js';
import { openDocumentStore } from '../../src/storage/document-store.js';
import { Journal } from '../../src/storage/journal.js';
import { openRevisionStore } from '../../src/storage/revision-store.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

async function writeNoteSet(vault: string, state: string) {
  const store = await openDocumentStore({ vault, state });
  try {
    const first = await store.put({
      path: 'Knowledge/Alpha.md',
      raw: '# Alpha\n\nalpha one\n',
      expectedEtag: null,
      idempotencyKey: randomUUID(),
      source: 'test'
    });
    const second = await store.put({
      path: 'Knowledge/Alpha.md',
      raw: '# Alpha\n\nalpha two\n',
      expectedEtag: first.etag,
      idempotencyKey: randomUUID(),
      source: 'test'
    });
    return { first, second };
  } finally {
    await store.close();
  }
}

function seedJournal(state: string): void {
  const journal = Journal.open(join(state, 'journal.db'));
  journal.close();
}

test('a full restore recovers current content, history, and receipts', async () => {
  const s = await vaultSandbox();
  try {
    const notes = await writeNoteSet(s.vault, s.state);
    seedJournal(s.state);
    const destination = join(dirname(s.vault), 'backup-full');
    const backup = await takeLocalBackup({
      vault: s.vault,
      state: s.state,
      destination,
      includeSearchIndex: true
    });
    expect(backup.files).toBeGreaterThan(0);
    const report = await verifyLocalBackup(backup.manifest, {
      vault: join(destination, 'vault'),
      state: join(destination, 'state'),
      config: join(destination, 'config')
    });
    expect(report.ok).toBe(true);

    const vault = join(dirname(s.vault), 'restore-vault');
    const state = join(dirname(s.vault), 'restore-state');
    const restored = await restoreLocalBackup({ backupRoot: destination, vault, state });
    expect(restored.classification).toEqual({
      current_content_recoverable: true,
      history_recoverable: true,
      idempotency_recoverable: true,
      index_rebuildable: true
    });
    expect(restored.history_recovered).toBe(true);
    expect(restored.receipts_recovered).toBe(true);
    expect(await readFile(join(vault, 'Knowledge/Alpha.md'), 'utf8')).toContain('alpha two');

    const revisions = await openRevisionStore(state);
    try {
      const historical = await revisions.readRevision(notes.first.id, notes.first.revision_id);
      expect(historical.raw).toContain('alpha one');
    } finally {
      revisions.close();
    }
    const receipts = Journal.open(join(state, 'journal.db'), { requireExisting: true });
    try {
      expect(receipts.durableStateSummary().operations).toBeGreaterThanOrEqual(0);
    } finally {
      receipts.close();
    }
    expect(existsSync(join(state, 'history', notes.first.id, 'revisions'))).toBe(true);
  } finally {
    await s.dispose();
  }
});

test('a vault-only import explicitly reports absent history and receipts', async () => {
  const s = await vaultSandbox();
  try {
    await writeNoteSet(s.vault, s.state);
    seedJournal(s.state);
    const destination = join(dirname(s.vault), 'backup-vault-only');
    await takeLocalBackup({ vault: s.vault, state: s.state, destination, scope: 'vault-only' });
    const vault = join(dirname(s.vault), 'import-vault');
    const imported = await importLocalVault({ backupRoot: destination, vault });
    expect(imported.classification).toEqual({
      current_content_recoverable: true,
      history_recoverable: false,
      idempotency_recoverable: false,
      index_rebuildable: true
    });
    expect(imported.warnings.join(' ')).toMatch(/historical/i);
    expect(imported.warnings.join(' ')).toMatch(/receipts/i);
    expect(await readFile(join(vault, 'Knowledge/Alpha.md'), 'utf8')).toContain('alpha two');
    expect(existsSync(join(vault, 'history'))).toBe(false);
  } finally {
    await s.dispose();
  }
});

test('a full restore refuses a vault-only backup', async () => {
  const s = await vaultSandbox();
  try {
    await writeNoteSet(s.vault, s.state);
    seedJournal(s.state);
    const destination = join(dirname(s.vault), 'backup-vault-only-2');
    await takeLocalBackup({ vault: s.vault, state: s.state, destination, scope: 'vault-only' });
    await expect(
      restoreLocalBackup({
        backupRoot: destination,
        vault: join(dirname(s.vault), 'restore-v2'),
        state: join(dirname(s.vault), 'restore-s2')
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally {
    await s.dispose();
  }
});

test('a missing historical snapshot is detected as incomplete history', async () => {
  const s = await vaultSandbox();
  try {
    const notes = await writeNoteSet(s.vault, s.state);
    seedJournal(s.state);
    const destination = join(dirname(s.vault), 'backup-snapshot');
    const backup = await takeLocalBackup({ vault: s.vault, state: s.state, destination });
    const vault = join(dirname(s.vault), 'snapshot-vault');
    const state = join(dirname(s.vault), 'snapshot-state');
    await restoreLocalBackup({ backupRoot: destination, vault, state });
    const revisionsDir = join(state, 'history', notes.first.id, 'revisions');
    const revisionFile = (await readdir(revisionsDir)).find((name) => name.endsWith('.md'));
    expect(revisionFile).toBeTruthy();
    await writeFile(join(revisionsDir, revisionFile as string), '# tampered\n', 'utf8');
    const report = await verifyLocalBackup(backup.manifest, { vault, state });
    expect(report.ok).toBe(false);
    expect(report.classification.current_content_recoverable).toBe(true);
    expect(report.classification.history_recoverable).toBe(false);
    expect(report.classification.idempotency_recoverable).toBe(false);
    expect(report.incomplete_categories).toContain('revision_snapshots');
  } finally {
    await s.dispose();
  }
});

test('a damaged durable journal is reported and never silently repaired by a rebuild', async () => {
  const s = await vaultSandbox();
  try {
    const notes = await writeNoteSet(s.vault, s.state);
    seedJournal(s.state);
    const destination = join(dirname(s.vault), 'backup-damaged-journal');
    const backup = await takeLocalBackup({ vault: s.vault, state: s.state, destination });
    const vault = join(dirname(s.vault), 'damaged-vault');
    const state = join(dirname(s.vault), 'damaged-state');
    await restoreLocalBackup({ backupRoot: destination, vault, state });
    await writeFile(join(state, 'journal.db'), 'corrupt journal', 'utf8');
    const report = await verifyLocalBackup(backup.manifest, { vault, state });
    expect(report.ok).toBe(false);
    expect(report.checksum_failures).toContain('journal.db');
    expect(report.classification.idempotency_recoverable).toBe(false);
    expect(inspectDurableJournal(state)).toBe('damaged');
    const rebuilt = await rebuildLocalIndex({ vault, state });
    expect(rebuilt.status).toBe('degraded');
    if (rebuilt.status !== 'degraded') return;
    expect(rebuilt.reason).toMatch(/journal/);
    const history = await readdir(join(state, 'history', notes.first.id, 'revisions'));
    expect(history.some((name) => name.endsWith('.md'))).toBe(true);
    expect(await readFile(join(state, 'journal.db'), 'utf8')).toBe('corrupt journal');
  } finally {
    await s.dispose();
  }
});

test('sqlite snapshots include committed WAL content', async () => {
  const s = await vaultSandbox();
  try {
    const journal = Journal.open(join(s.state, 'journal.db'));
    try {
      journal.reserve({
        principal_id: randomUUID(),
        idempotency_key: randomUUID(),
        tool: 'test',
        scope: 'brain',
        payload_hash: 'a'.repeat(64),
        payload_json: '{}'
      });
      const copy = join(dirname(s.vault), 'journal-copy.db');
      await snapshotSqliteDatabase(join(s.state, 'journal.db'), copy);
      expect(existsSync(`${join(s.state, 'journal.db')}-wal`)).toBe(true);
      const restored = Journal.open(copy, { requireExisting: true });
      try {
        expect(restored.durableStateSummary().operations).toBe(1);
      } finally {
        restored.close();
      }
    } finally {
      journal.close();
    }
  } finally {
    await s.dispose();
  }
});

test('text search, reads, and safe writes work after a restore without model artifacts', async () => {
  const s = await vaultSandbox();
  try {
    const notes = await writeNoteSet(s.vault, s.state);
    seedJournal(s.state);
    const destination = join(dirname(s.vault), 'backup-no-models');
    await takeLocalBackup({ vault: s.vault, state: s.state, destination });
    const vault = join(dirname(s.vault), 'no-models-vault');
    const state = join(dirname(s.vault), 'no-models-state');
    await restoreLocalBackup({ backupRoot: destination, vault, state });
    expect(existsSync(join(state, 'models'))).toBe(false);

    const rebuilt = await rebuildLocalIndex({ vault, state });
    expect(rebuilt.status).toBe('rebuilt');
    if (rebuilt.status === 'rebuilt') {
      const index = openSearchIndex(rebuilt.index_path);
      try {
        expect(index.candidates({ query: 'alpha', limit: 10 }).length).toBeGreaterThan(0);
      } finally {
        index.close();
      }
    }

    const store = await openDocumentStore({ vault, state });
    try {
      const read = await store.readPath('Knowledge/Alpha.md');
      expect(read.raw).toContain('alpha two');
      const write = await store.put({
        path: 'Knowledge/Delta.md',
        raw: '# Delta\n\ndelta term\n',
        expectedEtag: null,
        idempotencyKey: randomUUID(),
        source: 'test'
      });
      expect(write.revision_id).toBeTruthy();
      expect((await store.readPath('Knowledge/Delta.md')).raw).toContain('delta term');
    } finally {
      await store.close();
      expect(notes.first.id).toBeTruthy();
    }
  } finally {
    await s.dispose();
  }
});

test('token and cursor secrets are a separate protected category and never enter the vault', async () => {
  const s = await vaultSandbox();
  try {
    const secret = join(dirname(s.vault), 'cursor.secret');
    await writeFile(secret, 'k'.repeat(48), 'utf8');
    const destination = join(dirname(s.vault), 'backup-secrets');
    const backup = await takeLocalBackup({
      vault: s.vault,
      state: s.state,
      destination,
      secrets: [secret]
    });
    expect(backup.sensitive).toBe(true);
    expect(backup.manifest.sensitive).toBe(true);
    expect(backup.manifest.sensitive_categories).toContain('secrets');
    expect(existsSync(join(destination, 'secrets', 'cursor.secret'))).toBe(true);
    expect(existsSync(join(destination, 'vault', 'cursor.secret'))).toBe(false);
    const secretEntry = backup.manifest.files.find((file) => file.category === 'secrets');
    expect(secretEntry?.root).toBe('secrets');
  } finally {
    await s.dispose();
  }
});

test('model artifacts and the search index are classifiable as reproducible', async () => {
  const s = await vaultSandbox();
  try {
    await writeNoteSet(s.vault, s.state);
    seedJournal(s.state);
    await mkdir(join(s.state, 'models'), { recursive: true });
    await writeFile(join(s.state, 'models', 'laya.bin'), 'model-bytes', 'utf8');
    const index = openSearchIndex(join(s.state, 'index', 'search.sqlite'));
    index.upsert({ path: 'Knowledge/Alpha.md', raw: '# Alpha\n', etag: '1'.repeat(64) });
    index.close();
    const destination = join(dirname(s.vault), 'backup-reproducible');
    const backup = await takeLocalBackup({
      vault: s.vault,
      state: s.state,
      destination,
      includeSearchIndex: true,
      includeModelArtifacts: true
    });
    expect(backup.manifest.reproducible_categories).toEqual(
      expect.arrayContaining(['search_index', 'model_artifacts'])
    );
    expect(backup.manifest.categories).toEqual(
      expect.arrayContaining(['search_index', 'model_artifacts', 'revision_snapshots', 'journal'])
    );
  } finally {
    await s.dispose();
  }
});
