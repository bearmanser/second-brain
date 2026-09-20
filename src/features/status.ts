import { z } from 'zod';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { etagSchema, scopeIdSchema, uuidSchema } from '../contracts/content.js';
import { statusRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps } from '../core/mutation.js';
import {
  LIFECYCLES,
  NOTE_KINDS,
  type MutationReceipt,
  type Principal,
  type RequestContext,
  type ScopeConfig,
  type StatusRequest,
  type StatusResult
} from '../core/types.js';
import { DUPLICATE_DETAILS_WITHHELD } from './capture.js';
import {
  APPLICATION_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  toolDefinitions
} from '../mcp/tools.js';
import { resolveScopes } from '../security/authorise.js';
import type { OperationRecord } from '../storage/journal.js';

const MATERIALIZATION_UNCONFIRMED = 'materialization_unconfirmed';

const sourceRefSchema = z.strictObject({
  id: uuidSchema,
  revision_id: uuidSchema,
  scope: scopeIdSchema,
  title: z.string(),
  kind: z.enum(NOTE_KINDS),
  status: z.enum(LIFECYCLES),
  etag: etagSchema,
  relative_path: z.string(),
  warnings: z.array(z.string())
});

const mutationReceiptSchema = z.strictObject({
  operation_id: uuidSchema,
  id: uuidSchema,
  revision_id: uuidSchema,
  outcome: z.enum(['stored', 'stored_conflict', 'pending']),
  materialized: z.boolean(),
  indexed: z.boolean(),
  etag: etagSchema.optional(),
  possible_duplicates: z.array(sourceRefSchema),
  warnings: z.array(z.string())
});

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function notFound(): BrainError {
  return new BrainError({
    code: 'NOT_FOUND',
    message: 'the requested operation is not available to this principal'
  });
}

function cancelled(): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the caller cancelled the status request' });
}

function recoveryRequired(operation_id: string, cause?: unknown): BrainError {
  return new BrainError({
    code: 'RECOVERY_REQUIRED',
    message: `operation ${operation_id} has an unreadable persisted record`,
    operation_id,
    cause
  });
}

function parseRequest(input: StatusRequest): StatusRequest {
  const parsed = statusRequestSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw invalidInput(`status request is invalid: ${detail}`);
  }
  return parsed.data as StatusRequest;
}

function readableScopes(principal: Principal, configured: ScopeConfig[]): ScopeConfig[] {
  return configured.filter((scope) => principal.read_scopes.includes(scope.id));
}

function scopeEntry(
  principal: Principal,
  scope: ScopeConfig
): { id: string; can_write: boolean; can_review: boolean } {
  return {
    id: scope.id,
    can_write: principal.write_scopes.includes(scope.id),
    can_review: principal.review_scopes.includes(scope.id)
  };
}

function canInspect(principal: Principal, record: OperationRecord): boolean {
  if (record.principal_id === principal.id) return true;
  if (principal.role !== 'owner') return false;
  return (
    principal.read_scopes.includes(record.scope) ||
    principal.write_scopes.includes(record.scope) ||
    principal.review_scopes.includes(record.scope)
  );
}

interface PlannedIdentity {
  id: string;
  revision_id: string;
}

function plannedIdentity(record: OperationRecord): PlannedIdentity | undefined {
  if (record.plan_json === undefined) return undefined;
  let plan: unknown;
  try {
    plan = JSON.parse(record.plan_json);
  } catch (cause) {
    throw recoveryRequired(record.operation_id, cause);
  }
  const revision =
    plan !== null && typeof plan === 'object'
      ? (plan as { revision?: { id?: unknown; revision_id?: unknown } }).revision
      : undefined;
  if (
    revision === undefined ||
    typeof revision.id !== 'string' ||
    typeof revision.revision_id !== 'string'
  ) {
    throw recoveryRequired(record.operation_id);
  }
  return { id: revision.id, revision_id: revision.revision_id };
}

function receiptFromRecord(record: OperationRecord): MutationReceipt | undefined {
  const plan = plannedIdentity(record);
  if (record.receipt_json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.receipt_json);
    } catch (cause) {
      throw recoveryRequired(record.operation_id, cause);
    }
    const result = mutationReceiptSchema.safeParse(parsed);
    if (!result.success) throw recoveryRequired(record.operation_id);
    const receipt = result.data as MutationReceipt;
    if (receipt.operation_id !== record.operation_id) throw recoveryRequired(record.operation_id);
    if (
      plan !== undefined &&
      (receipt.id !== plan.id || receipt.revision_id !== plan.revision_id)
    ) {
      throw recoveryRequired(record.operation_id);
    }
    return receipt;
  }
  if (plan !== undefined) {
    return {
      operation_id: record.operation_id,
      id: plan.id,
      revision_id: plan.revision_id,
      outcome: 'pending',
      materialized: false,
      indexed: false,
      possible_duplicates: [],
      warnings: [MATERIALIZATION_UNCONFIRMED]
    };
  }
  return undefined;
}

function filterReadableDuplicates(
  principal: Principal,
  receipt: MutationReceipt
): MutationReceipt {
  if (receipt.possible_duplicates.length === 0) return receipt;
  const readable = new Set(principal.read_scopes);
  const visible = receipt.possible_duplicates.filter((entry) => readable.has(entry.scope));
  if (visible.length === receipt.possible_duplicates.length) return receipt;
  const warnings = [...receipt.warnings];
  if (!warnings.includes(DUPLICATE_DETAILS_WITHHELD)) warnings.push(DUPLICATE_DETAILS_WITHHELD);
  return { ...receipt, possible_duplicates: visible, warnings };
}

function toolSchemas(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const definition of toolDefinitions) {
    schemas[definition.name] = {
      input_schema: definition.inputSchema,
      output_schema: definition.outputSchema
    };
  }
  return schemas;
}

async function backendHealth(deps: BrainDeps): Promise<'ready' | 'unavailable'> {
  try {
    await deps.backend.probe();
    return 'ready';
  } catch (error) {
    if (isBrainError(error) && error.code === 'CANCELLED') throw error;
    return 'unavailable';
  }
}

export async function status(
  ctx: RequestContext,
  input: StatusRequest,
  deps: BrainDeps
): Promise<StatusResult> {
  if (ctx.signal.aborted) throw cancelled();
  const request = parseRequest(input);

  const authorized = readableScopes(ctx.principal, deps.config.scopes);
  const scopes =
    request.scope === undefined
      ? authorized.map((scope) => scopeEntry(ctx.principal, scope))
      : [
          scopeEntry(
            ctx.principal,
            resolveScopes(ctx.principal, request.scope, false, 'read', deps.config.scopes)[0]
          )
        ];

  const scopeIds = new Set(scopes.map((entry) => entry.id));
  const pending = deps.journal.pending().filter((record) => scopeIds.has(record.scope));

  const backend = await backendHealth(deps);
  const gateway = backend === 'unavailable' ? 'degraded' : pending.length > 0 ? 'recovering' : 'ready';

  const result: StatusResult = {
    version: APPLICATION_VERSION,
    protocol_version: PROTOCOL_VERSION,
    schema_version: SCHEMA_VERSION,
    scopes,
    health: { gateway, backend, embeddings: 'unknown' },
    pending_operations: pending.length
  };

  if (request.operation_id !== undefined) {
    const record = deps.journal.get(request.operation_id);
    if (record === undefined || !canInspect(ctx.principal, record)) throw notFound();
    const receipt = receiptFromRecord(record);
    if (receipt !== undefined) result.operation = filterReadableDuplicates(ctx.principal, receipt);
  }

  if (request.include_schemas === true) result.schemas = toolSchemas();

  return result;
}
