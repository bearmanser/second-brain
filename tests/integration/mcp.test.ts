import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createRuntime } from '../../src/runtime.js';
import { countReferenceTokens } from '../../src/retrieval/budget.js';
import { BrainError } from '../../src/contracts/errors.js';
import { TOOL_RESULT_MAX_BYTES } from '../../src/core/limits.js';
import { lessonFixture } from '../fixtures/content.js';
import { SYSTEM_ACTOR } from '../../src/core/types.js';
import { FakeBackend } from '../support/fake-backend.js';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { Journal } from '../../src/storage/journal.js';
import { startHttpHarness } from '../support/harness.js';

const TOOL_NAMES = [
  'brain_capture',
  'brain_feedback',
  'brain_project_ensure',
  'brain_read',
  'brain_recall',
  'brain_review',
  'brain_status'
];

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
};

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  return result as unknown as ToolResult;
}

const textOf = (result: ToolResult): string => result.content[0].text;

function deliveredTokens(result: ToolResult, delivery: 'structured' | 'text-json'): number {
  const visible =
    delivery === 'text-json'
      ? textOf(result)
      : `${JSON.stringify(result.structuredContent)}\n${textOf(result)}`;
  return countReferenceTokens(visible);
}

const captureArgs = (key: string): Record<string, unknown> => ({
  idempotency_key: key,
  scope: 'freellmapi',
  note: lessonFixture
});

test('delivers initialization instructions before a tool is invoked', async () => {
  const h = await startHttpHarness();
  const client = new Client({ name: 'brain-contract-test', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(h.url), {
        requestInit: { headers: { Authorization: `Bearer ${h.token}` } }
      })
    );
    expect(client.getInstructions()).toContain('brain_recall');
    expect(h.recordedToolCalls()).toEqual([]);
    expect((await client.listTools()).tools).toHaveLength(7);
  } finally {
    await client.close();
    await h.close();
  }
});

test('lists the seven tools and completes a status call with structured content', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
    }
    const captureTool = tools.find((tool) => tool.name === 'brain_capture');
    const captureMeta = captureTool?._meta as Record<string, unknown> | undefined;
    expect(captureMeta?.['second-brain/outputSchema']).toBeTruthy();

    const reviewTool = tools.find((tool) => tool.name === 'brain_review');
    const reviewSchema = reviewTool?.outputSchema as { type?: string; oneOf?: unknown[] } | undefined;
    expect(reviewSchema?.type).toBe('object');
    expect(reviewSchema?.oneOf).toHaveLength(2);

    const result = await call(client, 'brain_status', {});
    expect(result.isError).toBeFalsy();
    const structured = record(result.structuredContent);
    expect(structured.version).toBe('0.1.0');
    expect(structured.protocol_version).toBeTruthy();
    expect(structured.schema_version).toBe(1);
    expect(Array.isArray(structured.scopes)).toBe(true);

    const pointer = record(JSON.parse(textOf(result)));
    expect(pointer.delivery).toBe('structured');

    const calls = h.recordedToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('brain_status');
    expect(calls[0].actor_id).toBe(SYSTEM_ACTOR.id);
  } finally {
    await client.close();
    await h.close();
  }
});

test('ensures a repository scope and uses it immediately with the single token', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token, 'runtime-client');
  try {
    const remote = 'https://github.com/example/runtime-project.git';
    const ensured = await call(client, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: remote
    });
    expect(ensured.isError).toBeFalsy();
    const structured = record(ensured.structuredContent);
    const scope = structured.scope as string;
    expect(scope).toBe('runtime-project');
    expect(structured).not.toHaveProperty('permissions');
    const ensuredStatus = await call(client, 'brain_status', {
      operation_id: structured.operation_id
    });
    expect(record(record(ensuredStatus.structuredContent).operation)).toMatchObject({
      repository_identity: 'github.com/example/runtime-project',
      scope
    });

    const captured = await call(client, 'brain_capture', {
      idempotency_key: randomUUID(),
      scope,
      note: lessonFixture
    });
    expect(captured.isError).toBeFalsy();
    const recalled = await call(client, 'brain_recall', {
      scope,
      query: 'proxied request',
      include_candidates: true
    });
    expect(record(recalled.structuredContent).items).toHaveLength(1);

    const ensureAgain = await call(client, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: 'git@github.com:example/runtime-project.git'
    });
    expect(record(ensureAgain.structuredContent).created).toBe(false);
    expect(h.auditedEvents().some((event) => event.tool === 'brain_project_ensure')).toBe(true);

    await client.close();
    const reconnected = await h.connect(h.token, 'runtime-reconnected');
    try {
      const status = await call(reconnected, 'brain_status', {});
      expect(record(status.structuredContent).scopes).toContainEqual({ id: scope });
    } finally {
      await reconnected.close();
    }
  } finally {
    await client.close().catch(() => undefined);
    await h.close();
  }
});

test('sanitizes secret-bearing repository remotes in MCP errors and diagnostics', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  const secret = 'never-log-this-secret';
  try {
    const result = await call(client, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: `https://user:${secret}@github.com/example/private.git`
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(h.loggedDiagnostics().join('\n')).not.toContain(secret);
  } finally {
    await client.close();
    await h.close();
  }
});

test('status reports provisioning state to every authenticated caller', async () => {
  const h = await startHttpHarness();
  const first = await h.connect(h.token);
  const second = await h.connect(h.token);
  try {
    h.backend.ensure_project_fail_once = true;
    const failed = await call(first, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/pending-project.git'
    });
    expect(failed.isError).toBe(true);

    for (const client of [first, second]) {
      const status = record((await call(client, 'brain_status', {})).structuredContent);
      expect(status.projects).toEqual([{ scope: 'pending-project', state: 'provisioning' }]);
      expect(status.pending_operations).toBe(1);
    }
  } finally {
    await Promise.all([first.close(), second.close()]);
    await h.close();
  }
});

test('text-json delivery serializes the complete result once in the text block', async () => {
  const h = await startHttpHarness({ result_delivery: 'text-json' });
  const client = await h.connect(h.token);
  try {
    const result = await call(client, 'brain_status', {});
    expect(result.isError).toBeFalsy();
    const parsed = record(JSON.parse(textOf(result)));
    expect(parsed.version).toBe('0.1.0');
    expect(Array.isArray(parsed.scopes)).toBe(true);
    expect(result.structuredContent).toBeTruthy();
  } finally {
    await client.close();
    await h.close();
  }
});

test.each(['structured', 'text-json'] as const)(
  '%s delivery keeps the full MCP read envelope inside the requested budget',
  async (delivery) => {
    const h = await startHttpHarness({ result_delivery: delivery });
    const client = await h.connect(h.token, `read-budget-${delivery}`);
    try {
      const content = lessonFixture.content.kind === 'lesson' ? lessonFixture.content : undefined;
      if (content === undefined) throw new Error('lesson fixture has the wrong kind');
      const note = {
        ...lessonFixture,
        content: {
          ...content,
          lesson: `${content.lesson} ${'latency '.repeat(500)}`
        }
      };
      const captured = await call(client, 'brain_capture', {
        idempotency_key: randomUUID(),
        scope: 'freellmapi',
        note
      });
      const receipt = record(captured.structuredContent);
      const result = await call(client, 'brain_read', {
        scope: 'freellmapi',
        id: receipt.id,
        budget_tokens: 256
      });
      expect(result.isError).toBeFalsy();
      expect(deliveredTokens(result, delivery)).toBeLessThanOrEqual(256);
    } finally {
      await client.close();
      await h.close();
    }
  }
);

test('text-json delivery paginates a compressible read beneath the aggregate byte cap', async () => {
  const h = await startHttpHarness({ result_delivery: 'text-json' });
  const client = await h.connect(h.token, 'read-byte-budget');
  try {
    const content = lessonFixture.content.kind === 'lesson' ? lessonFixture.content : undefined;
    if (content === undefined) throw new Error('lesson fixture has the wrong kind');
    const captured = await call(client, 'brain_capture', {
      idempotency_key: randomUUID(),
      scope: 'freellmapi',
      note: {
        ...lessonFixture,
        content: {
          ...content,
          limitations: Array.from({ length: 8 }, () => ' accomplishment'.repeat(533))
        }
      }
    });
    expect(captured.isError).toBeFalsy();
    const receipt = record(captured.structuredContent);
    const result = await call(client, 'brain_read', {
      scope: 'freellmapi',
      id: receipt.id,
      budget_tokens: 8000
    });
    expect(result.isError).toBeFalsy();
    expect(record(result.structuredContent).next_cursor).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_BYTES
    );
  } finally {
    await client.close();
    await h.close();
  }
});

test.each(['structured', 'text-json'] as const)(
  '%s delivery keeps the full MCP recall envelope inside the requested budget',
  async (delivery) => {
    const h = await startHttpHarness({ result_delivery: delivery });
    const worker = await h.connect(h.token, `recall-budget-worker-${delivery}`);
    const reviewer = await h.connect(h.token, `recall-budget-reviewer-${delivery}`);
    try {
      const captured = await call(worker, 'brain_capture', captureArgs(randomUUID()));
      const receipt = record(captured.structuredContent);
      const approved = await call(reviewer, 'brain_review', {
        scope: 'freellmapi',
        operation: {
          action: 'approve',
          idempotency_key: randomUUID(),
          id: receipt.id,
          expected_etag: receipt.etag,
          rationale: 'The synthetic benchmark evidence supports this lesson.'
        }
      });
      expect(approved.isError).toBeFalsy();
      const result = await call(worker, 'brain_recall', {
        scope: 'freellmapi',
        query: 'first token latency',
        mode: 'text',
        budget_tokens: 256
      });
      expect(result.isError).toBeFalsy();
      expect(deliveredTokens(result, delivery)).toBeLessThanOrEqual(256);
    } finally {
      await worker.close();
      await reviewer.close();
      await h.close();
    }
  }
);

test('an unknown project returns a structured, retryability-tagged tool error', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const result = await call(client, 'brain_status', { project: 'unknown-project' });
    expect(result.isError).toBe(true);
    const error = record(record(result.structuredContent).error);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.retryable).toBe(false);
    const parsed = record(JSON.parse(textOf(result)));
    expect(record(parsed.error).code).toBe('NOT_FOUND');
  } finally {
    await client.close();
    await h.close();
  }
});

test('schema-invalid arguments are rejected before any service call', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const result = await call(client, 'brain_recall', { scope: 'freellmapi' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toMatch(/Invalid arguments/);
    expect(h.recordedToolCalls()).toEqual([]);
  } finally {
    await client.close();
    await h.close();
  }
});

test('read and both review result branches survive output validation', async () => {
  const h = await startHttpHarness();
  const worker = await h.connect(h.token, 'read-worker');
  const reviewer = await h.connect(h.token, 'review-approver');
  try {
    const capture = await call(worker, 'brain_capture', captureArgs(randomUUID()));
    const receipt = record(capture.structuredContent);
    const read = await call(worker, 'brain_read', {
      scope: 'freellmapi',
      id: receipt.id as string
    });
    expect(read.isError).toBeFalsy();
    const source = record(record(read.structuredContent).source);
    expect(typeof record(read.structuredContent).markdown).toBe('string');

    const listing = await call(reviewer, 'brain_review', {
      scope: 'freellmapi',
      operation: { action: 'list', filter: 'candidate' }
    });
    expect(listing.isError).toBeFalsy();
    expect(Array.isArray(record(listing.structuredContent).items)).toBe(true);

    const approval = await call(reviewer, 'brain_review', {
      scope: 'freellmapi',
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id: receipt.id as string,
        expected_etag: source.etag as string,
        rationale: 'Reviewed during the HTTP contract test'
      }
    });
    expect(approval.isError).toBeFalsy();
    expect(record(approval.structuredContent).outcome).toBe('stored');
  } finally {
    await worker.close();
    await reviewer.close();
    await h.close();
  }
});

test('the published review schema encodes the result union', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const review = (await client.listTools()).tools.find((tool) => tool.name === 'brain_review');
    const schema = review?.outputSchema as { type?: string; oneOf?: unknown[] } | undefined;
    expect(schema?.type).toBe('object');
    expect(schema?.oneOf).toHaveLength(2);

    const validator = new AjvJsonSchemaValidator().getValidator(
      review?.outputSchema as Record<string, unknown>
    );
    const receipt = {
      operation_id: randomUUID(),
      id: randomUUID(),
      revision_id: randomUUID(),
      outcome: 'stored',
      materialized: true,
      indexed: true,
      possible_duplicates: [],
      warnings: []
    };
    expect(validator(receipt).valid).toBe(true);
    expect(validator({ items: [] }).valid).toBe(true);
    expect(validator({}).valid).toBe(false);
    expect(validator({ operation_id: receipt.operation_id, items: [] }).valid).toBe(false);
    expect(validator({ id: receipt.id, materialized: true }).valid).toBe(false);
  } finally {
    await client.close();
    await h.close();
  }
});

test('concurrent clients share one identity and key namespace', async () => {
  const h = await startHttpHarness();
  const first = await h.connect(h.token, 'client-one');
  const second = await h.connect(h.token, 'client-two');
  try {
    for (const client of [first, second]) {
      const status = record((await call(client, 'brain_status', {})).structuredContent);
      const scope = (status.scopes as { id: string }[]).find((entry) => entry.id === 'freellmapi');
      expect(scope).toEqual({ id: 'freellmapi' });
    }

    const key = randomUUID();
    const firstCapture = await call(first, 'brain_capture', captureArgs(key));
    expect(firstCapture.isError).toBeFalsy();
    const operationId = record(firstCapture.structuredContent).operation_id as string;

    const secondCapture = await call(second, 'brain_capture', captureArgs(key));
    expect(record(secondCapture.structuredContent).operation_id).toBe(operationId);

    const lookup = await call(second, 'brain_status', { operation_id: operationId });
    expect(lookup.isError).toBeFalsy();
    expect(record(record(lookup.structuredContent).operation).operation_id).toBe(operationId);

    const actors = new Set(h.recordedToolCalls().map((entry) => entry.actor_id));
    expect(actors.has(SYSTEM_ACTOR.id)).toBe(true);
    expect(actors.size).toBe(1);
  } finally {
    await first.close();
    await second.close();
    await h.close();
  }
});

test('runtime token rotation invalidates the previous token', async () => {
  const h = await startHttpHarness();
  const before = await h.connect(h.token, 'before-rotation');
  expect((await before.listTools()).tools).toHaveLength(7);
  await before.close();

  const next = `rotated-${randomUUID()}`;
  const digestValue = createHash('sha256').update(next, 'utf8').digest('hex');
  h.runtime.rotateTokenDigest(digestValue);

  const rejected = await fetch(h.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${h.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  expect(rejected.status).toBe(401);

  const accepted = await fetch(h.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${next}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  expect(accepted.status).toBe(200);
  await h.close();
});

test('recall records a content-free retrieval event', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    await call(client, 'brain_capture', captureArgs(randomUUID()));
    const recalled = await call(client, 'brain_recall', {
      scope: 'freellmapi',
      query: lessonFixture.title
    });
    expect(recalled.isError).toBeFalsy();
    const retrievalId = record(recalled.structuredContent).retrieval_id as string;
    const event = h.runtime.deps.journal.getRetrieval(retrievalId);
    expect(event).toBeDefined();
    expect(event?.principal_id).toBe(SYSTEM_ACTOR.id);
    expect(event?.scope_ids).toContain('freellmapi');
    expect(JSON.stringify(event)).not.toContain(lessonFixture.title);
  } finally {
    await client.close();
    await h.close();
  }
});

test('a raw backend tool is not exposed and never reaches the backend', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('write_note');
    const result = await call(client, 'write_note', {
      project: 'freellmapi',
      title: 'raw',
      content: 'raw'
    });
    expect(result.isError).toBe(true);
    expect(h.backend.create_calls).toHaveLength(0);
    expect(h.recordedToolCalls()).toEqual([]);
  } finally {
    await client.close();
    await h.close();
  }
});

test('a client can reconnect and continue calling tools', async () => {
  const h = await startHttpHarness();
  const first = await h.connect(h.token, 'first-connection');
  await call(first, 'brain_status', {});
  await first.close();

  const second = await h.connect(h.token, 'second-connection');
  try {
    const result = await call(second, 'brain_status', {});
    expect(result.isError).toBeFalsy();
    expect(h.recordedToolCalls()).toHaveLength(2);
  } finally {
    await second.close();
    await h.close();
  }
});

test('a write blocked past the drain deadline keeps the lock until it completes', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token, 'blocked-write');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.backend.on_create = async () => {
    entered();
    await gate;
  };

  const pending = call(client, 'brain_capture', captureArgs(randomUUID())).catch(() => undefined);
  await enteredPromise;

  const closing = h.runtime.close();
  const drainDeadline = Date.now() + 3000;
  while (Date.now() < drainDeadline && !h.runtime.shutdownPending) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(h.runtime.shutdownPending).toBe(true);
  expect(h.runtime.closed).toBe(false);

  const replacementBackend = new FakeBackend({
    root: h.config.mounts.vault,
    projects: h.config.scopes.map((scope) => scope.backend_project)
  });
  await expect(createRuntime(h.config, { backend: replacementBackend, token_digest: h.runtime.tokenDigest })).rejects.toMatchObject({
    code: 'CONFLICT'
  });

  release();
  await closing;
  await pending;
  await client.close().catch(() => undefined);
  expect(h.runtime.shutdownPending).toBe(false);
  expect(h.runtime.closed).toBe(true);

  const reopened = await createRuntime(h.config, { backend: replacementBackend, token_digest: h.runtime.tokenDigest });
  try {
    expect(reopened.ready).toBe(true);
    const candidates = await reopened.deps.catalogue.list('freellmapi', 'candidate');
    expect(candidates.items.some((item) => item.title === lessonFixture.title)).toBe(true);
  } finally {
    await reopened.close();
    await replacementBackend.close().catch(() => undefined);
    await h.close();
  }
});

test('normal runtime startup refuses an existing vault after its journal is lost', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token, 'lost-journal-seed');
  try {
    const captured = await call(client, 'brain_capture', captureArgs(randomUUID()));
    expect(captured.isError).toBeFalsy();
  } finally {
    await client.close();
    await h.runtime.close();
  }
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${h.config.mounts.state}/journal.db${suffix}`, { force: true });
  }
  const backend = new FakeBackend({
    root: h.config.mounts.vault,
    projects: h.config.scopes.map((scope) => scope.backend_project)
  });
  await expect(createRuntime(h.config, { backend, token_digest: h.runtime.tokenDigest })).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED'
  });
  await expect(rm(`${h.config.mounts.state}/journal.db`)).rejects.toMatchObject({ code: 'ENOENT' });
  await backend.close().catch(() => undefined);
  await h.close();
});

test('normal runtime startup detects lost state when only a dynamic project remains', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token, 'lost-dynamic-state-seed');
  try {
    const ensured = await call(client, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/dynamic-only.git'
    });
    const scope = record(ensured.structuredContent).scope as string;
    const captured = await call(client, 'brain_capture', {
      idempotency_key: randomUUID(),
      scope,
      note: lessonFixture
    });
    expect(captured.isError).toBeFalsy();
  } finally {
    await client.close();
    await h.runtime.close();
  }
  await rm(h.config.mounts.state, { recursive: true, force: true });
  await mkdir(h.config.mounts.state, { recursive: true });
  const backend = new FakeBackend({
    root: h.config.mounts.vault,
    projects: h.config.scopes.map((scope) => scope.backend_project)
  });
  await expect(createRuntime(h.config, { backend, token_digest: h.runtime.tokenDigest })).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED'
  });
  await backend.close().catch(() => undefined);
  await h.close();
});

test('startup quarantines one broken dynamic scope while unrelated scopes remain available', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token, 'broken-dynamic-scope-seed');
  let scope = '';
  try {
    const ensured = await call(client, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/broken-dynamic.git'
    });
    scope = record(ensured.structuredContent).scope as string;
  } finally {
    await client.close();
    await h.runtime.close();
  }
  await rm(`${h.config.mounts.vault}/Projects/${scope}`, { recursive: true, force: true });
  const backend = new FakeBackend({
    root: h.config.mounts.vault,
    projects: h.config.scopes.map((candidate) => candidate.backend_project)
  });
  const reopened = await createRuntime(h.config, { backend, token_digest: h.runtime.tokenDigest });
  try {
    expect(reopened.ready).toBe(true);
    expect(reopened.deps.scopeRegistry.isUsable(scope)).toBe(false);
    expect(reopened.deps.scopeRegistry.isUsable('shared')).toBe(true);
    expect(reopened.deps.journal.getProjectById(scope)).toMatchObject({
      state: 'recovery_required',
      provisioning: { failure_stage: 'startup_verification' }
    });
  } finally {
    await reopened.close();
    await backend.close().catch(() => undefined);
    await h.close();
  }
});

test('startup quarantines a missing project binding without blocking another project', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  let scope = '';
  try {
    const result = await call(client, 'brain_project_ensure', {
      idempotency_key: randomUUID(), remote_url: 'https://github.com/example/unbound-startup.git'
    });
    expect(result.isError).toBeFalsy();
    scope = record(result.structuredContent).scope as string;
  } finally {
    await client.close();
    await h.runtime.close();
  }
  const database = new Database(join(h.config.mounts.state, 'journal.db'));
  database.prepare('DELETE FROM legacy_project_backend_bindings WHERE project_id = ?').run(scope);
  database.close();
  const backend = new FakeBackend({
    root: h.config.mounts.vault,
    projects: h.config.scopes.map((item) => item.backend_project)
  });
  try {
    const reopened = await createRuntime(h.config, { backend, token_digest: h.runtime.tokenDigest });
    try {
      expect(reopened.ready).toBe(true);
      expect(reopened.deps.scopeRegistry.all().map((item) => item.id)).toContain('shared');
      expect(reopened.deps.scopeRegistry.all().map((item) => item.id)).not.toContain(scope);
      expect(reopened.deps.journal.getProjectById(scope)?.state).toBe('recovery_required');
      expect(() => reopened.deps.scopeRegistry.require(scope)).toThrow(/RECOVERY_REQUIRED/);
      expect(reopened.deps.scopeRegistry.require('shared').id).toBe('shared');
      const context = {
        actor: SYSTEM_ACTOR, request_id: randomUUID(), signal: new AbortController().signal
      };
      expect((await reopened.services.status(context, { project: 'shared' })).scopes).toContainEqual({ id: 'shared' });
      await expect(reopened.services.status(context, { project: scope })).rejects.toMatchObject({
        code: 'RECOVERY_REQUIRED'
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await backend.close().catch(() => undefined);
    await h.close();
  }
});

test('runtime features use independent project ID, name, vault root and backend binding', async () => {
  const h = await startHttpHarness();
  await h.runtime.close();
  const journal = Journal.open(join(h.config.mounts.state, 'journal.db'), { requireExisting: true });
  try {
    journal.reserveProject({
      project_id: 'stable-four', display_name: 'Human Facing Name',
      relative_root: 'Knowledge/Four', repository_identity: 'github.com/example/four-way-runtime',
      backend_project: 'storage-four', backend_relative_root: 'BackendData/Four',
      created_by_actor_id: 'system', creation_operation_id: randomUUID()
    });
    journal.markProjectReady('stable-four');
  } finally {
    journal.close();
  }
  await mkdir(join(h.config.mounts.vault, 'Knowledge/Four'), { recursive: true });
  const backend = new FakeBackend({
    root: h.config.mounts.vault,
    projects: [...h.config.scopes.map((scope) => scope.backend_project), 'storage-four']
  });
  const verified: [string, string][] = [];
  const searched: string[] = [];
  const originalVerify = backend.verifyProject.bind(backend);
  const originalSearch = backend.search.bind(backend);
  backend.verifyProject = async (name, path) => {
    verified.push([name, path]);
    return name === 'storage-four' && path === '/app/data/BackendData/Four'
      ? true : originalVerify(name, path);
  };
  backend.search = async (input) => {
    searched.push(input.project);
    return input.project === 'storage-four' ? { hits: [], has_more: false } : originalSearch(input);
  };
  try {
    const runtime = await createRuntime(h.config, { backend, token_digest: h.runtime.tokenDigest });
    try {
      expect(runtime.deps.journal.getProjectById('stable-four')?.project).toMatchObject({
        id: 'stable-four', display_name: 'Human Facing Name', relative_root: 'Knowledge/Four'
      });
      const recalled = await runtime.services.recall(
        { actor: SYSTEM_ACTOR, request_id: randomUUID(), signal: new AbortController().signal },
        { project: 'github.com/example/four-way-runtime', query: 'fixture term', mode: 'text' }
      );
      expect(recalled.partial).toBe(false);
      expect(recalled.items).toEqual([]);
      expect(searched).toEqual(['storage-four']);
      expect(verified).toContainEqual(['storage-four', '/app/data/BackendData/Four']);
      expect(runtime.deps.scopeRegistry.require('stable-four').relative_root).toBe('Knowledge/Four');
      expect(runtime.deps.scopeRegistry.require('stable-four').backend_project).toBe('storage-four');
    } finally {
      await runtime.close();
    }
  } finally {
    await backend.close().catch(() => undefined);
    await h.close();
  }
});

test('enforces the configured shared read-concurrency limit', async () => {
  const h = await startHttpHarness({ concurrent_reads: 2 });
  const clients = await Promise.all(
    Array.from({ length: 6 }, (_, index) => h.connect(h.token, `bounded-read-${index}`))
  );
  const originalSearch = h.backend.search.bind(h.backend);
  let active = 0;
  let maximum = 0;
  h.backend.search = async (input) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      return await originalSearch(input);
    } finally {
      active -= 1;
    }
  };
  try {
    const results = await Promise.all(
      clients.map((client) =>
        call(client, 'brain_recall', {
          scope: 'freellmapi',
          query: 'bounded concurrency',
          mode: 'text'
        })
      )
    );
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(maximum).toBe(2);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await h.close();
  }
});

test('public MCP backend errors redact every rejected credential family', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token, 'credential-error-redaction');
  const secrets = [
    '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
    'Bearer abcdefghijklmnopqrstuvwxyz012345',
    'password=visible-secret-value',
    'sk-abcdefghijklmnopqrstuvwxyz012345'
  ];
  try {
    for (const secret of secrets) {
      h.backend.search = async () => {
        throw new BrainError({ code: 'BACKEND_UNAVAILABLE', message: `upstream exposed ${secret}` });
      };
      const result = await call(client, 'brain_recall', {
        scope: 'freellmapi',
        query: 'redaction probe',
        mode: 'text'
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  } finally {
    await client.close();
    await h.close();
  }
});

test('note, query, and token markers never reach diagnostics or audit', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const noteMarker = 'note-marker-7c1d';
    const queryMarker = 'query-marker-3ab9';

    h.backend.on_create = async () => {
      throw new Error('backend link reset');
    };
    const failed = await call(client, 'brain_capture', {
      idempotency_key: randomUUID(),
      scope: 'freellmapi',
      note: { ...lessonFixture, title: noteMarker }
    });
    expect(failed.isError).toBe(true);
    expect(record(record(failed.structuredContent).error).code).toBe('INTERNAL_ERROR');
    h.backend.on_create = undefined;

    const capture = await call(client, 'brain_capture', captureArgs(randomUUID()));
    const receipt = record(capture.structuredContent);
    await call(client, 'brain_feedback', {
      idempotency_key: randomUUID(),
      scope: 'freellmapi',
      id: receipt.id,
      revision_id: receipt.revision_id,
      verdict: 'useful',
      reason: noteMarker
    });
    await call(client, 'brain_recall', { scope: 'freellmapi', query: queryMarker });
    await call(client, 'brain_status', {});

    expect(h.auditedEvents().length).toBeGreaterThan(0);
    const diagnostics = JSON.stringify(h.loggedDiagnostics());
    expect(diagnostics).not.toContain(noteMarker);
    expect(diagnostics).not.toContain(queryMarker);
    expect(diagnostics).not.toContain(h.token);
    const audit = JSON.stringify(h.auditedEvents());
    expect(audit).not.toContain(noteMarker);
    expect(audit).not.toContain(queryMarker);
    expect(audit).not.toContain(h.token);
    expect(JSON.stringify(h.recordedToolCalls())).not.toContain(noteMarker);
  } finally {
    await client.close();
    await h.close();
  }
});
