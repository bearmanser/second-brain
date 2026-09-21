import { randomUUID, createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createRuntime } from '../../src/runtime.js';
import { countReferenceTokens } from '../../src/retrieval/budget.js';
import { BrainError } from '../../src/contracts/errors.js';
import { TOOL_RESULT_MAX_BYTES } from '../../src/core/limits.js';
import { lessonFixture } from '../fixtures/content.js';
import { workerPrincipal } from '../fixtures/principals.js';
import { FakeBackend } from '../support/fake-backend.js';
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
    expect(calls[0].principal_id).toBe(workerPrincipal.id);
  } finally {
    await client.close();
    await h.close();
  }
});

test('ensures a repository scope and uses it immediately across principals and reconnects', async () => {
  const h = await startHttpHarness();
  const worker = await h.connect(h.token, 'project-worker');
  const reviewer = await h.connect(h.reviewerToken, 'project-reviewer');
  try {
    const remote = 'https://github.com/example/runtime-project.git';
    const ensured = await call(worker, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: remote
    });
    expect(ensured.isError).toBeFalsy();
    const scope = record(ensured.structuredContent).scope as string;
    expect(scope).toBe('runtime-project');
    const ensuredStatus = await call(worker, 'brain_status', {
      operation_id: record(ensured.structuredContent).operation_id
    });
    expect(record(record(ensuredStatus.structuredContent).operation)).toMatchObject({
      repository_identity: 'github.com/example/runtime-project',
      scope
    });

    const captured = await call(worker, 'brain_capture', {
      idempotency_key: randomUUID(),
      scope,
      note: lessonFixture
    });
    expect(captured.isError).toBeFalsy();
    const recalled = await call(worker, 'brain_recall', {
      scope,
      query: 'proxied request',
      include_candidates: true
    });
    expect(record(recalled.structuredContent).items).toHaveLength(1);

    const isolated = await call(reviewer, 'brain_recall', {
      scope,
      query: 'proxied request',
      include_candidates: true
    });
    expect(isolated.isError).toBe(true);
    const reviewerEnsure = await call(reviewer, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: 'git@github.com:example/runtime-project.git'
    });
    expect(record(reviewerEnsure.structuredContent).permissions).toEqual({
      can_read: true,
      can_write: true,
      can_review: true
    });
    expect(h.auditedEvents().some((event) => event.tool === 'brain_project_ensure')).toBe(true);

    await worker.close();
    const reconnected = await h.connect(h.rotatedToken, 'project-worker-reconnected');
    try {
      const status = await call(reconnected, 'brain_status', {});
      expect(record(status.structuredContent).scopes).toContainEqual({
        id: scope,
        can_write: true,
        can_review: false
      });
    } finally {
      await reconnected.close();
    }
  } finally {
    await reviewer.close();
    await worker.close().catch(() => undefined);
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

test('status reveals a failed provisioning only to its caller and owners', async () => {
  const h = await startHttpHarness();
  const worker = await h.connect(h.token);
  const reviewer = await h.connect(h.reviewerToken);
  const owner = await h.connect(h.ownerToken);
  try {
    h.backend.ensure_project_fail_once = true;
    const failed = await call(worker, 'brain_project_ensure', {
      idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/pending-project.git'
    });
    expect(failed.isError).toBe(true);

    const workerStatus = record((await call(worker, 'brain_status', {})).structuredContent);
    expect(workerStatus.projects).toEqual([{ scope: 'pending-project', state: 'provisioning' }]);
    expect(workerStatus.pending_operations).toBe(1);

    const reviewerStatus = record((await call(reviewer, 'brain_status', {})).structuredContent);
    expect(reviewerStatus.projects).toBeUndefined();
    expect(reviewerStatus.pending_operations).toBe(0);

    const ownerStatus = record((await call(owner, 'brain_status', {})).structuredContent);
    expect(ownerStatus.projects).toEqual([{ scope: 'pending-project', state: 'provisioning' }]);
  } finally {
    await Promise.all([worker.close(), reviewer.close(), owner.close()]);
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
    const reviewer = await h.connect(h.reviewerToken, `recall-budget-reviewer-${delivery}`);
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

test('an unauthorized scope returns a structured, retryability-tagged tool error', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const result = await call(client, 'brain_status', { scope: 'profile' });
    expect(result.isError).toBe(true);
    const error = record(record(result.structuredContent).error);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.retryable).toBe(false);
    const parsed = record(JSON.parse(textOf(result)));
    expect(record(parsed.error).code).toBe('FORBIDDEN');
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
  const reviewer = await h.connect(h.reviewerToken, 'review-approver');
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
  const client = await h.connect(h.reviewerToken);
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

test('two simultaneous principals keep separate identities and tool closures', async () => {
  const h = await startHttpHarness();
  const worker = await h.connect(h.token, 'worker-client');
  const reviewer = await h.connect(h.reviewerToken, 'reviewer-client');
  try {
    const workerStatus = record((await call(worker, 'brain_status', {})).structuredContent);
    const reviewerStatus = record((await call(reviewer, 'brain_status', {})).structuredContent);
    const workerScope = (workerStatus.scopes as { id: string; can_review: boolean }[]).find(
      (scope) => scope.id === 'freellmapi'
    );
    const reviewerScope = (reviewerStatus.scopes as { id: string; can_review: boolean }[]).find(
      (scope) => scope.id === 'freellmapi'
    );
    expect(workerScope?.can_review).toBe(false);
    expect(reviewerScope?.can_review).toBe(true);

    const key = randomUUID();
    const workerCapture = await call(worker, 'brain_capture', captureArgs(key));
    expect(workerCapture.isError).toBeFalsy();
    const workerOperation = record(workerCapture.structuredContent).operation_id as string;

    const reviewerCapture = await call(reviewer, 'brain_capture', captureArgs(key));
    expect(reviewerCapture.isError).toBeFalsy();
    const reviewerOperation = record(reviewerCapture.structuredContent).operation_id as string;
    expect(reviewerOperation).not.toBe(workerOperation);

    const foreignLookup = await call(reviewer, 'brain_status', { operation_id: workerOperation });
    expect(foreignLookup.isError).toBe(true);
    expect(record(record(foreignLookup.structuredContent).error).code).toBe('NOT_FOUND');

    const ownLookup = await call(worker, 'brain_status', { operation_id: workerOperation });
    expect(ownLookup.isError).toBeFalsy();
    expect(record(record(ownLookup.structuredContent).operation).operation_id).toBe(workerOperation);

    const principals = new Set(h.recordedToolCalls().map((entry) => entry.principal_id));
    expect(principals.has(workerPrincipal.id)).toBe(true);
    expect(principals.size).toBe(2);
  } finally {
    await worker.close();
    await reviewer.close();
    await h.close();
  }
});

test('rotated tokens authenticate as one principal identity', async () => {
  const h = await startHttpHarness();
  const first = await h.connect(h.token, 'before-rotation');
  try {
    const capture = await call(first, 'brain_capture', captureArgs(randomUUID()));
    expect(capture.isError).toBeFalsy();
    const operationId = record(capture.structuredContent).operation_id as string;
    await first.close();

    const second = await h.connect(h.rotatedToken, 'after-rotation');
    const status = await call(second, 'brain_status', { operation_id: operationId });
    expect(status.isError).toBeFalsy();
    expect(record(record(status.structuredContent).operation).operation_id).toBe(operationId);
    await second.close();
  } finally {
    await h.close();
  }
});

test('a rotated-out credential stops authenticating after a credential reload', async () => {
  const h = await startHttpHarness();
  const before = await h.connect(h.token, 'before-rotation');
  expect((await before.listTools()).tools).toHaveLength(7);
  await before.close();

  const digest = (token: string): string =>
    createHash('sha256').update(token, 'utf8').digest('hex');
  await writeFile(
    h.credentialsFile,
    `${JSON.stringify({
      credentials: [{ token_sha256: digest(h.rotatedToken), principal: workerPrincipal }]
    })}\n`,
    'utf8'
  );
  h.runtime.reloadCredentials();

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

  const after = await h.connect(h.rotatedToken, 'after-rotation');
  try {
    expect((await after.listTools()).tools).toHaveLength(7);
  } finally {
    await after.close();
    await h.close();
  }
});

test('a running runtime reloads rotated credentials written to disk', async () => {
  const h = await startHttpHarness();
  const before = await h.connect(h.token, 'before-rotation');
  expect((await before.listTools()).tools).toHaveLength(7);
  await before.close();

  const digest = (token: string): string =>
    createHash('sha256').update(token, 'utf8').digest('hex');
  await writeFile(
    h.credentialsFile,
    `${JSON.stringify({
      credentials: [{ token_sha256: digest(h.rotatedToken), principal: workerPrincipal }]
    })}\n`,
    'utf8'
  );

  const deadline = Date.now() + 5000;
  let status = 0;
  while (Date.now() < deadline) {
    const response = await fetch(h.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    status = response.status;
    if (status === 401) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(status).toBe(401);

  const after = await h.connect(h.rotatedToken, 'after-rotation');
  try {
    expect((await after.listTools()).tools).toHaveLength(7);
  } finally {
    await after.close();
    await h.close();
  }
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
    expect(event?.principal_id).toBe(workerPrincipal.id);
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
  await expect(createRuntime(h.config, { backend: replacementBackend })).rejects.toMatchObject({
    code: 'CONFLICT'
  });

  release();
  await closing;
  await pending;
  await client.close().catch(() => undefined);
  expect(h.runtime.shutdownPending).toBe(false);
  expect(h.runtime.closed).toBe(true);

  const reopened = await createRuntime(h.config, { backend: replacementBackend });
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
  await expect(createRuntime(h.config, { backend })).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED'
  });
  await expect(rm(`${h.config.mounts.state}/journal.db`)).rejects.toMatchObject({ code: 'ENOENT' });
  await backend.close().catch(() => undefined);
  await h.close();
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
