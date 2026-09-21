import { z } from 'zod';
import {
  READ_BUDGET_TOKENS_MAX,
  READ_BUDGET_TOKENS_MIN,
  RECALL_BUDGET_TOKENS_MAX,
  RECALL_BUDGET_TOKENS_MIN,
  RECALL_LIMIT_MAX
} from '../core/limits.js';
import { FEEDBACK_VERDICTS, NOTE_KINDS, PHASES, RECALL_MODES } from '../core/types.js';
import {
  cursorSchema,
  etagSchema,
  noteInputSchema,
  remoteUrlSchema,
  scopeIdSchema,
  uuidSchema,
  withinInputBodyLimit
} from './content.js';

const text = z.string().trim().min(1).max(8000);
const expectedHeadsSchema = z
  .array(z.strictObject({ revision_id: uuidSchema, etag: etagSchema }))
  .min(1)
  .max(32);

const reviewListOperation = z.strictObject({
  action: z.literal('list'),
  filter: z.enum(['candidate', 'conflict']),
  cursor: cursorSchema.optional()
});

const reviewDecisionOperation = z.strictObject({
  action: z.enum(['approve', 'archive']),
  idempotency_key: uuidSchema,
  id: uuidSchema,
  expected_etag: etagSchema,
  rationale: text
});

const reviewReviseOperation = z.strictObject({
  action: z.literal('revise'),
  idempotency_key: uuidSchema,
  id: uuidSchema,
  expected_etag: etagSchema,
  rationale: text,
  note: noteInputSchema
});

const reviewSupersedeOperation = z.strictObject({
  action: z.literal('supersede'),
  idempotency_key: uuidSchema,
  id: uuidSchema,
  expected_etag: etagSchema,
  rationale: text,
  replacement_id: uuidSchema
});

const reviewResolveOperation = z.strictObject({
  action: z.literal('resolve'),
  idempotency_key: uuidSchema,
  id: uuidSchema,
  expected_heads: expectedHeadsSchema,
  rationale: text,
  note: noteInputSchema
});

export const captureRequestSchema = z
  .strictObject({
    idempotency_key: uuidSchema,
    scope: scopeIdSchema,
    note: noteInputSchema
  })
  .refine(withinInputBodyLimit, { message: 'input body exceeds the 256 KiB limit' });

export const projectEnsureRequestSchema = z
  .strictObject({
    idempotency_key: uuidSchema,
    remote_url: remoteUrlSchema
  })
  .refine(withinInputBodyLimit, { message: 'input body exceeds the 256 KiB limit' });

export const recallRequestSchema = z
  .strictObject({
    scope: scopeIdSchema,
    query: text,
    topics: z.array(text).max(32).optional(),
    phase: z.enum(PHASES).optional(),
    kinds: z.array(z.enum(NOTE_KINDS)).max(NOTE_KINDS.length).optional(),
    include_shared: z.boolean().optional(),
    include_candidates: z.boolean().optional(),
    session_id: text.optional(),
    mode: z.enum(RECALL_MODES).optional(),
    allow_text_fallback: z.boolean().optional(),
    budget_tokens: z.int().min(RECALL_BUDGET_TOKENS_MIN).max(RECALL_BUDGET_TOKENS_MAX).optional(),
    limit: z.int().min(1).max(RECALL_LIMIT_MAX).optional()
  })
  .refine(withinInputBodyLimit, { message: 'input body exceeds the 256 KiB limit' });

export const readRequestSchema = z
  .strictObject({
    scope: scopeIdSchema,
    id: uuidSchema,
    revision_id: uuidSchema.optional(),
    cursor: cursorSchema.optional(),
    budget_tokens: z.int().min(READ_BUDGET_TOKENS_MIN).max(READ_BUDGET_TOKENS_MAX).optional()
  })
  .refine(withinInputBodyLimit, { message: 'input body exceeds the 256 KiB limit' });

export const reviewRequestSchema = z
  .strictObject({
    scope: scopeIdSchema,
    operation: z.discriminatedUnion('action', [
      reviewListOperation,
      reviewDecisionOperation,
      reviewReviseOperation,
      reviewSupersedeOperation,
      reviewResolveOperation
    ])
  })
  .refine(withinInputBodyLimit, { message: 'input body exceeds the 256 KiB limit' });

export const feedbackRequestSchema = z
  .strictObject({
    idempotency_key: uuidSchema,
    scope: scopeIdSchema,
    id: uuidSchema,
    revision_id: uuidSchema,
    retrieval_id: uuidSchema.optional(),
    verdict: z.enum(FEEDBACK_VERDICTS),
    reason: text,
    related_id: uuidSchema.optional()
  })
  .refine(withinInputBodyLimit, { message: 'input body exceeds the 256 KiB limit' });

export const statusRequestSchema = z
  .strictObject({
    scope: scopeIdSchema.optional(),
    operation_id: uuidSchema.optional(),
    include_schemas: z.boolean().optional()
  })
  .refine(withinInputBodyLimit, { message: 'input body exceeds the 256 KiB limit' });
