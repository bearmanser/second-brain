import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRuntime } from '../../src/runtime.js';
import type { RequestContext } from '../../src/core/types.js';
import { lessonFixture } from '../fixtures/content.js';
import { workerPrincipal } from '../fixtures/principals.js';
import { FakeBackend } from '../support/fake-backend.js';
import { startHttpHarness } from '../support/harness.js';

const TOOL_NAMES = [
  'brain_capture',
  'brain_feedback',
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

const captureArgs = (key: string): Record<string, unknown> => ({
  idempotency_key: key,
  scope: 'freellmapi',
  note: lessonFixture
});

test('delivers initialization instructions before a tool is invoked', async () => {
  const h = await startHttpHarness();
  const client = new Client({ name: 'brain-contract-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(h.url), {
      requestInit: { headers: { Authorization: `Bearer ${h.token}` } }
    })
  );
  expect(client.getInstructions()).toContain('brain_recall');
  expect(h.recordedToolCalls()).toEqual([]);
  expect((await client.listTools()).tools).toHaveLength(6);
  await client.close();
  await h.close();
});

test('lists the six tools and completes a status call with structured content', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.description).toBeTruthy();
    }
    const captureTool = tools.find((tool) => tool.name === 'brain_capture');
    expect(captureTool?.outputSchema).toBeUndefined();
    const meta = captureTool?._meta as Record<string, unknown> | undefined;
    expect(meta?.['second-brain/outputSchema']).toBeTruthy();

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
  expect((await before.listTools()).tools).toHaveLength(6);
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
    expect((await after.listTools()).tools).toHaveLength(6);
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

test('a raw backend tool is not exposed and never reaches the backend', async () => {  const h = await startHttpHarness();
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

test('a write in flight at shutdown is recovered by the next runtime', async () => {
  const h = await startHttpHarness();
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

  const ctx: RequestContext = {
    principal: workerPrincipal,
    request_id: randomUUID(),
    signal: h.runtime.shutdownSignal
  };
  const inFlight = h.runtime.services.capture(ctx, {
    idempotency_key: randomUUID(),
    scope: 'freellmapi',
    note: lessonFixture
  });
  await enteredPromise;

  const closing = h.runtime.close();
  release();
  await closing;
  await inFlight.catch(() => undefined);

  const reopenedBackend = new FakeBackend({
    root: h.config.mounts.vault,
    projects: h.config.scopes.map((scope) => scope.backend_project)
  });
  const reopened = await createRuntime(h.config, { backend: reopenedBackend });
  try {
    expect(reopened.ready).toBe(true);
    const candidates = await reopened.deps.catalogue.list('freellmapi', 'candidate');
    expect(candidates.items.some((item) => item.title === lessonFixture.title)).toBe(true);
  } finally {
    await reopened.close();
    await reopenedBackend.close().catch(() => undefined);
    await h.close();
  }
});

test('normal operation never writes note or query content into diagnostics', async () => {
  const h = await startHttpHarness();
  const client = await h.connect(h.token);
  try {
    const marker = 'diagnostic-secret-marker-9f3a';
    const capture = await call(client, 'brain_capture', {
      idempotency_key: randomUUID(),
      scope: 'freellmapi',
      note: { ...lessonFixture, title: marker }
    });
    const receipt = record(capture.structuredContent);
    await call(client, 'brain_feedback', {
      idempotency_key: randomUUID(),
      scope: 'freellmapi',
      id: receipt.id,
      revision_id: receipt.revision_id,
      verdict: 'useful',
      reason: marker
    });
    await call(client, 'brain_recall', { scope: 'freellmapi', query: marker });
    await call(client, 'brain_status', {});

    expect(h.auditedEvents().length).toBeGreaterThan(0);
    for (const line of h.loggedDiagnostics()) {
      expect(line).not.toContain(marker);
    }
    for (const event of h.auditedEvents()) {
      expect(JSON.stringify(event)).not.toContain(marker);
    }
    expect(JSON.stringify(h.recordedToolCalls())).not.toContain(marker);
  } finally {
    await client.close();
    await h.close();
  }
});
