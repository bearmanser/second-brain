import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { BrainError } from '../../src/contracts/errors.js';
import { brainConfigSchema } from '../../src/config/schema.js';
import {
  captureRequestSchema,
  feedbackRequestSchema,
  readRequestSchema,
  recallRequestSchema,
  reviewRequestSchema,
  statusRequestSchema
} from '../../src/contracts/protocol.js';
import { TOOL_RESULT_MAX_BYTES } from '../../src/core/limits.js';
import type {
  FeedbackResult,
  MutationReceipt,
  RecallResult,
  ReadResult,
  ReviewListResult,
  SourceRef,
  StatusResult
} from '../../src/core/types.js';
import { capture } from '../../src/features/capture.js';
import { status } from '../../src/features/status.js';
import { buildInstructions } from '../../src/mcp/instructions.js';
import {
  APPLICATION_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  sanitizeDiagnostic,
  toToolError,
  toToolResult,
  toolDefinitions
} from '../../src/mcp/tools.js';
import type { ToolName } from '../../src/mcp/tools.js';
import { fixtureIds, lessonFixture } from '../fixtures/content.js';
import {
  ownerContext,
  ownerPrincipal,
  reviewerContext,
  workerContext
} from '../fixtures/principals.js';
import { createHarness } from '../support/harness.js';

const key = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

const requestSchemas: Record<ToolName, z.ZodType> = {
  brain_capture: captureRequestSchema,
  brain_feedback: feedbackRequestSchema,
  brain_read: readRequestSchema,
  brain_recall: recallRequestSchema,
  brain_review: reviewRequestSchema,
  brain_status: statusRequestSchema
};

const TOOL_NAMES: ToolName[] = [
  'brain_capture',
  'brain_feedback',
  'brain_read',
  'brain_recall',
  'brain_review',
  'brain_status'
];

const byName = (): Record<string, (typeof toolDefinitions)[number]> =>
  Object.fromEntries(toolDefinitions.map((item) => [item.name, item]));

const source: SourceRef = {
  id: fixtureIds.note,
  revision_id: fixtureIds.revision,
  scope: 'freellmapi',
  title: lessonFixture.title,
  kind: 'lesson',
  status: 'active',
  etag: 'a'.repeat(64),
  relative_path: 'freellmapi/Lessons/compare.md',
  warnings: []
};

const receiptSample: MutationReceipt = {
  operation_id: fixtureIds.idempotencyKey,
  id: fixtureIds.note,
  revision_id: fixtureIds.revision,
  outcome: 'stored',
  materialized: true,
  indexed: true,
  etag: 'a'.repeat(64),
  possible_duplicates: [],
  warnings: []
};

const recallSample: RecallResult = {
  retrieval_id: fixtureIds.idempotencyKey,
  mode: 'hybrid',
  partial: false,
  warnings: [],
  budget: { tokenizer: 'cl100k_base', used: 120, limit: 1500 },
  items: [{ ...source, excerpt: 'Measure before attributing.', reasons: ['hybrid_mode'] }]
};

const readSample: ReadResult = {
  source,
  markdown: '# Compare direct and proxied TTFT\n\nMeasure before attributing.'
};

const reviewListSample: ReviewListResult = { items: [source] };
const feedbackSample: FeedbackResult = { feedback_id: fixtureIds.revision, recorded: true };
const statusSample: StatusResult = {
  version: APPLICATION_VERSION,
  protocol_version: PROTOCOL_VERSION,
  schema_version: 1,
  scopes: [{ id: 'freellmapi', can_write: true, can_review: false }],
  health: { gateway: 'ready', backend: 'ready', embeddings: 'unknown' },
  pending_operations: 0
};

test('exposes only the six controlled Brain tools', () => {
  expect(toolDefinitions.map((item) => item.name).sort()).toEqual([
    'brain_capture',
    'brain_feedback',
    'brain_read',
    'brain_recall',
    'brain_review',
    'brain_status'
  ]);
  expect(buildInstructions()).toContain('brain_recall');
  expect(buildInstructions()).toContain('candidate');
});

test('publishes the Zod request schema as JSON Schema for every tool', () => {
  expect(toolDefinitions.map((item) => item.name).sort()).toEqual([...TOOL_NAMES].sort());
  for (const definition of toolDefinitions) {
    expect(definition.description.length).toBeGreaterThan(0);
    expect(definition.inputSchema).toEqual(z.toJSONSchema(requestSchemas[definition.name]));
    expect(definition.inputSchema).toMatchObject({ type: 'object' });
    const output = definition.outputSchema as { type?: string; oneOf?: unknown[] };
    expect(output.type === 'object' || Array.isArray(output.oneOf)).toBe(true);
  }
});

test('marks read-only and mutating tools distinctly without claiming universal safety', () => {
  const tools = byName();
  for (const name of ['brain_read', 'brain_recall', 'brain_status'] as const) {
    expect(tools[name].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
  }
  for (const name of ['brain_capture', 'brain_feedback'] as const) {
    expect(tools[name].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
  }
  expect(tools.brain_review.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  });
  for (const definition of toolDefinitions) {
    expect(definition.annotations.title.length).toBeGreaterThan(0);
    expect(typeof definition.annotations.readOnlyHint).toBe('boolean');
    expect(typeof definition.annotations.destructiveHint).toBe('boolean');
    expect(typeof definition.annotations.idempotentHint).toBe('boolean');
    expect(typeof definition.annotations.openWorldHint).toBe('boolean');
  }
});

test('output schemas stay consistent with the published data shapes', () => {
  const samples: Record<ToolName, Record<string, unknown>> = {
    brain_capture: receiptSample as unknown as Record<string, unknown>,
    brain_feedback: feedbackSample as unknown as Record<string, unknown>,
    brain_read: readSample as unknown as Record<string, unknown>,
    brain_recall: recallSample as unknown as Record<string, unknown>,
    brain_review: receiptSample as unknown as Record<string, unknown>,
    brain_status: statusSample as unknown as Record<string, unknown>
  };
  for (const definition of toolDefinitions) {
    const schema = definition.outputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
      oneOf?: unknown[];
    };
    if (definition.name === 'brain_review') {
      expect(schema.oneOf).toHaveLength(2);
      continue;
    }
    const sample = samples[definition.name];
    for (const required of schema.required ?? []) {
      expect(sample, `${definition.name} is missing ${required}`).toHaveProperty(required);
    }
    for (const field of Object.keys(sample)) {
      expect(schema.properties?.[field], `${definition.name}.${field} is not published`).toBeDefined();
    }
  }
  const reviewItem = (byName().brain_review.outputSchema as { oneOf: unknown[] }).oneOf[1] as {
    required?: string[];
  };
  expect(reviewItem.required).toContain('items');
  expect(reviewListSample.items).toHaveLength(1);
});

test('the published tool contract is pinned', () => {
  const contract = toolDefinitions.map((definition) => ({
    name: definition.name,
    input: digest(definition.inputSchema),
    output: digest(definition.outputSchema)
  }));
  expect(contract).toMatchInlineSnapshot(`
    [
      {
        "input": "ce62bc381c1f6a8fb292f2dc07ff1d546e3d25e6883cc32025e37793dd4f74bb",
        "name": "brain_capture",
        "output": "dc958acd644403bdc22f902b313d6d16640e38f6a8d4f0a5bf57eef1d2a15043",
      },
      {
        "input": "344e4a1cfa3091868abfbcebf5c57603a3977498e94f509eb26ef170cefd0eab",
        "name": "brain_feedback",
        "output": "0db1da61ddcc5a1c8600781e90507114dbc22afc41437edea448d32dbe1924d5",
      },
      {
        "input": "847f7e5740dc8c25781651c7469f6c73029266518cba02da3ccb15223b232026",
        "name": "brain_read",
        "output": "9be233d055cc7a4b8911f780188c2a06e24178929005730793ca1ad19ecfa7f1",
      },
      {
        "input": "e35afbd078a9f87b92e159b9c820400a3484a18d5e90148b6c816ffce03283af",
        "name": "brain_recall",
        "output": "011604281ab18429687866c85b1572b1d6a562eeaae3ce20ac24355664cebccc",
      },
      {
        "input": "30c3da0ec30313b994130f06eab4be0d2cbefb07fa30bd4a61088b672b568bc8",
        "name": "brain_review",
        "output": "60d762fba468702212a631676552e6f935ac16a8388d451433778457c53d1b73",
      },
      {
        "input": "30dee43261cae830a7ada8821f20d78e4dfb002fc0df30205749ed54295b0e4f",
        "name": "brain_status",
        "output": "a65ec18ce12a9088a323d34dfb14ccbbbeee72538a64eb1826de5ce823893b85",
      },
    ]
  `);
});

test('representative tool schemas are pinned in full', () => {
  const tools = byName();
  expect(tools.brain_recall.inputSchema).toMatchInlineSnapshot(`
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "additionalProperties": false,
      "properties": {
        "allow_text_fallback": {
          "type": "boolean",
        },
        "budget_tokens": {
          "maximum": 4000,
          "minimum": 256,
          "type": "integer",
        },
        "include_candidates": {
          "type": "boolean",
        },
        "include_shared": {
          "type": "boolean",
        },
        "kinds": {
          "items": {
            "enum": [
              "lesson",
              "decision",
              "playbook",
              "fact",
              "preference",
              "session",
              "note",
            ],
            "type": "string",
          },
          "maxItems": 7,
          "type": "array",
        },
        "limit": {
          "maximum": 12,
          "minimum": 1,
          "type": "integer",
        },
        "mode": {
          "enum": [
            "hybrid",
            "text",
          ],
          "type": "string",
        },
        "phase": {
          "enum": [
            "general",
            "brainstorming",
            "planning",
            "debugging",
            "implementation",
            "review",
            "handoff",
          ],
          "type": "string",
        },
        "query": {
          "maxLength": 8000,
          "minLength": 1,
          "type": "string",
        },
        "scope": {
          "pattern": "^[a-z][a-z0-9-]{0,63}$",
          "type": "string",
        },
        "session_id": {
          "maxLength": 8000,
          "minLength": 1,
          "type": "string",
        },
        "topics": {
          "items": {
            "maxLength": 8000,
            "minLength": 1,
            "type": "string",
          },
          "maxItems": 32,
          "type": "array",
        },
      },
      "required": [
        "scope",
        "query",
      ],
      "type": "object",
    }
  `);
  expect(tools.brain_status.outputSchema).toMatchInlineSnapshot(`
    {
      "additionalProperties": false,
      "properties": {
        "health": {
          "additionalProperties": false,
          "properties": {
            "backend": {
              "enum": [
                "ready",
                "unavailable",
              ],
              "type": "string",
            },
            "embeddings": {
              "enum": [
                "ready",
                "unavailable",
                "unknown",
              ],
              "type": "string",
            },
            "gateway": {
              "enum": [
                "ready",
                "recovering",
                "degraded",
              ],
              "type": "string",
            },
          },
          "required": [
            "gateway",
            "backend",
            "embeddings",
          ],
          "type": "object",
        },
        "operation": {
          "additionalProperties": false,
          "properties": {
            "etag": {
              "pattern": "^[a-f0-9]{64}$",
              "type": "string",
            },
            "id": {
              "format": "uuid",
              "type": "string",
            },
            "indexed": {
              "type": "boolean",
            },
            "materialized": {
              "type": "boolean",
            },
            "operation_id": {
              "format": "uuid",
              "type": "string",
            },
            "outcome": {
              "enum": [
                "stored",
                "stored_conflict",
                "pending",
              ],
              "type": "string",
            },
            "possible_duplicates": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "etag": {
                    "pattern": "^[a-f0-9]{64}$",
                    "type": "string",
                  },
                  "id": {
                    "format": "uuid",
                    "type": "string",
                  },
                  "kind": {
                    "enum": [
                      "lesson",
                      "decision",
                      "playbook",
                      "fact",
                      "preference",
                      "session",
                      "note",
                    ],
                    "type": "string",
                  },
                  "relative_path": {
                    "type": "string",
                  },
                  "revision_id": {
                    "format": "uuid",
                    "type": "string",
                  },
                  "scope": {
                    "pattern": "^[a-z][a-z0-9-]{0,63}$",
                    "type": "string",
                  },
                  "status": {
                    "enum": [
                      "candidate",
                      "active",
                      "superseded",
                      "archived",
                    ],
                    "type": "string",
                  },
                  "title": {
                    "type": "string",
                  },
                  "warnings": {
                    "items": {
                      "type": "string",
                    },
                    "type": "array",
                  },
                },
                "required": [
                  "id",
                  "revision_id",
                  "scope",
                  "title",
                  "kind",
                  "status",
                  "etag",
                  "relative_path",
                  "warnings",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "revision_id": {
              "format": "uuid",
              "type": "string",
            },
            "warnings": {
              "items": {
                "type": "string",
              },
              "type": "array",
            },
          },
          "required": [
            "operation_id",
            "id",
            "revision_id",
            "outcome",
            "materialized",
            "indexed",
            "possible_duplicates",
            "warnings",
          ],
          "type": "object",
        },
        "pending_operations": {
          "type": "number",
        },
        "protocol_version": {
          "const": "2025-11-25",
          "type": "string",
        },
        "schema_version": {
          "const": 1,
          "type": "number",
        },
        "schemas": {
          "type": "object",
        },
        "scopes": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "can_review": {
                "type": "boolean",
              },
              "can_write": {
                "type": "boolean",
              },
              "id": {
                "pattern": "^[a-z][a-z0-9-]{0,63}$",
                "type": "string",
              },
            },
            "required": [
              "id",
              "can_write",
              "can_review",
            ],
            "type": "object",
          },
          "type": "array",
        },
        "version": {
          "type": "string",
        },
      },
      "required": [
        "version",
        "protocol_version",
        "schema_version",
        "scopes",
        "health",
        "pending_operations",
      ],
      "type": "object",
    }
  `);
});

test('result_delivery defaults to structured and rejects unknown modes', () => {
  const base = {
    endpoint: 'http://127.0.0.1:7331/mcp',
    backend_endpoint: 'http://memory:8000/mcp',
    port: 7331,
    mounts: { vault: '/vault', state: '/var/lib/second-brain' },
    credentials_file: '/run/secrets/brain_credentials',
    allowed_hosts: ['127.0.0.1:7331'],
    scopes: [
      {
        id: 'freellmapi',
        backend_project: 'freellmapi',
        relative_root: 'freellmapi',
        repository_aliases: []
      }
    ]
  };
  expect(brainConfigSchema.parse(base).result_delivery).toBe('structured');
  expect(brainConfigSchema.parse({ ...base, result_delivery: 'text-json' }).result_delivery).toBe(
    'text-json'
  );
  expect(brainConfigSchema.safeParse({ ...base, result_delivery: 'pointer' }).success).toBe(false);
});

test('structured delivery keeps the pointer compact and the payload structured', () => {
  const call = toToolResult('brain_recall', recallSample, 'structured');
  expect(call.isError).toBeUndefined();
  expect(call.structuredContent).toEqual(recallSample);
  expect(call.content).toHaveLength(1);
  const text = call.content[0].text;
  expect(JSON.parse(text)).toMatchInlineSnapshot(`
    {
      "delivery": "structured",
      "note": "The complete result is in structuredContent; set result_delivery: text-json for a client that cannot read structured content.",
      "summary": {
        "budget": {
          "limit": 1500,
          "tokenizer": "cl100k_base",
          "used": 120,
        },
        "items": 1,
        "mode": "hybrid",
        "partial": false,
        "retrieval_id": "11111111-1111-4111-8111-111111111111",
      },
      "tool": "brain_recall",
    }
  `);
  expect(text).toContain('structuredContent');
  expect(text).toContain('text-json');
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(
    Buffer.byteLength(JSON.stringify(recallSample), 'utf8')
  );
  expect(Buffer.byteLength(JSON.stringify(call), 'utf8')).toBeLessThan(TOOL_RESULT_MAX_BYTES);
});

test('text-json delivery sends the complete result once in text', () => {
  const call = toToolResult('brain_read', readSample, 'text-json');
  expect(call.content[0].text).toBe(JSON.stringify(readSample));
  expect(JSON.parse(call.content[0].text)).toEqual(readSample);
  expect(call.structuredContent).toEqual(readSample);
});

test('failures use isError, stable codes, retryability, and a sanitized message', () => {
  const call = toToolError(
    new BrainError({
      code: 'BACKEND_UNAVAILABLE',
      message: 'the backend at /run/secrets/brain_credentials is unavailable',
      operation_id: fixtureIds.revision
    })
  );
  expect(call.isError).toBe(true);
  const payload = JSON.parse(call.content[0].text).error;
  expect(payload).toEqual({
    code: 'BACKEND_UNAVAILABLE',
    message: 'the backend at [path] is unavailable',
    retryable: true,
    operation_id: fixtureIds.revision
  });
  expect(call.content[0].text).not.toContain('/run/secrets');
  expect(call.content[0].text).not.toContain('backend at /');
});

test('unknown failures expose no stack trace and no secret path', () => {
  const error = new Error('the journal at /var/lib/second-brain/journal.db is locked');
  error.stack = `Error: ${error.message}\n    at /srv/app/src/storage/journal.ts:10:5`;
  const call = toToolError(error);
  const payload = JSON.parse(call.content[0].text).error;
  expect(payload.code).toBe('INTERNAL_ERROR');
  expect(payload.retryable).toBe(false);
  expect(call.content[0].text).not.toContain('/var/lib');
  expect(call.content[0].text).not.toContain('/srv/app');
  expect(call.content[0].text).not.toContain('at /');
  expect(sanitizeDiagnostic('see /a/b/c')).toBe('see [path]');
  expect(toToolError(undefined).content[0].text).toContain('INTERNAL_ERROR');
});

test('status reports authorization-filtered scopes for each principal', async () => {
  const harness = await createHarness();
  try {
    const worker = await status(workerContext, {}, harness.deps);
    expect(worker.scopes).toEqual([
      { id: 'freellmapi', can_write: true, can_review: false },
      { id: 'shared', can_write: false, can_review: false }
    ]);
    const owner = await status(ownerContext, {}, harness.deps);
    expect(owner.scopes).toEqual([
      { id: 'freellmapi', can_write: true, can_review: true },
      { id: 'shared', can_write: true, can_review: true },
      { id: 'profile', can_write: true, can_review: true }
    ]);
    const reviewer = await status(reviewerContext, {}, harness.deps);
    expect(reviewer.scopes).toContainEqual({ id: 'freellmapi', can_write: true, can_review: true });
  } finally {
    await harness.close();
  }
});

test('status publishes version metadata and exposes schemas only on request', async () => {
  const harness = await createHarness();
  try {
    const result = await status(workerContext, {}, harness.deps);
    expect(result.version).toBe(APPLICATION_VERSION);
    expect(result.version).toBe(
      (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
    );
    expect(result.protocol_version).toBe(PROTOCOL_VERSION);
    expect(result.protocol_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.schema_version).toBe(SCHEMA_VERSION);
    expect(result.schema_version).toBe(1);
    expect(result.schemas).toBeUndefined();

    const explicit = await status(workerContext, { include_schemas: true }, harness.deps);
    expect(Object.keys(explicit.schemas ?? {}).sort()).toEqual([...TOOL_NAMES].sort());
    expect(Buffer.byteLength(JSON.stringify(explicit.schemas), 'utf8')).toBeLessThan(
      TOOL_RESULT_MAX_BYTES
    );
    expect(JSON.stringify(explicit.schemas)).not.toContain('credentials');
  } finally {
    await harness.close();
  }
});

test('status narrows to an authorized requested scope and rejects an unauthorized one', async () => {
  const harness = await createHarness();
  try {
    const narrowed = await status(workerContext, { scope: 'freellmapi' }, harness.deps);
    expect(narrowed.scopes.map((scope) => scope.id)).toEqual(['freellmapi']);
    await expect(status(workerContext, { scope: 'profile' }, harness.deps)).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
  } finally {
    await harness.close();
  }
});

test('status counts only pending operations inside readable scopes', async () => {
  const harness = await createHarness();
  try {
    harness.deps.journal.reserve({
      principal_id: ownerPrincipal.id,
      idempotency_key: key(1),
      tool: 'brain_capture',
      scope: 'profile',
      payload_hash: 'b'.repeat(64),
      payload_json: '{}'
    });
    expect((await status(ownerContext, {}, harness.deps)).pending_operations).toBe(1);
    expect((await status(workerContext, {}, harness.deps)).pending_operations).toBe(0);
  } finally {
    await harness.close();
  }
});

test('status returns an operation only to its submitter or an allowed owner', async () => {
  const harness = await createHarness();
  try {
    const receipt = await capture(
      workerContext,
      { idempotency_key: key(2), scope: 'freellmapi', note: lessonFixture },
      harness.deps
    );
    const mine = await status(workerContext, { operation_id: receipt.operation_id }, harness.deps);
    expect(mine.operation).toMatchObject({
      operation_id: receipt.operation_id,
      id: receipt.id,
      revision_id: receipt.revision_id,
      outcome: 'stored'
    });
    const owner = await status(ownerContext, { operation_id: receipt.operation_id }, harness.deps);
    expect(owner.operation?.revision_id).toBe(receipt.revision_id);

    const denied = await status(
      reviewerContext,
      { operation_id: receipt.operation_id },
      harness.deps
    ).catch((error: unknown) => error as BrainError);
    expect(denied).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(denied)).not.toContain(receipt.revision_id);
    await expect(
      status(reviewerContext, { operation_id: fixtureIds.revision }, harness.deps)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await harness.close();
  }
});

test('status reports a pending owned operation and a recovering gateway', async () => {
  const harness = await createHarness();
  try {
    harness.backend.fail_once = 'before_write';
    const receipt = await capture(
      workerContext,
      { idempotency_key: key(3), scope: 'freellmapi', note: lessonFixture },
      harness.deps
    );
    expect(receipt.outcome).toBe('pending');
    const result = await status(workerContext, { operation_id: receipt.operation_id }, harness.deps);
    expect(result.operation?.outcome).toBe('pending');
    expect(result.operation?.materialized).toBe(false);
    expect(result.pending_operations).toBe(1);
    expect(result.health.gateway).toBe('recovering');
  } finally {
    await harness.close();
  }
});

test('status degrades instead of failing when the backend is down', async () => {
  const harness = await createHarness();
  try {
    await harness.backend.close();
    const result = await status(workerContext, {}, harness.deps);
    expect(result.health).toEqual({
      gateway: 'degraded',
      backend: 'unavailable',
      embeddings: 'unknown'
    });
    expect(result.scopes.length).toBeGreaterThan(0);
  } finally {
    await harness.close();
  }
});

test('status rejects malformed input with a stable code', async () => {
  const harness = await createHarness();
  try {
    await expect(
      status(workerContext, { operation_id: 'not-a-uuid' } as unknown as Record<string, never>, harness.deps)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally {
    await harness.close();
  }
});
