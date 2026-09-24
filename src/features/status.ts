import { z } from 'zod';
import { BrainError, isBrainError } from '../contracts/errors.js';
import {
  etagSchema,
  noteInputSchema,
  scopeIdSchema,
  uuidSchema
} from '../contracts/content.js';
import { statusRequestSchema } from '../contracts/protocol.js';
import type { BrainDeps } from '../core/mutation.js';
import {
  LIFECYCLES,
  NOTE_KINDS,
  type AuthenticatedContext,
  type LocalHandlerDeps,
  type MutationReceipt,
  type ProjectEnsureResult,
  type ScopeConfig,
  type StatusRequest,
  type StatusResult
} from '../core/types.js';
import { mutationReceipt as localMutationReceipt, reconcileRetrievalDeps } from './local-support.js';
import { projectFilter } from '../projects/registry.js';
import { projectEnsureReceipt } from '../storage/legacy-project-adapter.js';
import {
  APPLICATION_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  toolDefinitions
} from '../mcp/tools.js';
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

const projectEnsureResultSchema = z.strictObject({
  operation_id: uuidSchema,
  repository_identity: z.string(),
  scope: scopeIdSchema,
  created: z.boolean(),
  backend_ready: z.boolean(),
  materialized: z.boolean(),
  warnings: z.array(z.string())
});
const storedRevisionSchema = z.looseObject({
  id: uuidSchema,
  revision_id: uuidSchema,
  operation_id: uuidSchema,
  parents: z.array(z.strictObject({ revision_id: uuidSchema, raw_hash: etagSchema })),
  scope: scopeIdSchema,
  status: z.enum(LIFECYCLES),
  note: noteInputSchema,
  created_at: z.iso.datetime(),
  modified_at: z.iso.datetime(),
  approval: z
    .strictObject({ principal_id: uuidSchema, rationale: z.string(), payload_hash: etagSchema })
    .optional(),
  replacement_id: uuidSchema.optional(),
  extra_frontmatter: z.record(z.string(), z.unknown()),
  extra_markdown: z.string()
});

const plannedWriteSchema = z.looseObject({
  revision: storedRevisionSchema,
  backend_project: z.string(),
  directory: z.string(),
  storage_title: z.string(),
  permalink: z.string(),
  body: z.string(),
  metadata: z.record(z.string(), z.unknown())
});

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function notFound(): BrainError {
  return new BrainError({
    code: 'NOT_FOUND',
    message: 'the requested operation is not available'
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

interface PlannedIdentity {
  id: string;
  revision_id: string;
  operation_id: string;
}

function plannedIdentity(record: OperationRecord): PlannedIdentity | undefined {
  if (record.plan_json === undefined) return undefined;
  let plan: unknown;
  try {
    plan = JSON.parse(record.plan_json);
  } catch (cause) {
    throw recoveryRequired(record.operation_id, cause);
  }
  const result = plannedWriteSchema.safeParse(plan);
  if (!result.success) throw recoveryRequired(record.operation_id);
  const revision = result.data.revision;
  if (
    revision.operation_id !== record.operation_id ||
    revision.scope !== record.scope
  ) {
    throw recoveryRequired(record.operation_id);
  }
  return {
    id: revision.id,
    revision_id: revision.revision_id,
    operation_id: revision.operation_id
  };
}

function receiptFromRecord(record: OperationRecord): MutationReceipt | ProjectEnsureResult | undefined {
  if (record.tool === 'brain_project_ensure') {
    if (record.receipt_json === undefined) return undefined;
    const projected = projectEnsureReceipt(record.receipt_json, record.operation_id);
    if (projected.project_id !== record.scope) {
      throw recoveryRequired(record.operation_id);
    }
    return {
      operation_id: projected.operation_id,
      repository_identity: projected.repository_identity,
      scope: projected.project_id,
      created: projected.created,
      backend_ready: projected.backend_ready,
      materialized: projected.materialized,
      warnings: projected.warnings
    };
  }
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
      (receipt.id !== plan.id ||
        receipt.revision_id !== plan.revision_id ||
        receipt.operation_id !== plan.operation_id)
    ) {
      throw recoveryRequired(record.operation_id);
    }
    return receipt;
  }
  if (plan !== undefined) {
    return {
      operation_id: plan.operation_id,
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
  ctx: AuthenticatedContext,
  input: StatusRequest,
  deps: BrainDeps
): Promise<StatusResult> {
  if (ctx.signal.aborted) throw cancelled();
  const request = parseRequest(input);
  const filter = projectFilter(request);

  const projectRecords = deps.journal.listProjects();
  const selectedScopes =
    filter.mode === 'all'
      ? deps.scopeRegistry.all()
      : [deps.scopeRegistry.require(filter.identifier)];

  const scopes = selectedScopes.map((scope) => ({ id: scope.id }));
  const selectedIds = new Set(selectedScopes.map((scope) => scope.id));
  const pending = deps.journal
    .pending()
    .filter((record) => filter.mode === 'all' || selectedIds.has(record.scope));

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
  const projects = projectRecords.filter(
    (project) => filter.mode === 'all' || selectedIds.has(project.project.id)
  );
  if (projects.length > 0) {
    result.projects = projects.map((project) => ({
      scope: project.project.id,
      state: project.state
    }));
  }

  if (request.operation_id !== undefined) {
    const record = deps.journal.get(request.operation_id);
    if (record === undefined) throw notFound();
    const receipt = receiptFromRecord(record);
    if (receipt !== undefined) result.operation = receipt;
  }

  if (request.include_schemas === true) result.schemas = toolSchemas();

  return result;
}

function statusCancelled(): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the caller cancelled the status request' });
}

function statusNotFound(): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message: 'the requested operation is not available' });
}

export async function statusLocal(
  ctx: AuthenticatedContext,
  input: StatusRequest,
  deps: LocalHandlerDeps
): Promise<StatusResult> {
  if (ctx.signal.aborted) throw statusCancelled();
  const request = parseRequest(input);
  const identifier = request.project ?? request.scope;
  const resolved = identifier === undefined ? undefined : deps.projects.resolve(identifier);
  const selectedId = resolved?.id;

  let indexFailed = false;
  let pendingIndex = 0;
  try {
    const report = await reconcileRetrievalDeps(deps);
    indexFailed = report.index_failed;
    pendingIndex = report.pending_index;
  } catch {
    indexFailed = true;
  }
  if (ctx.signal.aborted) throw statusCancelled();

  let documents: number | undefined;
  try {
    documents = deps.index.paths().length;
  } catch {
    documents = undefined;
  }

  const projects = deps.projects.list().filter((project) => selectedId === undefined || project.id === selectedId);
  const pending = deps.mutations
    .pending()
    .filter((operation) => selectedId === undefined || operation.project_id === selectedId);
  const workerHealth = deps.worker?.health();
  const workerState = workerHealth === undefined ? 'disabled' : workerHealth.state;
  const gateway = indexFailed ? 'degraded' : pending.length > 0 ? 'recovering' : 'ready';

  const result: StatusResult = {
    version: APPLICATION_VERSION,
    protocol_version: '2',
    schema_version: SCHEMA_VERSION,
    protocol: 2,
    scopes: projects.map((project) => ({ id: project.id })),
    health: { gateway, backend: 'unavailable', embeddings: 'unknown' },
    local: {
      index: {
        state: indexFailed ? 'unavailable' : 'ready',
        ...(documents === undefined ? {} : { documents }),
        pending_index: pendingIndex
      },
      worker:
        workerHealth === undefined
          ? { state: 'disabled' }
          : {
              state: workerHealth.state,
              ...(workerHealth.model_fingerprint === undefined
                ? {}
                : { model_fingerprint: workerHealth.model_fingerprint })
            }
    },
    features: {
      reranking: workerState === 'ready',
      text_search: true,
      fallback: true
    },
    pending_operations: pending.length
  };

  if (projects.length > 0) {
    result.projects = projects.map((project) => ({
      scope: project.id,
      state: project.state,
      display_name: project.display_name,
      relative_root: project.relative_root
    }));
  }

  if (request.operation_id !== undefined) {
    const status = deps.mutations.status(request.operation_id);
    if (status === undefined) throw statusNotFound();
    if (selectedId !== undefined && status.project_id !== selectedId) throw statusNotFound();
    if (status.receipt?.kind === 'note') {
      result.operation = localMutationReceipt(status.receipt);
    } else if (status.receipt?.kind === 'project_ensure') {
      result.operation = {
        operation_id: status.receipt.operation_id,
        repository_identity: status.receipt.repository_identity,
        scope: status.receipt.project_id,
        project_id: status.receipt.project_id,
        relative_root: status.receipt.relative_root,
        created: status.receipt.created,
        backend_ready: false,
        materialized: status.receipt.materialized,
        warnings: status.receipt.warnings
      };
    } else if (status.receipt !== undefined) {
      result.operation = status.receipt as unknown as StatusResult['operation'];
    }
  }

  if (request.include_schemas === true) result.schemas = toolSchemas();

  return result;
}
