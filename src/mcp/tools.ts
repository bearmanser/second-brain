import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ResultDelivery } from '../config/schema.js';
import { BrainError, isBrainError } from '../contracts/errors.js';
import {
  captureRequestSchema,
  captureRequestSchemaV2,
  feedbackRequestSchema,
  projectEnsureRequestSchema,
  readRequestSchema,
  recallRequestSchema,
  reviewRequestSchema,
  reviewRequestSchemaV2,
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
export const INTERNAL_ERROR_MESSAGE = 'the gateway could not complete the request';

export const TOOL_NAMES = [
  'brain_capture',
  'brain_feedback',
  'brain_project_ensure',
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
  brain_capture: captureRequestSchemaV2,
  brain_feedback: feedbackRequestSchema,
  brain_project_ensure: projectEnsureRequestSchema,
  brain_read: readRequestSchema,
  brain_recall: recallRequestSchema,
  brain_review: reviewRequestSchemaV2,
  brain_status: statusRequestSchema
} as const satisfies Record<ToolName, z.ZodType>;

export const legacyRequestSchemas = {
  ...requestSchemas,
  brain_capture: captureRequestSchema,
  brain_review: reviewRequestSchema
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
    'scope',
    'title',
    'kind',
    'status',
    'etag',
    'relative_path',
    'warnings'
  ],
  properties: {
    id: STRING,
    revision_id: STRING,
    scope: STRING,
    title: STRING,
    kind: { type: 'string', enum: [...NOTE_KINDS] },
    status: { type: 'string', enum: [...LIFECYCLES] },
    etag: ETAG,
    relative_path: STRING,
    heading: { type: ['string', 'null'] },
    start_line: { type: 'number' },
    end_line: { type: 'number' },
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
    mode: { type: 'string', enum: ['text', 'reranked', 'hybrid'] },
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

const feedbackReceiptSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'operation_id', 'feedback_id', 'recorded'],
  properties: {
    kind: { type: 'string', const: 'feedback' },
    operation_id: UUID,
    feedback_id: UUID,
    recorded: { type: 'boolean', const: true }
  }
};

const projectEnsureResultSchemaV2: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'operation_id',
    'repository_identity',
    'project_id',
    'relative_root',
    'created',
    'materialized',
    'warnings'
  ],
  properties: {
    operation_id: UUID,
    repository_identity: STRING,
    project_id: STRING,
    relative_root: STRING,
    created: { type: 'boolean' },
    materialized: { type: 'boolean' },
    warnings: STRING_ARRAY
  }
};

const statusResultSchemaV2: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'protocol_version',
    'schema_version',
    'protocol',
    'projects',
    'health',
    'features',
    'pending_operations'
  ],
  properties: {
    version: STRING,
    protocol_version: { type: 'string' },
    schema_version: { type: 'number', const: SCHEMA_VERSION },
    protocol: { type: 'number', const: 2 },
    health: {
      type: 'object',
      additionalProperties: false,
      required: ['gateway', 'index', 'worker'],
      properties: {
        gateway: { type: 'string', enum: ['ready', 'recovering', 'degraded'] },
        index: { type: 'string', enum: ['ready', 'unavailable'] },
        worker: { type: 'string', enum: ['ready', 'disabled', 'unavailable'] },
        pending_index: { type: 'number' },
        rss_bytes: { type: 'number' },
        worker_rss_bytes: { type: 'number' }
      }
    },
    features: {
      type: 'object',
      additionalProperties: false,
      required: ['reranking', 'text_search', 'fallback'],
      properties: {
        reranking: { type: 'boolean' },
        text_search: { type: 'boolean' },
        fallback: { type: 'boolean' }
      }
    },
    pending_operations: { type: 'number' },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'display_name', 'relative_root', 'state'],
        properties: {
          id: STRING,
          state: { type: 'string', enum: ['provisioning', 'ready', 'recovery_required'] },
          display_name: STRING,
          relative_root: STRING
        }
      }
    },
    operation: { oneOf: [mutationReceiptSchema, projectEnsureResultSchemaV2, feedbackReceiptSchema] },
    schemas: { type: 'object' }
  }
};

const projectEnsureResultSchemaV1: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['operation_id', 'repository_identity', 'scope', 'created', 'backend_ready', 'materialized', 'warnings'],
  properties: {
    operation_id: UUID,
    repository_identity: STRING,
    scope: SCOPE,
    project_id: STRING,
    relative_root: STRING,
    created: { type: 'boolean' },
    backend_ready: { type: 'boolean' },
    materialized: { type: 'boolean' },
    warnings: STRING_ARRAY
  }
};

const statusResultSchemaV1: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'protocol_version', 'schema_version', 'scopes', 'health', 'pending_operations'],
  properties: {
    version: STRING,
    protocol_version: STRING,
    schema_version: { type: 'number', const: SCHEMA_VERSION },
    protocol: { type: 'number', const: 2 },
    scopes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: SCOPE } }
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
    local: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: {
          type: 'object', additionalProperties: false,
          properties: { state: { type: 'string', enum: ['ready', 'unavailable'] }, documents: { type: 'number' } }
        },
        worker: {
          type: 'object', additionalProperties: false,
          properties: { state: STRING, model_fingerprint: STRING }
        },
        memory: {
          type: 'object', additionalProperties: false,
          properties: { container_rss_bytes: { type: 'number' }, worker_rss_bytes: { type: 'number' } }
        }
      }
    },
    features: {
      type: 'object', additionalProperties: false,
      properties: { reranking: { type: 'boolean' }, text_search: { type: 'boolean' }, fallback: { type: 'boolean' } }
    },
    pending_operations: { type: 'number' },
    projects: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['scope', 'state'],
        properties: { scope: SCOPE, state: { type: 'string', enum: ['provisioning', 'ready', 'recovery_required'] }, display_name: STRING, relative_root: STRING }
      }
    },
    operation: { oneOf: [mutationReceiptSchema, projectEnsureResultSchemaV1] },
    schemas: { type: 'object' }
  }
};

const OUTPUT_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  brain_capture: mutationReceiptSchema,
  brain_feedback: feedbackResultSchema,
  brain_project_ensure: projectEnsureResultSchemaV2,
  brain_read: readResultSchema,
  brain_recall: recallResultSchema,
  brain_review: { oneOf: [mutationReceiptSchema, reviewListResultSchema] },
  brain_status: statusResultSchemaV2
};

const LEGACY_OUTPUT_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  ...OUTPUT_SCHEMAS,
  brain_project_ensure: projectEnsureResultSchemaV1,
  brain_status: statusResultSchemaV1
};

const DESCRIPTIONS: Record<ToolName, string> = {
  brain_capture:
    'Capture one structured, typed memory candidate with evidence and an idempotency key. Creates a candidate, never an established fact.',
  brain_feedback:
    'Record useful, irrelevant, stale, incorrect, or contradictory feedback on one specific note revision.',
  brain_project_ensure:
    'Idempotently provision or reuse the project for one canonical Git repository remote.',
  brain_read:
    'Read the current note by id, path, or unambiguous title, or one historical revision by managed id, with bounded pagination.',
  brain_recall:
    'Recall bounded, source-linked reference memory for a task across the whole brain or within an explicit project.',
  brain_review:
    'List candidate or conflicted notes for review, or approve, revise, supersede, archive, resolve, move, or adopt one. Listing is read-only; the mutation actions change lifecycle state.',
  brain_status:
    'Report protocol and schema version, local index and worker health, pending work, projects, and supported features.'
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
  brain_project_ensure: {
    title: 'Ensure repository project memory',
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

export const legacyToolDefinitions: readonly ToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: z.toJSONSchema(legacyRequestSchemas[name]) as Record<string, unknown>,
  outputSchema: LEGACY_OUTPUT_SCHEMAS[name],
  annotations: ANNOTATIONS[name]
}));

const POINTER_NOTE =
  'The complete result is in structuredContent; set result_delivery: text-json for a client that cannot read structured content.';
const READ_POINTER_NOTE = 'Complete result: structuredContent.';

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

export function pointerFor(tool: ToolName, result: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const field of POINTER_FIELDS) {
    if (field === 'next_cursor' && field in result) summary[field] = true;
    else if (field in result) summary[field] = result[field];
  }
  if (Array.isArray(result.items)) summary.items = result.items.length;
  if (Array.isArray(result.scopes)) summary.scopes = result.scopes.length;
  if (result.budget !== null && typeof result.budget === 'object') summary.budget = result.budget;
  if (result.health !== null && typeof result.health === 'object') summary.health = result.health;
  if (typeof result.markdown === 'string') summary.markdown_chars = result.markdown.length;
  return {
    tool,
    delivery: 'structured',
    ...(tool === 'brain_read' ? {} : { summary }),
    note: tool === 'brain_read' ? READ_POINTER_NOTE : POINTER_NOTE
  };
}

export function modelVisibleRepresentation(
  tool: ToolName,
  result: Record<string, unknown>,
  delivery: ResultDelivery
): string {
  const structured = JSON.stringify(result);
  return delivery === 'text-json'
    ? structured
    : `${structured}\n${JSON.stringify(pointerFor(tool, result))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transmittedBytes(result: ToolCallResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}

export function toolResultByteLength(
  tool: ToolName,
  result: Record<string, unknown>,
  delivery: ResultDelivery
): number {
  const text =
    delivery === 'text-json' ? JSON.stringify(result) : JSON.stringify(pointerFor(tool, result));
  return transmittedBytes({ content: [{ type: 'text', text }], structuredContent: result });
}

export function toToolResult(
  tool: ToolName,
  result: unknown,
  delivery: ResultDelivery
): ToolCallResult {
  if (!isRecord(result)) {
    throw new Error('the tool result is not a structured object');
  }
  const text =
    delivery === 'text-json' ? JSON.stringify(result) : JSON.stringify(pointerFor(tool, result));
  const call: ToolCallResult = { content: [{ type: 'text', text }], structuredContent: result };
  if (toolResultByteLength(tool, result, delivery) > TOOL_RESULT_MAX_BYTES) {
    throw new BrainError({
      code: 'LIMIT_EXCEEDED',
      message: `the ${tool} result exceeds the ${TOOL_RESULT_MAX_BYTES} byte MCP payload limit`
    });
  }
  return call;
}

export function internalDiagnostic(error: unknown): string {
  if (error instanceof Error) return sanitizeDiagnostic(error.message);
  return sanitizeDiagnostic(typeof error === 'string' ? error : String(error));
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
  return {
    code: INTERNAL_ERROR_CODE,
    message: INTERNAL_ERROR_MESSAGE,
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
