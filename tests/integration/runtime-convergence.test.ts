import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
import { SYSTEM_ACTOR, type AuthenticatedContext } from '../../src/core/types.js';
import { createRuntime } from '../../src/runtime.js';
import { BasicMemoryBackend } from '../../src/storage/basic-memory.js';
import { openDocumentStore } from '../../src/storage/document-store.js';
import type {
  LayaCandidate,
  LayaScoreResult
} from '../../src/retrieval/laya-protocol.js';
import type { RerankWorker, RerankWorkerHealth } from '../../src/retrieval/reranker.js';
import { startLocalHttpHarness } from '../support/harness.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const FINGERPRINT = 'f'.repeat(64);

function context(): AuthenticatedContext {
  return { actor: SYSTEM_ACTOR, request_id: randomUUID(), signal: new AbortController().signal };
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function configFor(vault: string, state: string, cursorSecretFile: string): BrainConfig {
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

function scored(
  candidates: readonly LayaCandidate[],
  score: (candidate: LayaCandidate, position: number) => number
): LayaScoreResult {
  return {
    model_fingerprint: FINGERPRINT,
    question_version: 'relevance-2026-09-23.1',
    scores: candidates.map((candidate, position) => ({
      chunk_key: candidate.chunk_key,
      probabilities: { A: score(candidate, position), B: 0, C: 1 - score(candidate, position) },
      input_tokens: 4,
      truncated: false
    }))
  };
}

class FakeWorker implements RerankWorker {
  calls = 0;
  active = 0;
  maximum = 0;
  lastSignal: AbortSignal | undefined;
  constructor(
    private readonly behaviour: (
      candidates: readonly LayaCandidate[],
      signal?: AbortSignal
    ) => Promise<LayaScoreResult>,
    private readonly state: RerankWorkerHealth['state'] = 'ready'
  ) {}
  health(): RerankWorkerHealth {
    return { state: this.state, model_fingerprint: FINGERPRINT, question_version: 'relevance-2026-09-23.1' };
  }
  score(input: {
    request_id: string;
    query: string;
    candidates: readonly LayaCandidate[];
    signal?: AbortSignal;
  }): Promise<LayaScoreResult> {
    this.calls += 1;
    this.active += 1;
    this.maximum = Math.max(this.maximum, this.active);
    this.lastSignal = input.signal;
    return this.behaviour(input.candidates, input.signal).finally(() => {
      this.active -= 1;
    });
  }
}

const note = (title: string, marker: string): Record<string, unknown> => ({
  title,
  tags: [],
  content: { kind: 'note', summary: marker, body_markdown: `# ${title}\n\n${marker}\n` },
  evidence: [],
  related_ids: []
});

test('the default production graph never requires or calls a BackendPort', async () => {
  const originalConnect = BasicMemoryBackend.prototype.connect;
  let attempts = 0;
  BasicMemoryBackend.prototype.connect = async (): Promise<void> => {
    attempts += 1;
    throw new Error('the default production graph must not connect a backend');
  };
  const h = await startLocalHttpHarness();
  const client = await h.connect(h.token, 'no-backend');
  try {
    expect(attempts).toBe(0);
    expect(h.runtime.deps).toBeUndefined();
    expect(h.runtime.localDeps).toBeDefined();
    const status = (await client.callTool({ name: 'brain_status', arguments: {} })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(status.structuredContent?.protocol).toBe(2);
    expect(status.structuredContent?.health).not.toHaveProperty('backend');
  } finally {
    BasicMemoryBackend.prototype.connect = originalConnect;
    await client.close();
    await h.close();
  }
});

test('runtime startup recovers a crashed local write before serving reads', async () => {
  const sandbox = await vaultSandbox();
  const cursorSecretFile = join(sandbox.state, 'cursor.key');
  await writeFile(cursorSecretFile, Buffer.alloc(48, 5));
  const config = configFor(sandbox.vault, sandbox.state, cursorSecretFile);
  const id = randomUUID();
  const revisionId = randomUUID();
  const path = 'Inbox/Crashed at replacement.md';
  const raw = `---\nid: ${id}\nbrain_schema_version: 2\ntype: note\nstatus: candidate\n---\n\n# Crashed\n`;

  const crashed = await openDocumentStore({
    vault: sandbox.vault,
    state: sandbox.state,
    faults: {
      afterReplace(): void {
        throw new Error('simulated crash after replacement');
      }
    }
  });
  try {
    await expect(
      crashed.put({
        path,
        raw,
        expectedEtag: null,
        idempotencyKey: randomUUID(),
        source: 'startup-recovery',
        revisionId,
        parents: []
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await crashed.close();
  }

  const runtime = await createRuntime(config, {
    token_digest: digest('startup-recovery-token'),
    logger: () => undefined
  });
  try {
    const read = await runtime.services.read(context(), { path });
    expect(read.source.id).toBe(id);
    expect(read.source.revision_id).toBe(revisionId);
    expect(await readFile(join(sandbox.vault, path), 'utf8')).toBe(raw);
    expect(runtime.localDeps?.documents.pendingIndexCount()).toBe(0);
    expect(runtime.deps).toBeUndefined();
  } finally {
    await runtime.close();
    await sandbox.dispose();
  }
});

test('runtime status reports durable index lag after a write and clears it once indexing recovers', async () => {
  const h = await startLocalHttpHarness();
  const client = await h.connect(h.token, 'runtime-index-lag');
  const deps = h.runtime.localDeps;
  if (deps === undefined) throw new Error('the local handler deps are missing');
  const originalUpsert = deps.index.upsert.bind(deps.index);
  deps.index.upsert = (): void => {
    throw new Error('index unavailable');
  };
  try {
    const captured = (await client.callTool({
      name: 'brain_capture',
      arguments: { idempotency_key: randomUUID(), note: note('Index lag note', 'runtime index lag marker') }
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(captured.isError).toBeFalsy();
    expect(captured.structuredContent).toMatchObject({
      outcome: 'stored',
      materialized: true,
      indexed: false
    });

    const lagging = (await client.callTool({ name: 'brain_status', arguments: {} })) as {
      structuredContent?: Record<string, unknown>;
    };
    const laggingHealth = lagging.structuredContent?.health as
      | { index?: string; pending_index?: number }
      | undefined;
    expect(laggingHealth?.index).toBe('unavailable');
    expect(laggingHealth?.pending_index).toBeGreaterThanOrEqual(1);
    expect(deps.documents.pendingIndexCount()).toBeGreaterThanOrEqual(1);

    const receipt = (await client.callTool({
      name: 'brain_status',
      arguments: { operation_id: captured.structuredContent?.operation_id }
    })) as { structuredContent?: Record<string, unknown> };
    expect(receipt.structuredContent?.operation).toMatchObject({ indexed: false });

    deps.index.upsert = originalUpsert;
    const recovered = await deps.documents.recover();
    expect(recovered.pending).toEqual([]);

    const cleared = (await client.callTool({ name: 'brain_status', arguments: {} })) as {
      structuredContent?: Record<string, unknown>;
    };
    const clearedHealth = cleared.structuredContent?.health as
      | { index?: string; pending_index?: number }
      | undefined;
    expect(clearedHealth?.index).toBe('ready');
    expect(clearedHealth?.pending_index).toBe(0);
    expect(deps.documents.pendingIndexCount()).toBe(0);
  } finally {
    deps.index.upsert = originalUpsert;
    await client.close().catch(() => undefined);
    await h.close();
  }
});

test('the configured shared read-concurrency limit bounds V2 memory reads', async () => {
  const worker = new FakeWorker(async (candidates) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return scored(candidates, () => 0.5);
  });
  const h = await startLocalHttpHarness({ concurrent_reads: 2, worker });
  const clients = await Promise.all(
    Array.from({ length: 6 }, (_, index) => h.connect(h.token, `bounded-read-${index}`))
  );
  try {
    const captured = (await clients[0].callTool({
      name: 'brain_capture',
      arguments: { idempotency_key: randomUUID(), note: note('Bounded read note', 'bounded concurrency marker') }
    })) as { structuredContent?: Record<string, unknown> };
    await clients[0].callTool({
      name: 'brain_review',
      arguments: {
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: captured.structuredContent?.id,
          expected_etag: captured.structuredContent?.etag,
          rationale: 'approved for the concurrency bound test'
        }
      }
    });
    const results = await Promise.all(
      clients.map((client) =>
        client.callTool({
          name: 'brain_recall',
          arguments: { query: 'bounded concurrency marker', mode: 'reranked' }
        })
      )
    );
    expect(results.every((result) => (result as { isError?: boolean }).isError !== true)).toBe(true);
    expect(worker.maximum).toBe(2);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await h.close();
  }
});

test('runtime shutdown drains an in-flight durable write until it completes', async () => {
  const h = await startLocalHttpHarness();
  const client = await h.connect(h.token, 'blocked-write');
  const documents = h.runtime.localDeps?.documents;
  if (documents === undefined) throw new Error('the local document store is missing');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalPut = documents.put.bind(documents);
  let writtenPath = '';
  documents.put = async (input) => {
    writtenPath = input.path;
    entered();
    await gate;
    return originalPut(input);
  };

  try {
    const pending = client
      .callTool({ name: 'brain_capture', arguments: { idempotency_key: randomUUID(), note: note('Drain note', 'drain marker') } })
      .catch(() => undefined);
    await enteredPromise;

    const closing = h.runtime.close();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !h.runtime.shutdownPending) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(h.runtime.shutdownPending).toBe(true);
    expect(h.runtime.closed).toBe(false);

    release();
    await closing;
    await pending;
    expect(h.runtime.closed).toBe(true);
    expect(writtenPath.length).toBeGreaterThan(0);
    expect((await readFile(join(h.config.mounts.vault, writtenPath), 'utf8')).length).toBeGreaterThan(0);
  } finally {
    release();
    await client.close().catch(() => undefined);
    await h.close();
  }
});

test('runtime shutdown cancels an in-flight worker rerank', async () => {
  const worker = new FakeWorker(async (candidates, signal) => {
    await new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => resolve(), { once: true });
      setTimeout(resolve, 5000);
    });
    return scored(candidates, () => 0.5);
  });
  const h = await startLocalHttpHarness({ worker });
  const client = await h.connect(h.token, 'worker-cancel');
  try {
    const captured = (await client.callTool({
      name: 'brain_capture',
      arguments: { idempotency_key: randomUUID(), note: note('Worker cancel note', 'worker cancel marker') }
    })) as { structuredContent?: Record<string, unknown> };
    await client.callTool({
      name: 'brain_review',
      arguments: {
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: captured.structuredContent?.id,
          expected_etag: captured.structuredContent?.etag,
          rationale: 'approved before the shutdown cancellation test'
        }
      }
    });

    const inflight = client
      .callTool({
        name: 'brain_recall',
        arguments: { query: 'worker cancel marker', mode: 'reranked' }
      })
      .catch(() => undefined);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && worker.calls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(worker.calls).toBeGreaterThan(0);
    await h.runtime.close();
    await inflight;
    expect(worker.lastSignal?.aborted).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
    await h.close();
  }
});
