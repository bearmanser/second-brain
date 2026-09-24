import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { BrainError, BRAIN_ERROR_CODES } from '../../src/contracts/errors.js';
import { brainConfigSchema } from '../../src/config/schema.js';
import {
  captureRequestSchema,
  feedbackRequestSchema,
  readRequestSchema,
  recallRequestSchema,
  projectEnsureRequestSchema,
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
  StatusResult,
  ProjectEnsureResult
} from '../../src/core/types.js';
import { SYSTEM_ACTOR } from '../../src/core/types.js';
import { capture } from '../../src/features/capture.js';
import { status } from '../../src/features/status.js';
import { buildInstructions } from '../../src/mcp/instructions.js';
import {
  APPLICATION_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  internalDiagnostic,
  sanitizeDiagnostic,
  toToolError,
  toToolResult,
  toolDefinitions
} from '../../src/mcp/tools.js';
import type { ToolCallResult, ToolName } from '../../src/mcp/tools.js';
import type { ResultDelivery } from '../../src/config/schema.js';
import { fixtureIds, lessonFixture } from '../fixtures/content.js';
import {
  ownerContext,
  reviewerContext,
  workerContext
} from '../fixtures/principals.js';
import { createHarness } from '../support/harness.js';
import type { Journal, OperationRecord } from '../../src/storage/journal.js';

const key = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

const requestSchemas: Record<ToolName, z.ZodType> = {
  brain_capture: captureRequestSchema,
  brain_feedback: feedbackRequestSchema,
  brain_project_ensure: projectEnsureRequestSchema,
  brain_read: readRequestSchema,
  brain_recall: recallRequestSchema,
  brain_review: reviewRequestSchema,
  brain_status: statusRequestSchema
};

const TOOL_NAMES: ToolName[] = [
  'brain_capture',
  'brain_feedback',
  'brain_project_ensure',
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
  scopes: [{ id: 'freellmapi' }],
  health: { gateway: 'ready', backend: 'ready', embeddings: 'unknown' },
  pending_operations: 0
};

const projectEnsureSample: ProjectEnsureResult = {
  operation_id: fixtureIds.idempotencyKey,
  repository_identity: 'github.com/bearmanser/second-brain',
  scope: 'second-brain',
  created: true,
  backend_ready: true,
  materialized: true,
  warnings: []
};

test('exposes only the seven controlled Brain tools', () => {
  expect(toolDefinitions.map((item) => item.name).sort()).toEqual([
    'brain_capture',
    'brain_feedback',
    'brain_project_ensure',
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
  expect(tools.brain_project_ensure.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
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
    brain_project_ensure: projectEnsureSample as unknown as Record<string, unknown>,
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
        "input": "8cf96af973581c3f8fd6c954a45694b1ccf66b9de148d07299d0fef2aa1acc98",
        "name": "brain_capture",
        "output": "57fce7c09c966db809d68ffe028e91904e9938860b97d457430451f4799dccc9",
      },
      {
        "input": "2e5e0114744f0da9c5c9b683d8400d42b07a79894b90f8721fb4cd491ee4bcb5",
        "name": "brain_feedback",
        "output": "0db1da61ddcc5a1c8600781e90507114dbc22afc41437edea448d32dbe1924d5",
      },
      {
        "input": "bab96ef550ee128f67bf979e6be07349c1923bcac7051613b1ae7678b36c0e23",
        "name": "brain_project_ensure",
        "output": "6591c834431f34d8c3b17c024feeec42cd1db294e890230b80dfebff3104a0c1",
      },
      {
        "input": "78e53562be503059fd476f02cb7d4c8516e040414244e47cea64c55e4d21fdd2",
        "name": "brain_read",
        "output": "dc422311704e5104ae8b579055802d36215ab8fb8171c3ecf8d53b3c8c1f99d8",
      },
      {
        "input": "eb9847690ed4c0878ad3043b40cbf6d3fd7b09a5ff455fc917465d359fcbcf1b",
        "name": "brain_recall",
        "output": "1bba962c7fe6f748ca285b4bd573dd3c64dd299b2d6470bce14dbff9055aa0a5",
      },
      {
        "input": "de0d22351181adaa0c6469ddaa6a8813cab0bc49ff30bca7e5c30698e96e8b2a",
        "name": "brain_review",
        "output": "4296f66f5b3aedc53103bae95c5571490de8f77b13c0e484461f168059f21504",
      },
      {
        "input": "b08c7c6e06ed73a354cdcd37ef9fc28a5d454f4e7a7394270bc295db8a285579",
        "name": "brain_status",
        "output": "a6189f5a3e6de53685a88144d4aec348570d045d7c173038fe0d1eb2882cbf71",
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
            "text",
            "reranked",
            "hybrid",
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
        "project": {
          "maxLength": 256,
          "minLength": 1,
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
        "query",
      ],
      "type": "object",
    }
  `);
  expect(tools.brain_status.outputSchema).toMatchInlineSnapshot(`
    {
      "additionalProperties": false,
      "properties": {
        "features": {
          "additionalProperties": false,
          "properties": {
            "fallback": {
              "type": "boolean",
            },
            "reranking": {
              "type": "boolean",
            },
            "text_search": {
              "type": "boolean",
            },
          },
          "type": "object",
        },
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
        "local": {
          "additionalProperties": false,
          "properties": {
            "index": {
              "additionalProperties": false,
              "properties": {
                "documents": {
                  "type": "number",
                },
                "state": {
                  "enum": [
                    "ready",
                    "unavailable",
                  ],
                  "type": "string",
                },
              },
              "type": "object",
            },
            "worker": {
              "additionalProperties": false,
              "properties": {
                "model_fingerprint": {
                  "type": "string",
                },
                "state": {
                  "type": "string",
                },
              },
              "type": "object",
            },
          },
          "type": "object",
        },
        "operation": {
          "oneOf": [
            {
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
                      "end_line": {
                        "type": "number",
                      },
                      "etag": {
                        "pattern": "^[a-f0-9]{64}$",
                        "type": "string",
                      },
                      "heading": {
                        "type": [
                          "string",
                          "null",
                        ],
                      },
                      "id": {
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
                        "type": "string",
                      },
                      "scope": {
                        "type": "string",
                      },
                      "start_line": {
                        "type": "number",
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
            {
              "additionalProperties": false,
              "properties": {
                "backend_ready": {
                  "type": "boolean",
                },
                "created": {
                  "type": "boolean",
                },
                "materialized": {
                  "type": "boolean",
                },
                "operation_id": {
                  "format": "uuid",
                  "type": "string",
                },
                "project_id": {
                  "type": "string",
                },
                "relative_root": {
                  "type": "string",
                },
                "repository_identity": {
                  "type": "string",
                },
                "scope": {
                  "pattern": "^[a-z][a-z0-9-]{0,63}$",
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
                "repository_identity",
                "scope",
                "created",
                "backend_ready",
                "materialized",
                "warnings",
              ],
              "type": "object",
            },
          ],
        },
        "pending_operations": {
          "type": "number",
        },
        "projects": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "display_name": {
                "type": "string",
              },
              "relative_root": {
                "type": "string",
              },
              "scope": {
                "pattern": "^[a-z][a-z0-9-]{0,63}$",
                "type": "string",
              },
              "state": {
                "enum": [
                  "provisioning",
                  "ready",
                  "recovery_required",
                ],
                "type": "string",
              },
            },
            "required": [
              "scope",
              "state",
            ],
            "type": "object",
          },
          "type": "array",
        },
        "protocol": {
          "const": 2,
          "type": "number",
        },
        "protocol_version": {
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
              "id": {
                "pattern": "^[a-z][a-z0-9-]{0,63}$",
                "type": "string",
              },
            },
            "required": [
              "id",
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

const readWith = (length: number): ReadResult => ({ source, markdown: 'x'.repeat(length) });

const transmitted = (call: ToolCallResult): number =>
  Buffer.byteLength(JSON.stringify(call), 'utf8');

function largestAccepted(
  delivery: ResultDelivery
): { length: number; call: ToolCallResult } | undefined {
  let low = 0;
  let high = TOOL_RESULT_MAX_BYTES * 2 + 8192;
  let best: { length: number; call: ToolCallResult } | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    try {
      best = { length: middle, call: toToolResult('brain_read', readWith(middle), delivery) };
      low = middle + 1;
    } catch {
      high = middle - 1;
    }
  }
  return best;
}

test('bounds the complete transmitted payload for structured delivery', () => {
  const best = largestAccepted('structured');
  expect(best).toBeDefined();
  expect(transmitted(best!.call)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
  expect(best!.call.structuredContent).toEqual(readWith(best!.length));

  const next = readWith(best!.length + 1);
  expect(Buffer.byteLength(JSON.stringify(next), 'utf8')).toBeLessThan(TOOL_RESULT_MAX_BYTES);
  expect(() => toToolResult('brain_read', next, 'structured')).toThrow(/LIMIT_EXCEEDED/);
});

test('bounds the complete transmitted payload for text-json delivery', () => {
  const best = largestAccepted('text-json');
  expect(best).toBeDefined();
  expect(transmitted(best!.call)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
  expect(best!.call.content[0].text).toBe(JSON.stringify(readWith(best!.length)));

  const next = readWith(best!.length + 1);
  expect(Buffer.byteLength(JSON.stringify(next), 'utf8')).toBeLessThan(TOOL_RESULT_MAX_BYTES);
  expect(() => toToolResult('brain_read', next, 'text-json')).toThrow(/LIMIT_EXCEEDED/);
});

test('a text-json result cannot approach twice the hard payload limit', () => {
  const oversized = readWith(TOOL_RESULT_MAX_BYTES);
  expect(() => toToolResult('brain_read', oversized, 'text-json')).toThrow(/LIMIT_EXCEEDED/);
  expect(() => toToolResult('brain_read', oversized, 'structured')).toThrow(/LIMIT_EXCEEDED/);
  const boundary = largestAccepted('text-json');
  expect(boundary!.length).toBeLessThan(TOOL_RESULT_MAX_BYTES / 2 + 4096);
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

test('unknown failures expose a fixed generic message and no internal detail', () => {
  const error = new Error('the journal at /var/lib/second-brain/journal.db is locked');
  error.stack = `Error: ${error.message}\n    at /srv/app/src/storage/journal.ts:10:5`;
  const call = toToolError(error);
  const payload = JSON.parse(call.content[0].text).error;
  expect(payload).toEqual({
    code: 'INTERNAL_ERROR',
    message: 'the gateway could not complete the request',
    retryable: false
  });
  expect(call.content[0].text).not.toContain('journal');
  expect(call.content[0].text).not.toContain('locked');
  expect(call.content[0].text).not.toContain('/var/lib');
  expect(call.content[0].text).not.toContain('/srv/app');
  expect(call.content[0].text).not.toContain('at /');
  expect(internalDiagnostic(error)).toBe('the journal at [path] is locked');
  expect(internalDiagnostic('token=sk-abcdefghijklmnopqrstuvwxyz')).not.toContain(
    'sk-abcdefghijklmnopqrstuvwxyz'
  );
  expect(sanitizeDiagnostic('see /a/b/c')).toBe('see [path]');
  expect(toToolError(undefined).content[0].text).toContain('INTERNAL_ERROR');
});

test('INTERNAL_ERROR is a published BrainError code producing a fixed safe result', () => {
  expect(BRAIN_ERROR_CODES).toContain('INTERNAL_ERROR');
  const internalError = new BrainError({
    code: 'INTERNAL_ERROR',
    message: 'the gateway could not complete the request'
  });
  expect(internalError.retryable).toBe(false);
  const call = toToolError(internalError);
  const payload = JSON.parse(call.content[0].text).error;
  expect(payload).toEqual({
    code: 'INTERNAL_ERROR',
    message: 'the gateway could not complete the request',
    retryable: false
  });
});

test('status lists every registered project for the single token', async () => {
  const harness = await createHarness();
  try {
    const result = await status(workerContext, {}, harness.deps);
    expect(result.scopes).toEqual([
      { id: 'freellmapi' },
      { id: 'shared' },
      { id: 'profile' }
    ]);
    expect(Object.keys(result.scopes[0])).toEqual(['id']);
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
    expect(JSON.stringify(explicit.schemas)).not.toContain('can_review');
  } finally {
    await harness.close();
  }
});

test('status narrows to a requested project and rejects an unknown one', async () => {
  const harness = await createHarness();
  try {
    const narrowed = await status(workerContext, { scope: 'freellmapi' }, harness.deps);
    expect(narrowed.scopes.map((scope) => scope.id)).toEqual(['freellmapi']);
    const profile = await status(workerContext, { scope: 'profile' }, harness.deps);
    expect(profile.scopes.map((scope) => scope.id)).toEqual(['profile']);
    await expect(status(workerContext, { project: 'unknown-project' }, harness.deps)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
  } finally {
    await harness.close();
  }
});

test('status counts every pending operation in the brain', async () => {
  const harness = await createHarness();
  try {
    harness.deps.journal.reserve({
      principal_id: SYSTEM_ACTOR.id,
      idempotency_key: key(1),
      tool: 'brain_capture',
      scope: 'profile',
      payload_hash: 'b'.repeat(64),
      payload_json: '{}'
    });
    expect((await status(ownerContext, {}, harness.deps)).pending_operations).toBe(1);
    expect((await status(workerContext, {}, harness.deps)).pending_operations).toBe(1);
  } finally {
    await harness.close();
  }
});

test('status returns an operation to any authenticated caller', async () => {
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
    const other = await status(reviewerContext, { operation_id: receipt.operation_id }, harness.deps);
    expect((other.operation as MutationReceipt | undefined)?.revision_id).toBe(receipt.revision_id);
    await expect(
      status(reviewerContext, { operation_id: fixtureIds.revision }, harness.deps)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await harness.close();
  }
});

test('status reports a pending operation and a recovering gateway', async () => {
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
    expect((result.operation as MutationReceipt | undefined)?.outcome).toBe('pending');
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

function recordWith(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    operation_id: fixtureIds.idempotencyKey,
    principal_id: SYSTEM_ACTOR.id,
    idempotency_key: key(6),
    tool: 'brain_capture',
    scope: 'freellmapi',
    payload_hash: 'a'.repeat(64),
    payload_json: '{}',
    state: 'complete',
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    ...overrides
  };
}

function planJson(
  overrides: { id?: string; revision_id?: string; operation_id?: string } = {}
): string {
  return JSON.stringify({
    revision: {
      id: overrides.id ?? fixtureIds.note,
      revision_id: overrides.revision_id ?? fixtureIds.revision,
      operation_id: overrides.operation_id ?? fixtureIds.idempotencyKey,
      parents: [],
      scope: 'freellmapi',
      status: 'candidate',
      note: lessonFixture,
      created_at: '2026-09-20T00:00:00.000Z',
      modified_at: '2026-09-20T00:00:00.000Z',
      extra_frontmatter: {},
      extra_markdown: ''
    },
    backend_project: 'freellmapi',
    directory: 'Notes',
    storage_title: lessonFixture.title,
    permalink: 'freellmapi/notes/compare',
    body: 'body',
    metadata: {}
  });
}

function planJsonWithoutOperationId(): string {
  const parsed = JSON.parse(planJson()) as { revision: Record<string, unknown> };
  delete parsed.revision.operation_id;
  return JSON.stringify(parsed);
}

test('status validates plan identity and returns the receipt when it is consistent', async () => {
  const harness = await createHarness();
  try {
    const consistent = recordWith({
      receipt_json: JSON.stringify(receiptSample),
      plan_json: planJson()
    });
    const deps = {
      ...harness.deps,
      journal: { get: () => consistent, pending: () => [], listProjects: () => [] } as unknown as Journal
    };
    const view = await status(workerContext, { operation_id: consistent.operation_id }, deps);
    expect(view.operation?.operation_id).toBe(consistent.operation_id);
    expect((view.operation as MutationReceipt | undefined)?.id).toBe(fixtureIds.note);
    expect((view.operation as MutationReceipt | undefined)?.revision_id).toBe(fixtureIds.revision);
  } finally {
    await harness.close();
  }
});

test('status rejects corrupt or inconsistent persisted records with RECOVERY_REQUIRED', async () => {
  const harness = await createHarness();
  try {
    const cases: OperationRecord[] = [
      recordWith({ receipt_json: '{not json' }),
      recordWith({ receipt_json: JSON.stringify({ ...receiptSample, outcome: 'bogus' }) }),
      recordWith({
        receipt_json: JSON.stringify({ ...receiptSample, operation_id: fixtureIds.revision })
      }),
      recordWith({
        receipt_json: JSON.stringify(receiptSample),
        plan_json: planJson({ operation_id: fixtureIds.revision })
      }),
      recordWith({
        receipt_json: JSON.stringify(receiptSample),
        plan_json: planJson({ id: fixtureIds.replacement })
      }),
      recordWith({
        receipt_json: JSON.stringify(receiptSample),
        plan_json: planJson({ revision_id: fixtureIds.replacement })
      }),
      recordWith({
        receipt_json: JSON.stringify(receiptSample),
        plan_json: planJsonWithoutOperationId()
      }),
      recordWith({ receipt_json: JSON.stringify(receiptSample), plan_json: '{bad plan' }),
      recordWith({ receipt_json: undefined, plan_json: planJson({ operation_id: fixtureIds.revision }) })
    ];
    for (const record of cases) {
      const deps = {
        ...harness.deps,
        journal: { get: () => record, pending: () => [], listProjects: () => [] } as unknown as Journal
      };
      await expect(
        status(workerContext, { operation_id: record.operation_id }, deps)
      ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    }

    const pendingPlan = recordWith({
      receipt_json: undefined,
      state: 'submitted',
      plan_json: planJson()
    });
    const deps = {
      ...harness.deps,
      journal: { get: () => pendingPlan, pending: () => [], listProjects: () => [] } as unknown as Journal
    };
    const view = await status(workerContext, { operation_id: pendingPlan.operation_id }, deps);
    expect(view.operation).toMatchObject({
      operation_id: fixtureIds.idempotencyKey,
      outcome: 'pending',
      id: fixtureIds.note,
      revision_id: fixtureIds.revision
    });
  } finally {
    await harness.close();
  }
});
