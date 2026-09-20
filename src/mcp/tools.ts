import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ResultDelivery } from '../config/schema.js';
import { BrainError, isBrainError } from '../contracts/errors.js';
import {
  captureRequestSchema,
  feedbackRequestSchema,
  readRequestSchema,
  recallRequestSchema,
  reviewRequestSchema,
  statusRequestSchema
} from '../contracts/protocol.js';
import { TOOL_RESULT_MAX_BYTES } from '../core/limits.js';
import { LIFECYCLES, NOTE_KINDS } from '../core/types.js';
import { redactString } from '../security/redact.js';

export const APPLICATION_NAME = 'second-brain';
export const APPLICATION_VERSION = '0.1.0';
export const PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;
export const SCHEMA_VERSION = 1;
export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

export const TOOL_NAMES = [
  'brain_capture',
  'brain_feedback',
  'brain_read',
  'brain_recall',
  'brain_review',
  'brain_status'
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

export interface ToolTextContent {
  type: 'text';
  text: string;
}

export interface ToolCallResult {
  content: ToolTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  operation_id?: string;
}

export const requestSchemas = {
  brain_capture: captureRequestSchema,
  brain_feedback: feedbackRequestSchema,
  brain_read: readRequestSchema,
  brain_recall: recallRequestSchema,
  brain_review: reviewRequestSchema,
  brain_status: statusRequestSchema
} as const satisfies Record<ToolName, z.ZodType>;

const STRING = { type: 'string' } as const;
const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;
const SCOPE = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } as const;
const UUID = { type: 'string', format: 'uuid' } as const;
const ETAG = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;

const sourceRefSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'revision_id',
    'scope',
    'title',
    'kind',
    'status',
    'etag',
    'relative_path',
    'warnings'
  ],
  properties: {
    id: UUID,
    revision_id: UUID,
    scope: SCOPE,
    title: STRING,
    kind: { type: 'string', enum: [...NOTE_KINDS] },
    status: { type: 'string', enum: [...LIFECYCLES] },
    etag: ETAG,
    relative_path: STRING,
    warnings: STRING_ARRAY
  }
};

const recallItemSchema: Record<string, unknown> = {
  ...sourceRefSchema,
  required: [...(sourceRefSchema.required as string[]), 'excerpt', 'reasons'],
  properties: {
    ...(sourceRefSchema.properties as Record<string, unknown>),
    excerpt: STRING,
    reasons: STRING_ARRAY
  }
};

const mutationReceiptSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'operation_id',
    'id',
    'revision_id',
    'outcome',
    'materialized',
    'indexed',
    'possible_duplicates',
    'warnings'
  ],
  properties: {
    operation_id: UUID,
    id: UUID,
    revision_id: UUID,
    outcome: { type: 'string', enum: ['stored', 'stored_conflict', 'pending'] },
    materialized: { type: 'boolean' },
    indexed: { type: 'boolean' },
    etag: ETAG,
    possible_duplicates: { type: 'array', items: sourceRefSchema },
    warnings: STRING_ARRAY
  }
};

const reviewListResultSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', items: sourceRefSchema },
    next_cursor: STRING
  }
};

const readResultSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'markdown'],
  properties: {
    source: sourceRefSchema,
    markdown: STRING,
    next_cursor: STRING
  }
};

const recallResultSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['retrieval_id', 'mode', 'partial', 'warnings', 'budget', 'items'],
  properties: {
    retrieval_id: UUID,
    mode: { type: 'string', enum: ['hybrid', 'text'] },
    partial: { type: 'boolean' },
    warnings: STRING_ARRAY,
    budget: {
      type: 'object',
      additionalProperties: false,
      required: ['tokenizer', 'used', 'limit'],
      properties: {
        tokenizer: { type: 'string', const: 'cl100k_base' },
        used: { type: 'number' },
        limit: { type: 'number' }
      }
    },
    items: { type: 'array', items: recallItemSchema }
  }
};

const feedbackResultSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['feedback_id', 'recorded'],
  properties: {
    feedback_id: UUID,
    recorded: { type: 'boolean', const: true }
  }
};

const statusResultSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'protocol_version',
    'schema_version',
    'scopes',
    'health',
    'pending_operations'
  ],
  properties: {
    version: STRING,
    protocol_version: { type: 'string', const: PROTOCOL_VERSION },
    schema_version: { type: 'number', const: SCHEMA_VERSION },
    scopes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'can_write', 'can_review'],
        properties: {
          id: SCOPE,
          can_write: { type: 'boolean' },
          can_review: { type: 'boolean' }
        }
      }
    },
    health: {
      type: 'object',
      additionalProperties: false,
      required: ['gateway', 'backend', 'embeddings'],
      properties: {
        gateway: { type: 'string', enum: ['ready', 'recovering', 'degraded'] },
        backend: { type: 'string', enum: ['ready', 'unavailable'] },
        embeddings: { type: 'string', enum: ['ready', 'unavailable', 'unknown'] }
      }
    },
    pending_operations: { type: 'number' },
    operation: mutationReceiptSchema,
    schemas: { type: 'object' }
  }
};

const OUTPUT_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  brain_capture: mutationReceiptSchema,
  brain_feedback: feedbackResultSchema,
  brain_read: readResultSchema,
  brain_recall: recallResultSchema,
  brain_review: { oneOf: [mutationReceiptSchema, reviewListResultSchema] },
  brain_status: statusResultSchema
};

const DESCRIPTIONS: Record<ToolName, string> = {
  brain_capture:
    'Capture one structured, typed memory candidate with evidence and an idempotency key. Creates a candidate, never an established fact.',
  brain_feedback:
    'Record useful, irrelevant, stale, incorrect, or contradictory feedback on one specific note revision.',
  brain_read:
    'Read the current revision or an explicit historical revision of one authorized note with bounded pagination and an etag.',
  brain_recall:
    'Recall bounded, source-linked reference memory for a task in an explicitly authorized scope.',
  brain_review:
    'List candidate or conflicted notes for review, or approve, revise, supersede, archive, or resolve one under the configured review permission. Listing is read-only; the mutation actions change lifecycle state.',
  brain_status:
    'Report version metadata, authorization-filtered scopes, backend health, pending work, and one authorized operation state.'
};

const ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  brain_capture: {
    title: 'Capture a typed memory candidate',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  brain_feedback: {
    title: 'Record memory feedback',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  brain_read: {
    title: 'Read a memory note',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  brain_recall: {
    title: 'Recall scoped memory',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  brain_review: {
    title: 'Review memory lifecycle',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  },
  brain_status: {
    title: 'Report gateway status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
};

export const toolDefinitions: readonly ToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: z.toJSONSchema(requestSchemas[name]) as Record<string, unknown>,
  outputSchema: OUTPUT_SCHEMAS[name],
  annotations: ANNOTATIONS[name]
}));

const POINTER_NOTE =
  'The complete result is in structuredContent; set result_delivery: text-json for a client that cannot read structured content.';

const POINTER_FIELDS = [
  'retrieval_id',
  'mode',
  'partial',
  'operation_id',
  'id',
  'revision_id',
  'outcome',
  'materialized',
  'indexed',
  'feedback_id',
  'recorded',
  'next_cursor',
  'version',
  'protocol_version',
  'schema_version',
  'pending_operations'
] as const;

const DIAGNOSTIC_MAX_LENGTH = 400;
const ABSOLUTE_PATH_PATTERN = /\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*/g;

export function sanitizeDiagnostic(message: string): string {
  const redacted = redactString(message).replace(ABSOLUTE_PATH_PATTERN, '[path]');
  const collapsed = redacted.replace(/\s+/g, ' ').trim();
  return collapsed.length > DIAGNOSTIC_MAX_LENGTH
    ? `${collapsed.slice(0, DIAGNOSTIC_MAX_LENGTH)}...`
    : collapsed;
}

function pointerFor(tool: ToolName, result: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const field of POINTER_FIELDS) {
    if (field in result) summary[field] = result[field];
  }
  if (Array.isArray(result.items)) summary.items = result.items.length;
  if (Array.isArray(result.scopes)) summary.scopes = result.scopes.length;
  if (result.budget !== null && typeof result.budget === 'object') summary.budget = result.budget;
  if (result.health !== null && typeof result.health === 'object') summary.health = result.health;
  if (typeof result.markdown === 'string') summary.markdown_chars = result.markdown.length;
  return { tool, delivery: 'structured', summary, note: POINTER_NOTE };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPayloadWithinLimit(label: string, bytes: number): void {
  if (bytes > TOOL_RESULT_MAX_BYTES) {
    throw new BrainError({
      code: 'LIMIT_EXCEEDED',
      message: `the ${label} tool result exceeds the hard payload limit`
    });
  }
}

export function toToolResult(
  tool: ToolName,
  result: unknown,
  delivery: ResultDelivery
): ToolCallResult {
  if (!isRecord(result)) {
    throw new Error('the tool result is not a structured object');
  }
  const structuredContent = result;
  const text =
    delivery === 'text-json' ? JSON.stringify(result) : JSON.stringify(pointerFor(tool, result));
  assertPayloadWithinLimit(`${tool} text`, Buffer.byteLength(text, 'utf8'));
  assertPayloadWithinLimit(
    `${tool} structured`,
    Buffer.byteLength(JSON.stringify(structuredContent), 'utf8')
  );
  return { content: [{ type: 'text', text }], structuredContent };
}

export function errorPayload(error: unknown): ToolErrorPayload {
  if (isBrainError(error)) {
    const prefix = `${error.code}: `;
    const raw = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
    const payload: ToolErrorPayload = {
      code: error.code,
      message: sanitizeDiagnostic(raw) || 'the gateway rejected the request',
      retryable: error.retryable
    };
    if (error.operation_id !== undefined) payload.operation_id = error.operation_id;
    return payload;
  }
  if (error instanceof Error) {
    const message = sanitizeDiagnostic(error.message);
    return {
      code: INTERNAL_ERROR_CODE,
      message: message.length > 0 ? message : 'the gateway could not complete the request',
      retryable: false
    };
  }
  return {
    code: INTERNAL_ERROR_CODE,
    message: 'the gateway could not complete the request',
    retryable: false
  };
}

export function toToolError(error: unknown): ToolCallResult {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: payload }) }],
    structuredContent: { error: payload }
  };
}
