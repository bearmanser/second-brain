import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  BACKEND_TIMEOUT_MS,
  CONCURRENT_READS,
  DYNAMIC_PROJECTS_MAX,
  INPUT_BODY_MAX_BYTES,
  MATERIALIZATION_TIMEOUT_MS,
  PROJECT_PROVISION_GLOBAL_PER_MINUTE,
  RECONCILE_INTERVAL_MS,
  RENDERED_NOTE_MAX_BYTES,
  TOOL_RESULT_MAX_BYTES
} from '../../src/core/limits.js';
import type { BrainConfig } from '../../src/config/schema.js';
import { createRuntime, type BrainRuntime } from '../../src/runtime.js';
import {
  SYSTEM_ACTOR,
  type AuthenticatedContext,
  type NoteContent,
  type NoteInput
} from '../../src/core/types.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

function context(): AuthenticatedContext {
  return { actor: SYSTEM_ACTOR, request_id: randomUUID(), signal: new AbortController().signal };
}

function note(title: string, marker: string, content?: NoteContent): NoteInput {
  return {
    title,
    tags: ['brain-v2'],
    content:
      content ?? {
        kind: 'note',
        summary: marker,
        body_markdown: `# ${title}\n\n${marker}\n`
      },
    evidence: [
      {
        kind: 'test_run',
        ref: 'tests/integration/brain-v2.test.ts',
        description: 'recorded by the V2 integration sequence'
      }
    ],
    related_ids: []
  };
}

function decision(title: string, marker: string): NoteInput {
  return {
    title,
    tags: ['brain-v2', 'retrieval'],
    content: {
      kind: 'decision',
      context: `We evaluated ${marker}.`,
      decision: `Adopt ${marker}.`,
      rationale: 'The local index and worker stay offline.',
      alternatives: ['keep the legacy backend'],
      consequences: ['no hosted model dependency']
    },
    evidence: [
      {
        kind: 'test_run',
        ref: 'tests/integration/brain-v2.test.ts',
        description: 'decision recorded during the V2 sequence'
      }
    ],
    related_ids: []
  };
}

async function configFor(vault: string, state: string, cursorSecretFile: string): Promise<BrainConfig> {
  return {
    endpoint: 'http://127.0.0.1:7331/mcp',
    backend_endpoint: 'http://127.0.0.1:1/mcp',
    port: 0,
    mounts: { vault, state },
    cursor_secret_file: cursorSecretFile,
    scopes: [
      { id: 'shared', backend_project: 'shared', relative_root: 'Shared', repository_aliases: [] },
      { id: 'profile', backend_project: 'profile', relative_root: 'Profile', repository_aliases: [] }
    ],
    limits: {
      input_body_max_bytes: INPUT_BODY_MAX_BYTES,
      rendered_note_max_bytes: RENDERED_NOTE_MAX_BYTES,
      tool_result_max_bytes: TOOL_RESULT_MAX_BYTES,
      backend_timeout_ms: BACKEND_TIMEOUT_MS,
      materialization_timeout_ms: MATERIALIZATION_TIMEOUT_MS,
      reconcile_interval_ms: RECONCILE_INTERVAL_MS,
      concurrent_reads: CONCURRENT_READS,
      project_provision_global_per_minute: PROJECT_PROVISION_GLOBAL_PER_MINUTE,
      dynamic_projects_max: DYNAMIC_PROJECTS_MAX
    },
    allowed_hosts: ['127.0.0.1'],
    allowed_origins: [],
    result_delivery: 'structured',
    laya: { enabled: false, python: 'python3', batch_size: 8, queue_batches: 4, timeout_ms: 4000, threads: 2 }
  };
}

async function startBrain(): Promise<{ runtime: BrainRuntime; dispose: () => Promise<void> }> {
  const sandbox = await vaultSandbox();
  const cursorSecretFile = join(sandbox.state, 'cursor.key');
  await writeFile(cursorSecretFile, Buffer.alloc(48, 7));
  const config = await configFor(sandbox.vault, sandbox.state, cursorSecretFile);
  const runtime = await createRuntime(config, {
    token_digest: createHash('sha256').update('single-token').digest('hex'),
    logger: () => undefined
  });
  return {
    runtime,
    dispose: async () => {
      await runtime.close();
      await sandbox.dispose();
    }
  };
}

function receiptOf(result: unknown): { id: string; etag?: string; revision_id: string } {
  return result as { id: string; etag?: string; revision_id: string };
}

test('one token runs the whole lifecycle on the local V2 store', async () => {
  const brain = await startBrain();
  const ctx = context();
  const { services } = brain.runtime;
  try {
    const ensured = await services.projectEnsure(ctx, {
      idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/local-brain-v2.git',
      display_name: 'Local Brain V2'
    });
    expect(ensured.created).toBe(true);
    expect(ensured.project_id).toBe(ensured.scope);
    expect(ensured.relative_root).toBeTruthy();
    expect(ensured).not.toHaveProperty('permissions');
    expect(ensured).not.toHaveProperty('backend_project');

    const captured = receiptOf(
      await services.capture(ctx, {
        idempotency_key: randomUUID(),
        project: ensured.scope,
        note: decision('Local retrieval decision', 'local retrieval')
      })
    );
    expect(captured.etag).toBeTruthy();

    const approved = receiptOf(
      await services.review(ctx, {
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: captured.id,
          expected_etag: captured.etag as string,
          rationale: 'verified by the integration sequence'
        }
      })
    );
    expect(approved.id).toBe(captured.id);

    const recalled = await services.recall(ctx, {
      project: ensured.scope,
      query: 'local retrieval',
      mode: 'text'
    });
    expect(recalled.mode).toBe('text');
    expect(recalled.partial).toBe(false);
    expect(recalled.items.length).toBeGreaterThan(0);
    const item = recalled.items.find((entry) => entry.id === captured.id);
    expect(item).toBeDefined();
    expect(item?.relative_path.startsWith(ensured.relative_root as string)).toBe(true);

    const readById = await services.read(ctx, { id: captured.id });
    expect(readById.source.id).toBe(captured.id);
    expect(readById.markdown).toContain('Adopt local retrieval.');

    const readByPath = await services.read(ctx, { path: readById.source.relative_path });
    expect(readByPath.source.id).toBe(captured.id);

    const revised = receiptOf(
      await services.review(ctx, {
        operation: {
          action: 'revise',
          idempotency_key: randomUUID(),
          id: captured.id,
          expected_etag: readByPath.source.etag,
          rationale: 'tighten the decision',
          note: decision('Local retrieval decision', 'local retrieval and Laya')
        }
      })
    );
    expect(revised.revision_id).not.toBe(captured.revision_id ?? '');

    await services.review(ctx, {
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id: captured.id,
        expected_etag: revised.etag as string,
        rationale: 're-approve the revision'
      }
    });

    const current = await services.read(ctx, { id: captured.id });
    const moved = receiptOf(
      await services.review(ctx, {
        operation: {
          action: 'move',
          idempotency_key: randomUUID(),
          id: captured.id,
          target_path: 'Knowledge/Moved local retrieval.md',
          expected_etag: current.source.etag,
          rationale: 'move the note into shared knowledge'
        }
      })
    );
    expect(moved.id).toBe(captured.id);

    const feedback = await services.feedback(ctx, {
      idempotency_key: randomUUID(),
      id: captured.id,
      revision_id: moved.revision_id,
      verdict: 'useful',
      reason: 'the V2 sequence used this note'
    });
    expect(feedback.recorded).toBe(true);

    const status = await services.status(ctx, {});
    expect(status.protocol).toBe(2);
    expect(status.local?.index.state).toBe('ready');
    expect(status.features?.text_search).toBe(true);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(/permission|can_read|can_write|can_review|authorized_scopes/);
  } finally {
    await brain.dispose();
  }
});

test('a single token reads former project, shared, and profile categories', async () => {
  const brain = await startBrain();
  const ctx = context();
  const { services } = brain.runtime;
  try {
    const ensured = await services.projectEnsure(ctx, {
      idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/category-project.git'
    });
    const markers = ['project category marker', 'shared category marker', 'profile category marker'];
    const targets = [ensured.scope, 'shared', 'profile'];
    const created: string[] = [];
    for (let index = 0; index < markers.length; index += 1) {
      const receipt = receiptOf(
        await services.capture(ctx, {
          idempotency_key: randomUUID(),
          project: targets[index],
          note: note(`Category ${index}`, markers[index])
        })
      );
      created.push(receipt.id);
      await services.review(ctx, {
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: receipt.id,
          expected_etag: receipt.etag as string,
          rationale: 'approve a category note'
        }
      });
    }

    const whole = await services.recall(ctx, { query: 'category marker' });
    const wholeIds = whole.items.map((entry) => entry.id);
    for (const id of created) expect(wholeIds).toContain(id);

    const narrowed = await services.recall(ctx, { project: 'shared', query: 'category marker' });
    expect(narrowed.items.length).toBeGreaterThan(0);
    expect(narrowed.items.every((entry) => entry.scope === 'shared')).toBe(true);

    for (const id of created) {
      const read = await services.read(ctx, { id });
      expect(read.source.id).toBe(id);
      expect(JSON.stringify(read)).not.toMatch(/permission|can_read|can_write|can_review/);
    }

    const sharedWithKnowledge = await services.recall(ctx, {
      project: ensured.scope,
      include_shared: true,
      query: 'category marker'
    });
    expect(sharedWithKnowledge.warnings.join(' ')).toContain('include_shared_deprecated');
    expect(sharedWithKnowledge.partial).toBe(false);
  } finally {
    await brain.dispose();
  }
});

test('a reranked request falls back transparently to lexical order without Laya', async () => {
  const brain = await startBrain();
  const ctx = context();
  const { services } = brain.runtime;
  try {
    const receipt = receiptOf(
      await services.capture(ctx, {
        idempotency_key: randomUUID(),
        note: note('Fallback note', 'fallback marker')
      })
    );
    await services.review(ctx, {
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id: receipt.id,
        expected_etag: receipt.etag as string,
        rationale: 'approve before recall'
      }
    });
    const legacy = await services.recall(ctx, { query: 'fallback marker', mode: 'hybrid' });
    expect(legacy.mode).toBe('text');
    expect(legacy.warnings.join(' ')).toContain('hybrid_deprecated');
  } finally {
    await brain.dispose();
  }
});
