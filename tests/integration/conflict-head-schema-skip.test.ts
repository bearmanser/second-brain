import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import type { BrainConfig } from '../../src/config/schema.js';
import type { AuthenticatedContext, LocalHandlerDeps, NoteInput } from '../../src/core/types.js';
import { SYSTEM_ACTOR } from '../../src/core/types.js';
import { captureLocal } from '../../src/features/capture.js';
import { reviewLocal } from '../../src/features/review.js';
import { buildLocalHandlerDeps, type LocalBrain } from '../../src/features/local-support.js';
import { openDocumentStore, type DocumentStore } from '../../src/storage/document-store.js';
import { Journal, LocalOperationJournal } from '../../src/storage/journal.js';
import { openRevisionStore, type RevisionStore } from '../../src/storage/revision-store.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { FileVault } from '../../src/storage/vault.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const clock = { now: () => new Date() };
const ids = { next: () => randomUUID() };

function ctx(): AuthenticatedContext {
  return { actor: SYSTEM_ACTOR, request_id: randomUUID(), signal: new AbortController().signal };
}

function noteInput(title: string, marker: string): NoteInput {
  return {
    title,
    tags: [],
    content: { kind: 'note', summary: marker, body_markdown: `# ${title}\n\n${marker}\n` },
    evidence: [],
    related_ids: []
  };
}

interface Ground {
  deps: LocalHandlerDeps;
  store: DocumentStore;
  catalogue: CurrentCatalogue;
  operations: LocalOperationJournal;
  journal: Journal;
  revisions: RevisionStore;
  vaultRoot: string;
  dispose: () => Promise<void>;
}

async function openGround(): Promise<Ground> {
  const sandbox = await vaultSandbox();
  const journal = Journal.open(join(sandbox.state, 'journal.db'), { clock, ids });
  const operations = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
  const revisions = await openRevisionStore(sandbox.state);
  const store = await openDocumentStore({ vault: sandbox.vault, state: sandbox.state });
  const index = openSearchIndex(':memory:');
  const vault = new FileVault(sandbox.vault, []);
  const catalogue = CurrentCatalogue.open({ revisions, ids });
  const config = {
    mounts: { vault: sandbox.vault, state: sandbox.state },
    scopes: [
      { id: 'freellmapi', backend_project: 'freellmapi', relative_root: 'Projects/freellmapi', repository_aliases: [] }
    ],
    result_delivery: 'structured',
    limits: { reconcile_interval_ms: 1000 }
  } as unknown as BrainConfig;
  const brain: LocalBrain = {
    config,
    clock,
    ids,
    documents: store,
    catalogue,
    index,
    journal,
    operations,
    vault,
    vaultRoot: sandbox.vault,
    close: async () => undefined
  };
  const deps = await buildLocalHandlerDeps(brain);
  const ground: Ground = {
    deps,
    store,
    catalogue,
    operations,
    journal,
    revisions,
    vaultRoot: sandbox.vault,
    dispose: async () => {
      try {
        operations.close();
      } catch {
        undefined;
      }
      journal.close();
      await store.close();
      catalogue.close();
      index.close();
      await sandbox.dispose();
    }
  };
  return ground;
}

async function seedNoteFile(
  ground: Ground,
  path: string,
  schemaVersion: number,
  extra: string
): Promise<void> {
  const absolute = join(ground.vaultRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(
    absolute,
    `---\nid: ${randomUUID()}\nbrain_schema_version: ${schemaVersion}\n${extra}\n---\n\n# preserved\n\npreserved\n`,
    'utf8'
  );
}

test('conflict-head resolution skips any non-V2 schema document but still fails closed on malformed V2', async () => {
  const ground = await openGround();
  const c = ctx();
  try {
    const captured = await captureLocal(
      c,
      { idempotency_key: randomUUID(), scope: 'freellmapi', note: noteInput('Current managed note', 'current managed note') },
      ground.deps
    );
    expect(captured.outcome).toBe('stored');
    expect(typeof captured.etag).toBe('string');
    const capturedEtag = captured.etag as string;
    await reconcileCurrentVault({ vault: ground.deps.vault, catalogue: ground.catalogue });

    await seedNoteFile(ground, 'Projects/legacy/Schema one.md', 1, 'brain_id: 11111111-1111-4111-8111-111111111111\ntype: note');
    await seedNoteFile(ground, 'Projects/legacy/Schema three.md', 3, 'brain_id: 22222222-2222-4222-8222-222222222222\ntype: note');

    const heads = await ground.deps.mutations.enumerateConflictHeads(captured.id);
    expect(heads).toHaveLength(1);
    expect(heads[0].revision_id).toBe(captured.revision_id);
    expect(heads.every((head) => !head.path.includes('legacy'))).toBe(true);

    const approved = await reviewLocal(
      c,
      {
        scope: 'freellmapi',
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: captured.id,
          expected_etag: capturedEtag,
          rationale: 'schema-skip regression approval'
        }
      },
      ground.deps
    );
    expect('outcome' in approved ? approved.outcome : undefined).toBe('stored');

    await seedNoteFile(ground, 'Projects/legacy/Malformed v2.md', 2, 'status: not-a-document-status');

    await expect(ground.deps.mutations.enumerateConflictHeads(captured.id)).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    });
  } finally {
    await ground.dispose();
  }
});
