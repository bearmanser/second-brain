import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { parseArguments } from '../../src/cli.js';
import {
  classifyRecoveryInput,
  inspectDurableJournal,
  rebuildLocalIndex
} from '../../src/operations/local-rebuild.js';
import { openDocumentStore } from '../../src/storage/document-store.js';
import { Journal } from '../../src/storage/journal.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

async function seedJournal(state: string): Promise<void> {
  const journal = Journal.open(join(state, 'journal.db'));
  journal.close();
}

function approvalRowCount(state: string): number {
  const database = new Database(join(state, 'journal.db'), { readonly: true });
  try {
    return (database.prepare('SELECT COUNT(*) AS count FROM operation_approvals').get() as {
      count: number;
    }).count;
  } finally {
    database.close();
  }
}

async function seedNote(vault: string, state: string, path: string, raw: string) {
  const store = await openDocumentStore({ vault, state });
  try {
    return await store.put({
      path,
      raw,
      expectedEtag: null,
      idempotencyKey: randomUUID(),
      source: 'test'
    });
  } finally {
    await store.close();
  }
}

test('current Markdown alone does not imply historical recovery', () => {
  expect(classifyRecoveryInput({ vault: true, history: false, journal: false, index: false })).toEqual({
    current_content_recoverable: true,
    history_recoverable: false,
    idempotency_recoverable: false,
    index_rebuildable: true
  });
});

test('classification requires durable history and the journal for receipt recovery', () => {
  expect(classifyRecoveryInput({ vault: true, history: true, journal: false, index: false })).toEqual({
    current_content_recoverable: true,
    history_recoverable: true,
    idempotency_recoverable: false,
    index_rebuildable: true
  });
  expect(classifyRecoveryInput({ vault: false, history: true, journal: true, index: true })).toEqual({
    current_content_recoverable: false,
    history_recoverable: false,
    idempotency_recoverable: false,
    index_rebuildable: false
  });
  expect(classifyRecoveryInput({ vault: true, history: true, journal: true, index: false })).toEqual({
    current_content_recoverable: true,
    history_recoverable: true,
    idempotency_recoverable: true,
    index_rebuildable: true
  });
});

test('a discarded search index is rebuilt from current Markdown', async () => {
  const s = await vaultSandbox();
  try {
    await seedNote(s.vault, s.state, 'Knowledge/Alpha.md', '# Alpha\n\nalpha term\n');
    await seedJournal(s.state);
    const indexPath = join(s.state, 'index', 'search.sqlite');
    await mkdir(join(s.state, 'index'), { recursive: true });
    const discarded = openSearchIndex(indexPath);
    discarded.replaceDocument({ path: 'Knowledge/Alpha.md', raw: '# Alpha\n', etag: 'stale' });
    discarded.close();
    await rm(indexPath, { force: true });

    const result = await rebuildLocalIndex({ vault: s.vault, state: s.state });
    expect(result.status).toBe('rebuilt');
    if (result.status !== 'rebuilt') return;
    expect(result.counts.documents).toBe(1);
    expect(result.counts.chunks).toBeGreaterThan(0);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const metadata = JSON.parse(await readFile(result.metadata_path, 'utf8')) as {
      documents: number;
      chunks: number;
      fingerprint: string;
    };
    expect(metadata.documents).toBe(1);
    expect(metadata.fingerprint).toBe(result.fingerprint);
    const index = openSearchIndex(result.index_path);
    try {
      const candidates = index.candidates({ query: 'alpha', limit: 10 });
      expect(candidates.map((candidate) => candidate.path)).toContain('Knowledge/Alpha.md');
      expect(index.identities()[0]?.etag).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      index.close();
    }
  } finally {
    await s.dispose();
  }
});

test('a failed index publication retains the previous valid index and reports degradation', async () => {
  const s = await vaultSandbox();
  try {
    await seedNote(s.vault, s.state, 'Knowledge/Beta.md', '# Beta\n\nbeta term\n');
    await seedJournal(s.state);
    const first = await rebuildLocalIndex({ vault: s.vault, state: s.state });
    expect(first.status).toBe('rebuilt');
    const failed = await rebuildLocalIndex({
      vault: s.vault,
      state: s.state,
      faults: {
        publish() {
          throw new Error('publication failed');
        }
      }
    });
    expect(failed.status).toBe('degraded');
    if (failed.status !== 'degraded') return;
    expect(failed.previous_index).toBe(join(s.state, 'index', 'search.sqlite'));
    const entries = await readdir(join(s.state, 'index'));
    expect(entries.some((entry) => entry.includes('.staging-'))).toBe(false);
    const retained = openSearchIndex(join(s.state, 'index', 'search.sqlite'));
    try {
      expect(retained.identities()).toHaveLength(1);
      expect(retained.candidates({ query: 'beta', limit: 10 })).toHaveLength(1);
    } finally {
      retained.close();
    }
  } finally {
    await s.dispose();
  }
});

test('rebuilding refuses to repair a missing durable journal', async () => {
  const s = await vaultSandbox();
  try {
    await mkdir(join(s.vault, 'Knowledge'), { recursive: true });
    await writeFile(
      join(s.vault, 'Knowledge/Alpha.md'),
      '---\nid: 44b093c5-71db-4785-b9a5-bb8118304278\nbrain_schema_version: 2\ntype: note\nstatus: active\n---\n\n# Alpha\n',
      'utf8'
    );
    expect(inspectDurableJournal(s.state)).toBe('missing');
    const result = await rebuildLocalIndex({ vault: s.vault, state: s.state });
    expect(result.status).toBe('degraded');
    if (result.status !== 'degraded') return;
    expect(result.reason).toMatch(/journal/);
    expect(existsSync(join(s.state, 'journal.db'))).toBe(false);
    expect(existsSync(join(s.state, 'index', 'search.sqlite'))).toBe(false);
  } finally {
    await s.dispose();
  }
});

test('rebuilding refuses a damaged durable journal without deleting history', async () => {
  const s = await vaultSandbox();
  try {
    const stored = await seedNote(s.vault, s.state, 'Knowledge/Gamma.md', '# Gamma\n\ngamma term\n');
    await writeFile(join(s.state, 'journal.db'), 'not a sqlite database', 'utf8');
    expect(inspectDurableJournal(s.state)).toBe('damaged');
    const result = await rebuildLocalIndex({ vault: s.vault, state: s.state });
    expect(result.status).toBe('degraded');
    if (result.status !== 'degraded') return;
    expect(result.reason).toMatch(/journal/);
    const revisions = await readdir(join(s.state, 'history', stored.id, 'revisions'));
    expect(revisions.some((name) => name.endsWith('.md'))).toBe(true);
  } finally {
    await s.dispose();
  }
});

test('rebuild-index leaves a healthy durable journal byte-for-byte unchanged', async () => {
  const s = await vaultSandbox();
  try {
    await seedNote(s.vault, s.state, 'Knowledge/Alpha.md', '# Alpha\n\nalpha term\n');
    await seedJournal(s.state);
    const journalPath = join(s.state, 'journal.db');
    const before = await readFile(journalPath);
    const approvalsBefore = approvalRowCount(s.state);
    const result = await rebuildLocalIndex({ vault: s.vault, state: s.state });
    expect(result.status).toBe('rebuilt');
    expect(await readFile(journalPath)).toEqual(before);
    expect(approvalRowCount(s.state)).toBe(approvalsBefore);
  } finally {
    await s.dispose();
  }
});

test('a journal needing approval-provenance recovery is reported, not repaired', async () => {
  const s = await vaultSandbox();
  try {
    await seedNote(s.vault, s.state, 'Knowledge/Alpha.md', '# Alpha\n\nalpha term\n');
    await seedJournal(s.state);
    const database = new Database(join(s.state, 'journal.db'));
    try {
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO operations (
             operation_id, principal_id, idempotency_key, tool, scope, payload_hash,
             payload_json, plan_json, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          randomUUID(),
          randomUUID(),
          'test',
          'brain',
          'a'.repeat(64),
          '{}',
          JSON.stringify({ revision: { approval: { payload_hash: 'b'.repeat(64) } } }),
          'prepared',
          now,
          now
        );
    } finally {
      database.close();
    }
    expect(inspectDurableJournal(s.state)).toBe('backfill_required');
    const result = await rebuildLocalIndex({ vault: s.vault, state: s.state });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toMatch(/recovery|approval/i);
    expect(approvalRowCount(s.state)).toBe(0);
  } finally {
    await s.dispose();
  }
});

test('a journal behind this release schema is reported instead of migrated', async () => {
  const s = await vaultSandbox();
  try {
    await seedJournal(s.state);
    const database = new Database(join(s.state, 'journal.db'));
    try {
      database.exec('DROP TABLE retrieval_labels');
    } finally {
      database.close();
    }
    expect(inspectDurableJournal(s.state)).toBe('migration_required');
    const result = await rebuildLocalIndex({ vault: s.vault, state: s.state });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toMatch(/recover-state/);
  } finally {
    await s.dispose();
  }
});

test('the operator CLI exposes local backup, restore, verify, and index rebuild commands', () => {
  for (const command of ['rebuild-index', 'local-backup', 'local-restore', 'verify-local-backup']) {
    expect(parseArguments([command]).command).toBe(command);
  }
  const parsed = parseArguments(['local-restore', '--backup', '/backups/x', '--vault-only']);
  expect(parsed.flags.get('backup')).toBe('/backups/x');
  expect(parsed.flags.get('vault-only')).toBe(true);
});

test('rebuilding an empty vault without a journal is allowed', async () => {
  const s = await vaultSandbox();
  try {
    const result = await rebuildLocalIndex({ vault: s.vault, state: s.state });
    expect(result.status).toBe('rebuilt');
  } finally {
    await s.dispose();
  }
});
