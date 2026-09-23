import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { RetrievalEventInputV2 } from '../../src/core/types.js';
import { Journal } from '../../src/storage/journal.js';
import { openLegacyDatabaseAt } from '../support/legacy-project-fixture.js';

const ID = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const wholeBrain: RetrievalEventInputV2 = {
  retrieval_id: ID(0x301),
  actor_id: 'system',
  filter: { mode: 'all' },
  searched_project_ids: ['freellmapi', 'shared', 'profile'],
  primary_project_id: null,
  returned_ids: [
    { scope: 'shared', id: ID(0xa1), revision_id: ID(0xb1) },
    { scope: 'profile', id: ID(0xa2), revision_id: ID(0xb2) }
  ],
  item_count: 2,
  token_used: 100,
  token_limit: 1500,
  mode: 'text',
  outcome: 'ok',
  partial: false,
  duration_ms: 10,
  created_at: '2026-09-23T09:00:00.000Z'
};

test('round-trips a whole-brain retrieval event without inventing a primary project', () => {
  const journal = Journal.open(':memory:');
  try {
    const stored = journal.recordRetrievalV2(wholeBrain);
    expect(stored.primary_project_id).toBeNull();
    expect(stored.filter).toEqual({ mode: 'all' });

    const read = journal.getRetrievalV2(wholeBrain.retrieval_id);
    expect(read).toEqual(stored);
    expect(read?.returned_ids).toEqual(wholeBrain.returned_ids);
    expect(journal.recordRetrievalV2(wholeBrain).retrieval_id).toBe(wholeBrain.retrieval_id);
  } finally {
    journal.close();
  }
});

test('stores the resolved primary project for a filtered retrieval event', () => {
  const journal = Journal.open(':memory:');
  try {
    const stored = journal.recordRetrievalV2({
      ...wholeBrain,
      retrieval_id: ID(0x302),
      filter: { mode: 'project', identifier: 'freellmapi' },
      searched_project_ids: ['freellmapi', 'shared'],
      primary_project_id: 'freellmapi',
      returned_ids: [{ scope: 'freellmapi', id: ID(0xa3), revision_id: ID(0xb3) }],
      item_count: 1
    });
    expect(stored.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
    expect(journal.getRetrievalV2(ID(0x302))?.primary_project_id).toBe('freellmapi');
  } finally {
    journal.close();
  }
});

test('reads an imported legacy retrieval event as a filtered project without inventing triple scopes', () => {
  const root = mkdtempSync(join('/tmp/opencode', 'telemetry-'));
  const path = join(root, 'journal.db');
  try {
    const database = openLegacyDatabaseAt(path, 8);
    database
      .prepare(
        `INSERT INTO retrieval_events (
          retrieval_id, principal_id, scope, scope_ids_json, returned_ids_json,
          item_count, token_used, token_limit, mode, outcome, partial, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ID(0x303),
        ID(0x10),
        'freellmapi',
        JSON.stringify(['freellmapi', 'shared']),
        JSON.stringify([{ id: ID(0xa1), revision_id: ID(0xb1) }]),
        1,
        10,
        1500,
        'hybrid',
        'ok',
        0,
        5,
        '2026-09-01T00:00:00.000Z'
      );
    database.close();

    const journal = Journal.open(path, { requireExisting: true });
    const read = journal.getRetrievalV2(ID(0x303));
    expect(read?.filter).toEqual({ mode: 'project', identifier: 'freellmapi' });
    expect(read?.searched_project_ids).toEqual(['freellmapi', 'shared']);
    expect(read?.returned_ids).toEqual([{ scope: null, id: ID(0xa1), revision_id: ID(0xb1) }]);
    journal.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
