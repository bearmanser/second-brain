import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { etagSchema, scopeIdSchema, uuidSchema } from '../contracts/content.js';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { RECALL_MAX_SCOPES, RECALL_LIMIT_MAX, SCOPE_ID_PATTERN } from '../core/limits.js';
import {
  FEEDBACK_VERDICTS,
  LIFECYCLES,
  NOTE_KINDS,
  RECALL_MODES,
  RETRIEVAL_OUTCOMES_V2,
  SYSTEM_ACTOR,
  type Clock,
  type FeedbackVerdict,
  type IdSource,
  type LegacyProjectBackendBinding,
  type MutationReceipt,
  type PersistedProject,
  type ProjectFilter,
  type ProjectEnsureResult,
  type ProjectProvisioningPlan,
  type PlannedWrite,
  type RecallMode,
  type RepositoryProjectState,
  type RetrievalEventInputV2,
  type RetrievalOutcomeV2
} from '../core/types.js';
import { containsCredentials } from '../security/redact.js';
import { assertProjectIdentifier } from '../projects/registry.js';

export const OPERATION_STATES = [
  'prepared',
  'submitted',
  'materialized',
  'complete',
  'conflict',
  'failed'
] as const;

export type OperationState = (typeof OPERATION_STATES)[number];

const TERMINAL_STATES: readonly OperationState[] = ['complete', 'conflict', 'failed'];
const PRUNABLE_STATES: readonly OperationState[] = ['complete', 'failed'];
const ALLOWED_TRANSITIONS: Record<OperationState, readonly OperationState[]> = {
  prepared: ['submitted', 'failed', 'conflict'],
  submitted: ['materialized', 'complete', 'failed', 'conflict'],
  materialized: ['complete', 'failed', 'conflict'],
  complete: [],
  conflict: [],
  failed: []
};
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MIGRATION_FILE_PATTERN = /^(\d+)-[a-z0-9-]+\.sql$/;
const AUDIT_TEXT_MAX_LENGTH = 256;
const OPERATIONAL_LOSS_ACKNOWLEDGEMENT = 'operational_loss_acknowledged';

export const AUDIT_FIELDS = ['request_id', 'tool', 'outcome', 'duration_ms', 'note_count'] as const;
export type AuditField = (typeof AUDIT_FIELDS)[number];

export const RETRIEVAL_OUTCOMES = ['ok', 'partial', 'error'] as const;
export type RetrievalOutcome = (typeof RETRIEVAL_OUTCOMES)[number];

export const FEEDBACK_REASON_MAX_LENGTH = 240;
export const FEEDBACK_REASON_INPUT_MAX_LENGTH = 8000;

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const legacySourceRefSchema = z.strictObject({
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
const legacyMutationReceiptSchema = z.strictObject({
  operation_id: uuidSchema,
  id: uuidSchema,
  revision_id: uuidSchema,
  outcome: z.enum(['stored', 'stored_conflict', 'pending']),
  materialized: z.boolean(),
  indexed: z.boolean(),
  etag: etagSchema.optional(),
  possible_duplicates: z.array(legacySourceRefSchema),
  warnings: z.array(z.string())
});
const legacyProjectReceiptSchema = z.looseObject({
  operation_id: uuidSchema,
  repository_identity: z.string().min(1),
  project_id: scopeIdSchema.optional(),
  scope: scopeIdSchema.optional(),
  created: z.boolean(),
  backend_ready: z.boolean(),
  materialized: z.boolean(),
  warnings: z.array(z.string())
});
const FEEDBACK_WARNING_MAX_LENGTH = 128;

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url));

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdSource = { next: () => randomUUID() };

export interface OperationReservation {
  principal_id: string;
  idempotency_key: string;
  tool: string;
  scope: string;
  payload_hash: string;
  payload_json: string;
}

export interface OperationRecord extends OperationReservation {
  operation_id: string;
  state: OperationState;
  plan_json?: string;
  receipt_json?: string;
  created_at: string;
  updated_at: string;
}

export type ReservationResult =
  | { kind: 'new'; record: OperationRecord }
  | { kind: 'replay'; record: OperationRecord };

export interface JournalOptions {
  clock?: Clock;
  ids?: IdSource;
  requireExisting?: boolean;
}

export interface ProjectReservation {
  repository_identity: string;
  project_id: string;
  display_name?: string;
  relative_root?: string;
  backend_project?: string;
  backend_relative_root?: string;
  created_by_actor_id: string;
  creation_operation_id: string;
}

export type ProjectReservationResult =
  | { kind: 'new'; project: PersistedProject }
  | { kind: 'replay'; project: PersistedProject };

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface ReceiptAvailability {
  materialized?: boolean;
  indexed?: boolean;
}

export interface ApprovalProvenanceRecord {
  operation_id: string;
  scope: string;
  logical_id: string;
  revision_id: string;
  principal_id: string;
  payload_hash: string;
}

export interface AuditEvent {
  request_id: string;
  tool: string;
  outcome: string;
  duration_ms: number;
  note_count: number;
}

export interface AuditEventRecord extends AuditEvent {
  created_at: string;
}

export interface RetrievalEventInput {
  retrieval_id: string;
  principal_id: string;
  scope: string;
  scope_ids: string[];
  returned_ids: { id: string; revision_id: string }[];
  item_count: number;
  token_used: number;
  token_limit: number;
  mode: RecallMode;
  outcome: RetrievalOutcome;
  partial: boolean;
  duration_ms: number;
  created_at?: string;
}

export interface RetrievalEvent extends Omit<RetrievalEventInput, 'created_at'> {
  created_at: string;
}

export interface StoredRetrievalRef {
  scope: string | null;
  id: string;
  revision_id: string;
}

export interface RetrievalEventV2 {
  retrieval_id: string;
  actor_id: string;
  filter: ProjectFilter;
  searched_project_ids: string[];
  primary_project_id: string | null;
  returned_ids: StoredRetrievalRef[];
  item_count: number;
  token_used: number;
  token_limit: number;
  mode: RecallMode;
  outcome: RetrievalOutcomeV2;
  partial: boolean;
  duration_ms: number;
  created_at: string;
}

export interface FeedbackWrite {
  principal_id: string;
  idempotency_key: string;
  scope: string;
  logical_id: string;
  revision_id: string;
  retrieval_id?: string;
  related_id?: string;
  verdict: FeedbackVerdict;
  reason: string;
  warning?: string;
}

export interface FeedbackEntry extends FeedbackWrite {
  feedback_id: string;
  created_at: string;
}

export interface FeedbackWriteResult {
  kind: 'new' | 'replay';
  entry: FeedbackEntry;
}

interface RetrievalRow {
  retrieval_id: string;
  principal_id: string;
  scope: string | null;
  scope_ids_json: string;
  returned_ids_json: string;
  item_count: number;
  token_used: number;
  token_limit: number;
  mode: string;
  outcome: string;
  partial: number;
  duration_ms: number;
  filter_json: string | null;
  created_at: string;
}

interface FeedbackRow {
  feedback_id: string;
  principal_id: string;
  idempotency_key: string;
  scope: string;
  logical_id: string;
  revision_id: string;
  retrieval_id: string | null;
  related_id: string | null;
  verdict: string;
  reason: string;
  warning: string | null;
  payload_hash: string | null;
  created_at: string;
}

interface AuditRow {
  request_id: string;
  tool: string;
  outcome: string;
  duration_ms: number;
  note_count: number;
  created_at: string;
}

interface OperationRow {
  operation_id: string;
  principal_id: string;
  idempotency_key: string;
  tool: string;
  scope: string;
  payload_hash: string;
  payload_json: string;
  plan_json: string | null;
  state: string;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  repository_identity: string | null;
  display_name: string;
  relative_root: string;
  legacy_scope: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

interface ProjectProvisioningRow {
  project_id: string;
  created_by_actor_id: string;
  creation_operation_id: string;
  failure_stage: string | null;
  failure_code: string | null;
}

interface ProjectBindingRow {
  project_id: string;
  backend_project: string;
  backend_relative_root: string;
}

interface IdempotencyKeyRow {
  idempotency_key: string;
  origin: string;
  resolution: string;
  tool: string | null;
  project_id: string | null;
  payload_hash: string | null;
  target_kind: string | null;
  target_id: string | null;
}

interface LegacyMemberRow {
  idempotency_key: string;
  record_kind: string;
  record_id: string;
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

interface KeyResolutionError {
  key_resolution?: 'conflict' | 'recovery_required';
}

function markResolution(error: BrainError, resolution: 'conflict' | 'recovery_required'): BrainError {
  (error as KeyResolutionError).key_resolution = resolution;
  return error;
}

function keyResolutionOf(error: unknown): 'conflict' | 'recovery_required' | undefined {
  if (!isBrainError(error)) return undefined;
  const value = (error as KeyResolutionError).key_resolution;
  return value === 'conflict' || value === 'recovery_required' ? value : undefined;
}

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function conflict(message: string, operation_id: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message, operation_id });
}

function notFound(operation_id: string): BrainError {
  return new BrainError({
    code: 'NOT_FOUND',
    message: `operation ${operation_id} was not found`,
    operation_id
  });
}

function isTerminal(state: OperationState): boolean {
  return TERMINAL_STATES.includes(state);
}

function requireState(value: string, operation_id: string): OperationState {
  if ((OPERATION_STATES as readonly string[]).includes(value)) return value as OperationState;
  throw recoveryRequired(`operation ${operation_id} has an unknown stored state`);
}

const REPOSITORY_PROJECT_STATES = [
  'provisioning',
  'ready',
  'recovery_required'
] as const satisfies readonly RepositoryProjectState[];
const FAILURE_STAGE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function requireProjectState(value: string): RepositoryProjectState {
  if ((REPOSITORY_PROJECT_STATES as readonly string[]).includes(value)) {
    return value as RepositoryProjectState;
  }
  throw recoveryRequired('repository project has an unknown stored state');
}

function requireProjectText(value: string, field: string): string {
  if (value.length === 0 || value.length > 2048 || CONTROL_OR_LINE_BREAK.test(value)) {
    throw recoveryRequired(`repository project has malformed ${field}`);
  }
  return value;
}

const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f]/;

function toPersistedProject(
  row: ProjectRow,
  provisioning: ProjectProvisioningRow
): PersistedProject {
  const id = requireProjectText(row.id, 'id');
  if (!SCOPE_ID_PATTERN.test(id)) throw recoveryRequired('project has malformed id');
  const displayName = requireProjectText(row.display_name, 'display name');
  const relativeRoot = requireProjectText(row.relative_root, 'relative root');
  if (!RFC3339_PATTERN.test(row.created_at) || !RFC3339_PATTERN.test(row.updated_at)) {
    throw recoveryRequired('project has malformed timestamps');
  }
  if (provisioning.project_id !== id) {
    throw recoveryRequired('project provisioning does not match its project');
  }
  const failureFieldsMatch =
    (provisioning.failure_stage === null && provisioning.failure_code === null) ||
    (provisioning.failure_stage !== null && provisioning.failure_code !== null);
  if (!failureFieldsMatch) throw recoveryRequired('project has incomplete failure data');
  if (
    provisioning.failure_stage !== null &&
    (!FAILURE_STAGE_PATTERN.test(provisioning.failure_stage) ||
      provisioning.failure_code === null ||
      !FAILURE_CODE_PATTERN.test(provisioning.failure_code))
  ) {
    throw recoveryRequired('project has unsafe failure data');
  }
  const repositoryIdentity =
    row.repository_identity === null
      ? undefined
      : requireProjectText(row.repository_identity, 'identity');
  return {
    project: {
      id,
      display_name: displayName,
      relative_root: relativeRoot,
      ...(repositoryIdentity === undefined ? {} : { repository_identity: repositoryIdentity })
    },
    state: requireProjectState(row.state),
    provisioning: {
      created_by_actor_id: requireProjectText(provisioning.created_by_actor_id, 'creator'),
      creation_operation_id: requireProjectText(provisioning.creation_operation_id, 'operation'),
      ...(provisioning.failure_stage === null
        ? {}
        : { failure_stage: provisioning.failure_stage }),
      ...(provisioning.failure_code === null ? {} : { failure_code: provisioning.failure_code })
    },
    updated_at: row.updated_at
  };
}

function toProjectBinding(row: ProjectBindingRow): LegacyProjectBackendBinding {
  return {
    backend_project: requireProjectText(row.backend_project, 'backend project'),
    backend_relative_root: requireProjectText(row.backend_relative_root, 'backend relative root')
  };
}

function hasTable(database: Database.Database, name: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function appliedVersions(database: Database.Database): Set<number> {
  if (!hasTable(database, 'schema_migrations')) return new Set();
  const rows = database.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  return new Set(rows.map((row) => row.version));
}

export function loadMigrations(directory: string): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (cause) {
    throw recoveryRequired(`migration directory ${directory} is unreadable`, cause);
  }
  const migrations: Migration[] = [];
  const versions = new Set<number>();
  for (const name of entries) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (match === null) continue;
    const version = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw invalidInput(`migration ${name} has an invalid version`);
    }
    if (versions.has(version)) {
      throw invalidInput(`duplicate migration version ${version}`);
    }
    versions.add(version);
    let sql: string;
    try {
      sql = readFileSync(join(directory, name), 'utf8');
    } catch (cause) {
      throw recoveryRequired(`migration ${name} is unreadable`, cause);
    }
    migrations.push({ version, name, sql });
  }
  migrations.sort((left, right) => left.version - right.version);
  return migrations;
}

export function applyMigrations(
  database: Database.Database,
  directory: string,
  appliedAt: string
): number[] {
  const migrations = loadMigrations(directory);
  if (migrations.length === 0) {
    throw recoveryRequired(`no migrations were found in ${directory}`);
  }
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
  );
  const applied = appliedVersions(database);
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      const violations = database.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw recoveryRequired(
          `migration ${migration.version} left ${violations.length} foreign key violation(s)`
        );
      }
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, appliedAt);
    });
    apply.immediate();
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

function toRetrieval(row: RetrievalRow): RetrievalEvent {
  let scopeIds: string[];
  let returnedIds: { id: string; revision_id: string }[];
  try {
    scopeIds = JSON.parse(row.scope_ids_json) as string[];
    returnedIds = JSON.parse(row.returned_ids_json) as { id: string; revision_id: string }[];
  } catch (cause) {
    throw recoveryRequired(`retrieval ${row.retrieval_id} has unreadable metadata`, cause);
  }
  if (!Array.isArray(scopeIds) || !Array.isArray(returnedIds)) {
    throw recoveryRequired(`retrieval ${row.retrieval_id} has invalid metadata`);
  }
  if (!(RETRIEVAL_OUTCOMES as readonly string[]).includes(row.outcome)) {
    throw recoveryRequired(`retrieval ${row.retrieval_id} has an unknown outcome`);
  }
  return {
    retrieval_id: row.retrieval_id,
    principal_id: row.principal_id,
    scope: row.scope ?? '',
    scope_ids: scopeIds,
    returned_ids: returnedIds,
    item_count: row.item_count,
    token_used: row.token_used,
    token_limit: row.token_limit,
    mode: row.mode as RecallMode,
    outcome: row.outcome as RetrievalOutcome,
    partial: row.partial === 1,
    duration_ms: row.duration_ms,
    created_at: row.created_at
  };
}

function normalizeFilter(filter: ProjectFilter): ProjectFilter {
  if (filter === null || typeof filter !== 'object') {
    throw invalidInput('a project filter is required');
  }
  if (filter.mode === 'all') return { mode: 'all' };
  if (filter.mode === 'project') {
    return { mode: 'project', identifier: assertProjectIdentifier(filter.identifier) };
  }
  throw invalidInput('unknown project filter');
}

function parseStoredFilter(row: RetrievalRow): ProjectFilter {
  if (row.filter_json !== null) {
    try {
      const parsed = JSON.parse(row.filter_json) as ProjectFilter;
      if (parsed.mode === 'all') return { mode: 'all' };
      if (parsed.mode === 'project' && typeof parsed.identifier === 'string') {
        return { mode: 'project', identifier: parsed.identifier };
      }
    } catch {
      throw recoveryRequired(`retrieval ${row.retrieval_id} has an unreadable filter`);
    }
  }
  return row.scope === null ? { mode: 'all' } : { mode: 'project', identifier: row.scope };
}

function toRetrievalV2(row: RetrievalRow): RetrievalEventV2 {
  let searched: unknown;
  let returned: unknown;
  try {
    searched = JSON.parse(row.scope_ids_json);
    returned = JSON.parse(row.returned_ids_json);
  } catch (cause) {
    throw recoveryRequired(`retrieval ${row.retrieval_id} has unreadable metadata`, cause);
  }
  if (!Array.isArray(searched) || !Array.isArray(returned)) {
    throw recoveryRequired(`retrieval ${row.retrieval_id} has invalid metadata`);
  }
  const searched_project_ids = searched.map((value, index) =>
    requireScopeId(value, `searched_project_ids[${index}]`)
  );
  const returned_ids: StoredRetrievalRef[] = returned.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw recoveryRequired(`retrieval ${row.retrieval_id} has an invalid returned reference`);
    }
    const record = entry as Record<string, unknown>;
    const scope =
      typeof record.scope === 'string' && SCOPE_ID_PATTERN.test(record.scope) ? record.scope : null;
    return {
      scope,
      id: requireUuid(record.id, `returned_ids[${index}].id`),
      revision_id: requireUuid(record.revision_id, `returned_ids[${index}].revision_id`)
    };
  });
  if (!(RETRIEVAL_OUTCOMES_V2 as readonly string[]).includes(row.outcome)) {
    throw recoveryRequired(`retrieval ${row.retrieval_id} has an unknown outcome`);
  }
  return {
    retrieval_id: row.retrieval_id,
    actor_id: row.principal_id,
    filter: parseStoredFilter(row),
    searched_project_ids,
    primary_project_id: row.scope,
    returned_ids,
    item_count: row.item_count,
    token_used: row.token_used,
    token_limit: row.token_limit,
    mode: row.mode as RecallMode,
    outcome: row.outcome as RetrievalOutcomeV2,
    partial: row.partial === 1,
    duration_ms: row.duration_ms,
    created_at: row.created_at
  };
}

function normalizeRetrievalV2(
  input: RetrievalEventInputV2,
  defaultTimestamp: string
): RetrievalEventV2 {
  if (input === null || typeof input !== 'object') {
    throw invalidInput('retrieval metadata must be an object');
  }
  const retrieval_id = requireUuid(input.retrieval_id, 'retrieval_id');
  const actor_id = requireActorId(input.actor_id, 'actor_id');
  const filter = normalizeFilter(input.filter);
  if (!Array.isArray(input.searched_project_ids) || input.searched_project_ids.length > 64) {
    throw invalidInput('searched_project_ids must be a bounded array');
  }
  const searched_project_ids = [
    ...new Set(input.searched_project_ids.map((value) => requireScopeId(value, 'searched_project_ids')))
  ];
  const primary_project_id =
    input.primary_project_id === null
      ? null
      : requireScopeId(input.primary_project_id, 'primary_project_id');
  if (!Array.isArray(input.returned_ids) || input.returned_ids.length > RECALL_LIMIT_MAX) {
    throw invalidInput('returned_ids must be a bounded array');
  }
  const returned_ids: StoredRetrievalRef[] = input.returned_ids.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw invalidInput(`returned_ids[${index}] must be an object`);
    }
    return {
      scope: requireScopeId(entry.scope, `returned_ids[${index}].scope`),
      id: requireUuid(entry.id, `returned_ids[${index}].id`),
      revision_id: requireUuid(entry.revision_id, `returned_ids[${index}].revision_id`)
    };
  });
  if (!(RECALL_MODES as readonly string[]).includes(input.mode)) {
    throw invalidInput(`unknown retrieval mode ${String(input.mode)}`);
  }
  if (!(RETRIEVAL_OUTCOMES_V2 as readonly string[]).includes(input.outcome)) {
    throw invalidInput(`unknown retrieval outcome ${String(input.outcome)}`);
  }
  if (typeof input.partial !== 'boolean') throw invalidInput('partial must be a boolean');
  const item_count = requireFiniteCount(input.item_count, 'item_count');
  if (item_count !== returned_ids.length) {
    throw invalidInput('item_count must match the number of returned ids');
  }
  const token_used = requireFiniteCount(input.token_used, 'token_used');
  const token_limit = requireFiniteCount(input.token_limit, 'token_limit');
  if (token_limit <= 0 || token_used > token_limit) {
    throw invalidInput('token accounting must satisfy 0 <= token_used <= token_limit');
  }
  const duration_ms = requireFiniteCount(input.duration_ms, 'duration_ms');
  const created_at =
    input.created_at === undefined
      ? defaultTimestamp
      : requireTimestamp(input.created_at, 'created_at');
  return {
    retrieval_id,
    actor_id,
    filter,
    searched_project_ids,
    primary_project_id,
    returned_ids,
    item_count,
    token_used,
    token_limit,
    mode: input.mode,
    outcome: input.outcome,
    partial: input.partial,
    duration_ms,
    created_at
  };
}

function toFeedback(row: FeedbackRow): FeedbackEntry {
  return {
    feedback_id: row.feedback_id,
    principal_id: row.principal_id,
    idempotency_key: row.idempotency_key,
    scope: row.scope,
    logical_id: row.logical_id,
    revision_id: row.revision_id,
    ...(row.retrieval_id === null ? {} : { retrieval_id: row.retrieval_id }),
    ...(row.related_id === null ? {} : { related_id: row.related_id }),
    verdict: row.verdict as FeedbackVerdict,
    reason: row.reason,
    ...(row.warning === null ? {} : { warning: row.warning }),
    created_at: row.created_at
  };
}

function toAudit(row: AuditRow): AuditEventRecord {
  return {
    request_id: row.request_id,
    tool: row.tool,
    outcome: row.outcome,
    duration_ms: row.duration_ms,
    note_count: row.note_count,
    created_at: row.created_at
  };
}

function boundReason(value: string): string {
  const points = [...value];
  if (points.length <= FEEDBACK_REASON_MAX_LENGTH) return value;
  return points.slice(0, FEEDBACK_REASON_MAX_LENGTH).join('');
}

function requireFiniteCount(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw invalidInput(`${field} must be a non-negative finite number`);
  }
  return Math.trunc(value);
}

function requireAuditText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidInput(`${field} must be a non-empty string`);
  }
  if (value.length > AUDIT_TEXT_MAX_LENGTH) {
    throw invalidInput(`${field} exceeds the audit field length limit`);
  }
  if (containsCredentials(value)) {
    throw invalidInput(`${field} rejected because it contains an obvious credential`);
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidSchema.safeParse(value).success) {
    throw invalidInput(`${field} must be a UUID string`);
  }
  return value;
}

function requireActorId(value: unknown, field: string): string {
  if (value === SYSTEM_ACTOR.id) return value;
  if (typeof value !== 'string' || !uuidSchema.safeParse(value).success) {
    throw invalidInput(`${field} must be a legacy UUID or the system actor`);
  }
  return value;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry));
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) ordered[key] = canonicalJsonValue(source[key]);
    return ordered;
  }
  return value;
}

function canonicalJson(raw: string): string {
  return JSON.stringify(canonicalJsonValue(JSON.parse(raw)));
}

function feedbackSemanticHash(input: FeedbackWrite): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        scope: input.scope,
        logical_id: input.logical_id,
        revision_id: input.revision_id,
        retrieval_id: input.retrieval_id ?? null,
        related_id: input.related_id ?? null,
        verdict: input.verdict,
        reason: input.reason,
        warning: input.warning ?? null
      }),
      'utf8'
    )
    .digest('hex');
}

function legacyFeedbackHash(input: FeedbackWrite, principalId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        principal_id: principalId,
        idempotency_key: input.idempotency_key,
        scope: input.scope,
        logical_id: input.logical_id,
        revision_id: input.revision_id,
        retrieval_id: input.retrieval_id ?? null,
        related_id: input.related_id ?? null,
        verdict: input.verdict,
        reason: input.reason,
        warning: input.warning ?? null
      }),
      'utf8'
    )
    .digest('hex');
}

function requireScopeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SCOPE_ID_PATTERN.test(value)) {
    throw invalidInput(`${field} must match the scope identifier pattern`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !RFC3339_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw invalidInput(`${field} must be an RFC3339 timestamp`);
  }
  return new Date(value).toISOString();
}

function normalizeRetrieval(input: RetrievalEventInput, defaultTimestamp: string): RetrievalEvent {
  if (input === null || typeof input !== 'object') {
    throw invalidInput('retrieval metadata must be an object');
  }
  const retrieval_id = requireUuid(input.retrieval_id, 'retrieval_id');
  const principal_id = requireActorId(input.principal_id, 'principal_id');
  const scope = requireScopeId(input.scope, 'scope');
  if (!Array.isArray(input.scope_ids) || input.scope_ids.length === 0) {
    throw invalidInput('scope_ids must be a non-empty array');
  }
  if (input.scope_ids.length > RECALL_MAX_SCOPES) {
    throw invalidInput('scope_ids exceeds the maximum number of retrieval scopes');
  }
  const scope_ids = [...new Set(input.scope_ids.map((value) => requireScopeId(value, 'scope_ids')))];
  if (!scope_ids.includes(scope)) {
    throw invalidInput('scope_ids must include the primary scope');
  }
  if (!Array.isArray(input.returned_ids) || input.returned_ids.length > RECALL_LIMIT_MAX) {
    throw invalidInput('returned_ids must be a bounded array');
  }
  const returned_ids = input.returned_ids.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidInput(`returned_ids[${index}] must be an object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'revision_id') {
      throw invalidInput(`returned_ids[${index}] must contain only id and revision_id`);
    }
    return {
      id: requireUuid(entry.id, `returned_ids[${index}].id`),
      revision_id: requireUuid(entry.revision_id, `returned_ids[${index}].revision_id`)
    };
  });
  if (!(RECALL_MODES as readonly string[]).includes(input.mode)) {
    throw invalidInput(`unknown retrieval mode ${String(input.mode)}`);
  }
  if (!(RETRIEVAL_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw invalidInput(`unknown retrieval outcome ${String(input.outcome)}`);
  }
  if (typeof input.partial !== 'boolean') {
    throw invalidInput('partial must be a boolean');
  }
  const item_count = requireFiniteCount(input.item_count, 'item_count');
  if (item_count !== returned_ids.length) {
    throw invalidInput('item_count must match the number of returned ids');
  }
  const token_used = requireFiniteCount(input.token_used, 'token_used');
  const token_limit = requireFiniteCount(input.token_limit, 'token_limit');
  if (token_limit <= 0 || token_used > token_limit) {
    throw invalidInput('token accounting must satisfy 0 <= token_used <= token_limit');
  }
  const duration_ms = requireFiniteCount(input.duration_ms, 'duration_ms');
  const created_at =
    input.created_at === undefined
      ? defaultTimestamp
      : requireTimestamp(input.created_at, 'created_at');
  return {
    retrieval_id,
    principal_id,
    scope,
    scope_ids,
    returned_ids,
    item_count,
    token_used,
    token_limit,
    mode: input.mode,
    outcome: input.outcome,
    partial: input.partial,
    duration_ms,
    created_at
  };
}

interface NormalizedFeedback {
  principal_id: string;
  idempotency_key: string;
  scope: string;
  logical_id: string;
  revision_id: string;
  retrieval_id: string | null;
  related_id: string | null;
  verdict: FeedbackVerdict;
  reason: string;
  warning: string | null;
  payload_hash: string;
}

function normalizeFeedback(input: FeedbackWrite): NormalizedFeedback {
  if (input === null || typeof input !== 'object') {
    throw invalidInput('feedback metadata must be an object');
  }
  const principal_id = requireActorId(input.principal_id, 'principal_id');
  const idempotency_key = requireUuid(input.idempotency_key, 'idempotency_key');
  const scope = requireScopeId(input.scope, 'scope');
  const logical_id = requireUuid(input.logical_id, 'logical_id');
  const revision_id = requireUuid(input.revision_id, 'revision_id');
  const retrieval_id =
    input.retrieval_id === undefined ? null : requireUuid(input.retrieval_id, 'retrieval_id');
  const related_id =
    input.related_id === undefined ? null : requireUuid(input.related_id, 'related_id');
  if (!(FEEDBACK_VERDICTS as readonly string[]).includes(input.verdict)) {
    throw invalidInput(`unknown feedback verdict ${String(input.verdict)}`);
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw invalidInput('reason must be a non-empty string');
  }
  if ([...input.reason].length > FEEDBACK_REASON_INPUT_MAX_LENGTH) {
    throw invalidInput('reason exceeds the feedback reason limit');
  }
  let warning: string | null = null;
  if (input.warning !== undefined) {
    if (
      typeof input.warning !== 'string' ||
      input.warning.trim().length === 0 ||
      input.warning.length > FEEDBACK_WARNING_MAX_LENGTH
    ) {
      throw invalidInput('warning must be a bounded non-empty string');
    }
    warning = input.warning;
  }
  const payload_hash = feedbackSemanticHash({
    principal_id,
    idempotency_key,
    scope,
    logical_id,
    revision_id,
    ...(retrieval_id === null ? {} : { retrieval_id }),
    ...(related_id === null ? {} : { related_id }),
    verdict: input.verdict,
    reason: input.reason,
    ...(warning === null ? {} : { warning })
  });
  return {
    principal_id,
    idempotency_key,
    scope,
    logical_id,
    revision_id,
    retrieval_id,
    related_id,
    verdict: input.verdict,
    reason: boundReason(input.reason),
    warning,
    payload_hash
  };
}

function feedbackMatches(row: FeedbackRow, normalized: NormalizedFeedback): boolean {
  if (row.payload_hash !== null) {
    return row.payload_hash === normalized.payload_hash;
  }
  return (
    row.scope === normalized.scope &&
    row.logical_id === normalized.logical_id &&
    row.revision_id === normalized.revision_id &&
    row.retrieval_id === normalized.retrieval_id &&
    row.related_id === normalized.related_id &&
    row.verdict === normalized.verdict &&
    row.reason === normalized.reason &&
    row.warning === normalized.warning
  );
}

function toRecord(row: OperationRow): OperationRecord {
  return {
    operation_id: row.operation_id,
    principal_id: row.principal_id,
    idempotency_key: row.idempotency_key,
    tool: row.tool,
    scope: row.scope,
    payload_hash: row.payload_hash,
    payload_json: row.payload_json,
    state: row.state as OperationState,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.plan_json === null ? {} : { plan_json: row.plan_json }),
    ...(row.receipt_json === null ? {} : { receipt_json: row.receipt_json })
  };
}

export class Journal {
  private readonly database: Database.Database;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private closed = false;

  private constructor(database: Database.Database, clock: Clock, ids: IdSource) {
    this.database = database;
    this.clock = clock;
    this.ids = ids;
  }

  static open(path: string, options: JournalOptions = {}): Journal {
    const clock = options.clock ?? systemClock;
    const ids = options.ids ?? systemIds;
    const requireExisting = options.requireExisting ?? false;
    const memory = path === ':memory:';
    if (requireExisting && !memory && !existsSync(path)) {
      throw recoveryRequired(
        `operation journal is missing at ${path}; explicit recovery is required`
      );
    }
    let database: Database.Database;
    try {
      database = new Database(path);
    } catch (cause) {
      throw recoveryRequired(`operation journal at ${path} cannot be opened`, cause);
    }
    try {
      database.pragma('foreign_keys = ON');
      database.pragma('synchronous = FULL');
      if (!memory) database.pragma('journal_mode = WAL');
      if (requireExisting && !memory && !hasTable(database, 'operations')) {
        throw recoveryRequired(
          `operation journal at ${path} has no schema; explicit recovery is required`
        );
      }
      applyMigrations(database, MIGRATIONS_DIRECTORY, clock.now().toISOString());
      Journal.backfillApprovalProvenance(database);
    } catch (error) {
      database.close();
      if (isBrainError(error)) throw error;
      throw recoveryRequired(`operation journal at ${path} cannot be initialized`, error);
    }
    const journal = new Journal(database, clock, ids);
    journal.resolveLegacyKeys();
    return journal;
  }

  resolveLegacyKeys(): void {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT * FROM brain_idempotency_keys WHERE origin = 'legacy' AND resolution = 'unresolved'"
      )
      .all() as IdempotencyKeyRow[];
    for (const row of rows) {
      try {
        const run = this.database.transaction((): void => {
          this.classifyLegacyKey(row);
        });
        run.immediate();
      } catch (error) {
        const resolution = keyResolutionOf(error);
        if (resolution !== undefined) this.markKeyOutcome(row.idempotency_key, resolution);
      }
    }
  }

  isKeyBlocked(idempotency_key: string): boolean {
    this.assertOpen();
    const key = this.getIdempotencyKey(idempotency_key);
    return (
      key !== undefined &&
      (key.resolution === 'conflict' || key.resolution === 'recovery_required')
    );
  }

  reserve(input: OperationReservation): ReservationResult {
    this.assertOpen();
    try {
      return this.reserveTransaction(input);
    } catch (error) {
      const resolution = keyResolutionOf(error);
      if (resolution !== undefined) this.markKeyOutcome(input.idempotency_key, resolution);
      throw error;
    }
  }

  private reserveTransaction(input: OperationReservation): ReservationResult {
    const run = this.database.transaction((value: OperationReservation): ReservationResult => {
      const key = this.getIdempotencyKey(value.idempotency_key);
      if (key !== undefined) return this.reserveAgainstKey(value, key);
      const timestamp = this.timestamp();
      const operation_id = this.ids.next();
      this.database
        .prepare(
          `INSERT INTO operations (
            operation_id, principal_id, idempotency_key, tool, scope, payload_hash,
            payload_json, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(principal_id, idempotency_key) DO NOTHING`
        )
        .run(
          operation_id,
          value.principal_id,
          value.idempotency_key,
          value.tool,
          value.scope,
          value.payload_hash,
          value.payload_json,
          'prepared',
          timestamp,
          timestamp
        );
      const stored = this.selectByKey(value.principal_id, value.idempotency_key);
      if (stored === undefined) {
        throw recoveryRequired(`operation ${operation_id} was not persisted`);
      }
      this.writeKeyBinding(value.idempotency_key, 'new', 'bound', {
        tool: value.tool,
        project_id: value.scope,
        payload_hash: value.payload_hash,
        target_kind: 'operation',
        target_id: stored.operation_id
      });
      this.clearOperationalLossAcknowledgement();
      if (stored.operation_id === operation_id) return { kind: 'new', record: stored };
      return { kind: 'replay', record: stored };
    });
    return run.immediate(input);
  }

  private reserveAgainstKey(
    input: OperationReservation,
    initial: IdempotencyKeyRow
  ): ReservationResult {
    let key = initial;
    if (key.resolution === 'unresolved') {
      key = this.classifyLegacyKey(key);
    }
    if (key.resolution === 'conflict') {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${input.idempotency_key} was used for a different request`
      });
    }
    if (key.resolution === 'recovery_required') {
      throw recoveryRequired(
        `idempotency key ${input.idempotency_key} has unverifiable historical records`
      );
    }
    if (key.resolution === 'released') {
      if (!this.matchesKeyFingerprint(key, input.tool, input.scope, input.payload_hash)) {
        throw new BrainError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `idempotency key ${input.idempotency_key} was released for a different request`
        });
      }
      const timestamp = this.timestamp();
      const operation_id = this.ids.next();
      this.database
        .prepare(
          `INSERT INTO operations (
            operation_id, principal_id, idempotency_key, tool, scope, payload_hash,
            payload_json, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          operation_id,
          input.principal_id,
          input.idempotency_key,
          input.tool,
          input.scope,
          input.payload_hash,
          input.payload_json,
          'prepared',
          timestamp,
          timestamp
        );
      const stored = this.selectByKey(input.principal_id, input.idempotency_key);
      if (stored === undefined) throw recoveryRequired(`operation ${operation_id} was not persisted`);
      this.database
        .prepare(
          `UPDATE brain_idempotency_keys
           SET resolution = 'bound', target_kind = 'operation', target_id = ?
           WHERE idempotency_key = ?`
        )
        .run(stored.operation_id, input.idempotency_key);
      this.clearOperationalLossAcknowledgement();
      return { kind: 'new', record: stored };
    }
    if (key.target_kind !== 'operation') {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${input.idempotency_key} was used for a different tool`
      });
    }
    if (!this.matchesKeyFingerprint(key, input.tool, input.scope, input.payload_hash)) {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${input.idempotency_key} was used for a different request`,
        ...(key.target_id === null ? {} : { operation_id: key.target_id })
      });
    }
    const targetId = key.target_id;
    if (targetId === null) {
      throw markResolution(
        recoveryRequired(`idempotency key ${input.idempotency_key} has no operation target`),
        'recovery_required'
      );
    }
    const record = this.get(targetId);
    if (record === undefined) {
      throw markResolution(
        recoveryRequired(`idempotency key ${input.idempotency_key} points at a missing operation`),
        'recovery_required'
      );
    }
    return { kind: 'replay', record };
  }

  private classifyLegacyKey(key: IdempotencyKeyRow): IdempotencyKeyRow {
    const members = this.listLegacyMembers(key.idempotency_key);
    if (members.length === 0) {
      throw markResolution(
        recoveryRequired(`idempotency key ${key.idempotency_key} has no historical members`),
        'recovery_required'
      );
    }
    const targets: {
      kind: 'operation' | 'feedback';
      id: string;
      tool: string;
      project: string;
      payload: string | null;
      receipt: string | null;
      signature: string;
    }[] = [];
    for (const member of members) {
      if (member.record_kind === 'operation') {
        const row = this.get(member.record_id);
        if (row === undefined) {
          throw markResolution(
            recoveryRequired(
              `idempotency key ${key.idempotency_key} references a missing operation`
            ),
            'recovery_required'
          );
        }
        const receipt =
          row.receipt_json === undefined || row.receipt_json === null || row.receipt_json === ''
            ? null
            : row.receipt_json;
        if (TERMINAL_STATES.includes(row.state) && receipt === null) {
          throw markResolution(
            recoveryRequired(
              `idempotency key ${key.idempotency_key} has a terminal operation without a receipt`
            ),
            'recovery_required'
          );
        }
        let canonical: string | null = null;
        if (receipt !== null) {
          try {
            const parsed = JSON.parse(receipt) as unknown;
            if (row.tool === 'brain_project_ensure') {
              const record = legacyProjectReceiptSchema.parse(parsed);
              const projectId = record.project_id ?? record.scope;
              if (
                record.operation_id !== row.operation_id ||
                projectId !== row.scope ||
                (record.project_id !== undefined && record.scope !== undefined && record.project_id !== record.scope)
              ) {
                throw new Error('project receipt identity does not match');
              }
              for (const raw of [row.payload_json, row.plan_json]) {
                if (raw === undefined || raw.length === 0) continue;
                const source = JSON.parse(raw) as unknown;
                if (source === null || typeof source !== 'object' || Array.isArray(source)) {
                  throw new Error('project identity source is invalid');
                }
                const values = source as Record<string, unknown>;
                if (
                  (values.repository_identity !== undefined &&
                    values.repository_identity !== record.repository_identity) ||
                  (values.project_id !== undefined && values.project_id !== projectId) ||
                  (values.scope !== undefined && values.scope !== projectId)
                ) {
                  throw new Error('project receipt does not match saved identity');
                }
              }
            } else {
              const record = legacyMutationReceiptSchema.parse(parsed);
              if (record.operation_id !== row.operation_id) {
                throw new Error('mutation receipt operation does not match');
              }
              if (row.plan_json !== undefined) {
                const plan = JSON.parse(row.plan_json) as unknown;
                if (
                  plan !== null && typeof plan === 'object' &&
                  'revision' in plan && plan.revision !== null && typeof plan.revision === 'object' &&
                  (('id' in plan.revision && plan.revision.id !== record.id) ||
                    ('revision_id' in plan.revision && plan.revision.revision_id !== record.revision_id))
                ) {
                  throw new Error('mutation receipt revision does not match plan');
                }
              }
            }
            canonical = canonicalJson(receipt);
          } catch (cause) {
            throw markResolution(
              recoveryRequired(
                `idempotency key ${key.idempotency_key} has an invalid receipt`,
                cause
              ),
              'recovery_required'
            );
          }
        }
        targets.push({
          kind: 'operation',
          id: row.operation_id,
          tool: row.tool,
          project: row.scope,
          payload: row.payload_hash,
          receipt: canonical,
          signature: JSON.stringify(['operation', row.tool, row.scope, row.payload_hash, canonical])
        });
      } else {
        const row = this.selectFeedbackRowById(member.record_id);
        if (row === undefined) {
          throw markResolution(
            recoveryRequired(
              `idempotency key ${key.idempotency_key} references a missing feedback record`
            ),
            'recovery_required'
          );
        }
        targets.push({
          kind: 'feedback',
          id: row.feedback_id,
          tool: 'brain_feedback',
          project: row.scope,
          payload: row.payload_hash,
          receipt: null,
          signature: JSON.stringify([
            'feedback',
            row.scope,
            row.logical_id,
            row.revision_id,
            row.verdict,
            row.reason,
            row.warning,
            row.payload_hash
          ])
        });
      }
    }
    if (targets.length > 1) {
      const receipts = targets.map((target) => target.receipt);
      const provablyEquivalent =
        receipts.every((receipt) => receipt !== null) &&
        new Set(receipts).size === 1 &&
        new Set(targets.map((target) => target.signature)).size === 1;
      if (!provablyEquivalent) {
        throw markResolution(
          new BrainError({
            code: 'IDEMPOTENCY_CONFLICT',
            message: `idempotency key ${key.idempotency_key} was reused with conflicting legacy records`
          }),
          'conflict'
        );
      }
    }
    const target = targets[0];
    this.database
      .prepare(
        `UPDATE brain_idempotency_keys
         SET resolution = 'bound', tool = ?, project_id = ?, payload_hash = ?,
             target_kind = ?, target_id = ?
         WHERE idempotency_key = ?`
      )
      .run(
        target.tool,
        target.project,
        target.payload,
        target.kind,
        target.id,
        key.idempotency_key
      );
    const updated = this.getIdempotencyKey(key.idempotency_key);
    if (updated === undefined) {
      throw recoveryRequired(`idempotency key ${key.idempotency_key} disappeared while binding`);
    }
    return updated;
  }

  private matchesKeyFingerprint(
    key: IdempotencyKeyRow,
    tool: string,
    projectId: string,
    payloadHash: string
  ): boolean {
    return (
      key.tool === tool && key.project_id === projectId && key.payload_hash === payloadHash
    );
  }

  private writeKeyBinding(
    idempotencyKey: string,
    origin: 'legacy' | 'new',
    resolution: 'unresolved' | 'bound' | 'conflict' | 'recovery_required' | 'released',
    fields: {
      tool: string | null;
      project_id: string | null;
      payload_hash: string | null;
      target_kind: string | null;
      target_id: string | null;
    }
  ): void {
    this.database
      .prepare(
        `INSERT INTO brain_idempotency_keys (
          idempotency_key, origin, resolution, tool, project_id, payload_hash, target_kind, target_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          origin = excluded.origin,
          resolution = excluded.resolution,
          tool = excluded.tool,
          project_id = excluded.project_id,
          payload_hash = excluded.payload_hash,
          target_kind = excluded.target_kind,
          target_id = excluded.target_id`
      )
      .run(
        idempotencyKey,
        origin,
        resolution,
        fields.tool,
        fields.project_id,
        fields.payload_hash,
        fields.target_kind,
        fields.target_id
      );
  }

  private setKeyResolution(
    idempotencyKey: string,
    resolution: 'unresolved' | 'bound' | 'conflict' | 'recovery_required' | 'released'
  ): void {
    this.database
      .prepare('UPDATE brain_idempotency_keys SET resolution = ? WHERE idempotency_key = ?')
      .run(resolution, idempotencyKey);
  }

  private markKeyOutcome(
    idempotencyKey: string,
    resolution: 'conflict' | 'recovery_required'
  ): void {
    try {
      if (this.getIdempotencyKey(idempotencyKey) !== undefined) {
        this.setKeyResolution(idempotencyKey, resolution);
      }
    } catch {
      return;
    }
  }

  private getIdempotencyKey(idempotency_key: string): IdempotencyKeyRow | undefined {
    return this.database
      .prepare('SELECT * FROM brain_idempotency_keys WHERE idempotency_key = ?')
      .get(idempotency_key) as IdempotencyKeyRow | undefined;
  }

  private listLegacyMembers(idempotency_key: string): LegacyMemberRow[] {
    return this.database
      .prepare(
        'SELECT * FROM legacy_idempotency_members WHERE idempotency_key = ? ORDER BY record_kind ASC, record_id ASC'
      )
      .all(idempotency_key) as LegacyMemberRow[];
  }

  reserveProject(input: ProjectReservation): ProjectReservationResult {
    this.assertOpen();
    const repositoryIdentity = requireProjectText(input.repository_identity, 'identity');
    const projectId = requireProjectText(input.project_id, 'project');
    const actorId = requireProjectText(input.created_by_actor_id, 'creator');
    const operationId = requireProjectText(input.creation_operation_id, 'operation');
    const displayName = requireProjectText(input.display_name ?? projectId, 'display name');
    const relativeRoot = requireProjectText(
      input.relative_root ?? `Projects/${projectId}`,
      'relative root'
    );
    const backendProject = requireProjectText(
      input.backend_project ?? projectId,
      'backend project'
    );
    const backendRelativeRoot = requireProjectText(
      input.backend_relative_root ?? relativeRoot,
      'backend relative root'
    );
    if (
      repositoryIdentity.includes('://') ||
      (repositoryIdentity.split('/', 1)[0]?.includes('@') ?? true) ||
      containsCredentials(repositoryIdentity) ||
      !SCOPE_ID_PATTERN.test(projectId)
    ) {
      throw invalidInput('project reservation is not normalized');
    }
    const normalized: ProjectReservation = {
      repository_identity: repositoryIdentity,
      project_id: projectId,
      display_name: displayName,
      relative_root: relativeRoot,
      backend_project: backendProject,
      backend_relative_root: backendRelativeRoot,
      created_by_actor_id: actorId,
      creation_operation_id: operationId
    };
    const run = this.database.transaction((): ProjectReservationResult => {
      const byIdentity = this.getProjectByIdentity(repositoryIdentity);
      if (byIdentity !== undefined) {
        return this.reconcileProjectReservation(normalized, byIdentity);
      }
      if (this.getProjectById(projectId) !== undefined) {
        throw conflict(`project ${projectId} is already bound to another repository`, operationId);
      }
      const timestamp = this.timestamp();
      this.database
        .prepare(
          `INSERT INTO projects_v2 (
            id, repository_identity, display_name, relative_root, legacy_scope,
            state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, 'provisioning', ?, ?)`
        )
        .run(projectId, repositoryIdentity, displayName, relativeRoot, timestamp, timestamp);
      this.database
        .prepare(
          `INSERT INTO project_provisioning (
            project_id, created_by_actor_id, creation_operation_id, failure_stage, failure_code
          ) VALUES (?, ?, ?, NULL, NULL)`
        )
        .run(projectId, actorId, operationId);
      this.database
        .prepare(
          `INSERT INTO legacy_project_backend_bindings (
            project_id, backend_project, backend_relative_root
          ) VALUES (?, ?, ?)`
        )
        .run(projectId, backendProject, backendRelativeRoot);
      const project = this.getProjectById(projectId);      if (project === undefined) throw recoveryRequired('project was not persisted');
      this.clearOperationalLossAcknowledgement();
      return { kind: 'new', project };
    });
    return run.immediate();
  }

  getProjectById(idText: string): PersistedProject | undefined {
    this.assertOpen();
    return this.readProject('id', idText);
  }

  getProjectByIdentity(repositoryIdentity: string): PersistedProject | undefined {
    this.assertOpen();
    return this.readProject('repository_identity', repositoryIdentity);
  }

  getProjectByLegacyScope(legacyScope: string): PersistedProject | undefined {
    this.assertOpen();
    return this.readProject('legacy_scope', legacyScope);
  }

  getProjectBinding(projectId: string): LegacyProjectBackendBinding | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM legacy_project_backend_bindings WHERE project_id = ?')
      .get(projectId) as ProjectBindingRow | undefined;
    return row === undefined ? undefined : toProjectBinding(row);
  }

  listProjectBindings(): { project_id: string; binding: LegacyProjectBackendBinding }[] {
    this.assertOpen();
    const rows = this.database
      .prepare('SELECT * FROM legacy_project_backend_bindings ORDER BY project_id ASC')
      .all() as ProjectBindingRow[];
    return rows.map((row) => ({ project_id: row.project_id, binding: toProjectBinding(row) }));
  }

  listReadyProjects(): PersistedProject[] {
    this.assertOpen();
    const rows = this.database
      .prepare(`SELECT * FROM projects_v2 WHERE state = 'ready' ORDER BY created_at ASC, id ASC`)
      .all() as ProjectRow[];
    return rows.map((row) => this.projectFromRow(row));
  }

  listProjects(): PersistedProject[] {
    this.assertOpen();
    const rows = this.database
      .prepare('SELECT * FROM projects_v2 ORDER BY created_at ASC, id ASC')
      .all() as ProjectRow[];
    return rows.map((row) => this.projectFromRow(row));
  }

  countProjects(): number {
    this.assertOpen();
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM projects_v2').get() as {
      count: number;
    };
    return row.count;
  }

  saveProjectPlan(id: string, plan: ProjectProvisioningPlan): void {
    this.savePlanJson(id, plan, false);
  }

  markProjectReady(identifier: string): PersistedProject {
    this.assertOpen();
    const run = this.database.transaction((): PersistedProject => {
      const project = this.requireProject(identifier);
      if (project.state === 'ready') return project;
      this.database
        .prepare(`UPDATE projects_v2 SET state = 'ready', updated_at = ? WHERE id = ?`)
        .run(this.timestamp(), project.project.id);
      this.database
        .prepare(
          'UPDATE project_provisioning SET failure_stage = NULL, failure_code = NULL WHERE project_id = ?'
        )
        .run(project.project.id);
      return this.requireProject(project.project.id);
    });
    return run.immediate();
  }

  markProjectRecoveryRequired(
    identifier: string,
    failureStage: string,
    failureCode: string
  ): PersistedProject {
    this.assertOpen();
    if (!FAILURE_STAGE_PATTERN.test(failureStage) || !FAILURE_CODE_PATTERN.test(failureCode)) {
      throw invalidInput('project recovery diagnostics must use sanitized codes');
    }
    const run = this.database.transaction((): PersistedProject => {
      const project = this.requireProject(identifier);
      this.database
        .prepare(`UPDATE projects_v2 SET state = 'recovery_required', updated_at = ? WHERE id = ?`)
        .run(this.timestamp(), project.project.id);
      this.database
        .prepare(
          'UPDATE project_provisioning SET failure_stage = ?, failure_code = ? WHERE project_id = ?'
        )
        .run(failureStage, failureCode, project.project.id);
      return this.requireProject(project.project.id);
    });
    return run.immediate();
  }

  savePlan(id: string, plan: PlannedWrite): void {
    this.savePlanJson(id, plan, true);
  }

  private savePlanJson(
    id: string,
    plan: PlannedWrite | ProjectProvisioningPlan,
    approval: boolean
  ): void {
    this.assertOpen();
    const payload = JSON.stringify(plan);
    const timestamp = this.timestamp();
    const run = this.database.transaction((): void => {
      const row = this.requireRow(id);
      const current = requireState(row.state, id);
      if (row.plan_json !== null) {
        if (row.plan_json === payload) return;
        throw conflict(`operation ${id} already has a different persisted plan`, id);
      }
      if (isTerminal(current)) {
        throw conflict(`operation ${id} is terminal; its plan is immutable`, id);
      }
      this.database
        .prepare('UPDATE operations SET plan_json = ?, updated_at = ? WHERE operation_id = ?')
        .run(payload, timestamp, id);
      if (approval) this.persistApprovalProvenance(id, plan as PlannedWrite);
    });
    run.immediate();
  }

  mark(id: string, state: OperationState, receipt?: MutationReceipt | ProjectEnsureResult): void {
    this.assertOpen();
    if (!OPERATION_STATES.includes(state)) {
      throw invalidInput(`unknown operation state ${String(state)}`);
    }
    const timestamp = this.timestamp();
    const run = this.database.transaction((): void => {
      const row = this.requireRow(id);
      const current = requireState(row.state, id);
      if (!ALLOWED_TRANSITIONS[current].includes(state)) {
        throw conflict(`operation ${id} cannot move from ${current} to ${state}`, id);
      }
      if (state === 'submitted' && row.plan_json === null) {
        throw conflict(`operation ${id} requires a saved plan before submission`, id);
      }
      if (receipt === undefined) {
        this.database
          .prepare('UPDATE operations SET state = ?, updated_at = ? WHERE operation_id = ?')
          .run(state, timestamp, id);
      } else {
        this.database
          .prepare(
            'UPDATE operations SET state = ?, receipt_json = ?, updated_at = ? WHERE operation_id = ?'
          )
          .run(state, JSON.stringify(receipt), timestamp, id);
      }
    });
    run.immediate();
  }

  refreshReceiptAvailability(id: string, availability: ReceiptAvailability): OperationRecord {
    this.assertOpen();
    const run = this.database.transaction((): OperationRecord => {
      const row = this.requireRow(id);
      const current = requireState(row.state, id);
      if (!isTerminal(current)) {
        throw conflict(`operation ${id} is not terminal; its receipt is not durable`, id);
      }
      if (row.receipt_json === null) {
        throw conflict(`operation ${id} has no receipt to refresh`, id);
      }
      let receipt: MutationReceipt;
      try {
        receipt = JSON.parse(row.receipt_json) as MutationReceipt;
      } catch (cause) {
        throw recoveryRequired(`operation ${id} has an unreadable receipt`, cause);
      }
      if (availability.materialized !== undefined) {
        receipt.materialized = availability.materialized;
      }
      if (availability.indexed !== undefined) {
        receipt.indexed = availability.indexed;
      }
      const updated = JSON.stringify(receipt);
      this.database
        .prepare('UPDATE operations SET receipt_json = ? WHERE operation_id = ?')
        .run(updated, id);
      return toRecord({ ...row, receipt_json: updated });
    });
    return run.immediate();
  }

  get(id: string): OperationRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM operations WHERE operation_id = ?')
      .get(id) as OperationRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  pending(): OperationRecord[] {
    this.assertOpen();
    const placeholders = TERMINAL_STATES.map(() => '?').join(', ');
    const rows = this.database
      .prepare(
        `SELECT * FROM operations WHERE state NOT IN (${placeholders}) ORDER BY created_at ASC, operation_id ASC`
      )
      .all(...TERMINAL_STATES) as OperationRow[];
    return rows.map(toRecord);
  }

  hasOperationalHistory(): boolean {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM operations LIMIT 1)
          OR EXISTS(SELECT 1 FROM feedback_records LIMIT 1) AS present`
      )
      .get() as { present: number };
    return row.present === 1;
  }

  acknowledgeOperationalLoss(): void {
    this.assertOpen();
    if (this.hasOperationalHistory()) {
      throw recoveryRequired('operational loss cannot be acknowledged while history exists');
    }
    this.database
      .prepare(
        `INSERT INTO runtime_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(OPERATIONAL_LOSS_ACKNOWLEDGEMENT, this.clock.now().toISOString());
  }

  hasOperationalLossAcknowledgement(): boolean {
    this.assertOpen();
    return (
      this.database.prepare('SELECT 1 FROM runtime_metadata WHERE key = ?').get(
        OPERATIONAL_LOSS_ACKNOWLEDGEMENT
      ) !== undefined
    );
  }

  getApprovalProvenance(operation_id: string): ApprovalProvenanceRecord | undefined {
    this.assertOpen();
    return this.database
      .prepare('SELECT * FROM operation_approvals WHERE operation_id = ?')
      .get(operation_id) as ApprovalProvenanceRecord | undefined;
  }

  storeReadCursor(payload_json: string, expires_at: string): number {
    this.assertOpen();
    const result = this.database
      .prepare('INSERT INTO read_cursors (payload_json, expires_at) VALUES (?, ?)')
      .run(payload_json, expires_at);
    return Number(result.lastInsertRowid);
  }

  updateReadCursor(cursor_id: number, payload_json: string, expires_at: string): void {
    this.assertOpen();
    const result = this.database
      .prepare('UPDATE read_cursors SET payload_json = ?, expires_at = ? WHERE cursor_id = ?')
      .run(payload_json, expires_at, cursor_id);
    if (result.changes !== 1) {
      throw recoveryRequired(`read cursor ${cursor_id} could not be finalized`);
    }
  }

  deleteReadCursor(cursor_id: number): void {
    this.assertOpen();
    this.database.prepare('DELETE FROM read_cursors WHERE cursor_id = ?').run(cursor_id);
  }

  getReadCursor(cursor_id: number): string | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT payload_json FROM read_cursors WHERE cursor_id = ?')
      .get(cursor_id) as { payload_json: string } | undefined;
    return row?.payload_json;
  }

  pruneReadCursors(now: Date): number {
    this.assertOpen();
    return this.database.prepare('DELETE FROM read_cursors WHERE expires_at < ?').run(now.toISOString())
      .changes;
  }

  abort(id: string): void {
    this.assertOpen();
    const run = this.database.transaction((): void => {
      const row = this.requireRow(id);
      const current = requireState(row.state, id);
      if (current !== 'prepared' || row.plan_json !== null || row.receipt_json !== null) {
        throw conflict(`operation ${id} is not an abortable prepared reservation`, id);
      }
      const key = this.getIdempotencyKey(row.idempotency_key);
      if (key !== undefined && key.origin === 'legacy') {
        this.database
          .prepare('UPDATE operations SET state = ?, updated_at = ? WHERE operation_id = ?')
          .run('failed', this.timestamp(), id);
        this.database
          .prepare(
            `UPDATE brain_idempotency_keys
             SET resolution = 'conflict'
             WHERE idempotency_key = ?`
          )
          .run(row.idempotency_key);
        return;
      }
      if (key !== undefined) {
        this.database
          .prepare(
            `UPDATE brain_idempotency_keys
             SET resolution = 'released', target_kind = NULL, target_id = NULL
             WHERE idempotency_key = ?`
          )
          .run(row.idempotency_key);
      }
      this.database.prepare('DELETE FROM operations WHERE operation_id = ?').run(id);
    });
    run.immediate();
  }

  pruneTerminalPayloads(now: Date): number {
    this.assertOpen();
    const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();
    const placeholders = PRUNABLE_STATES.map(() => '?').join(', ');
    const result = this.database
      .prepare(
        `UPDATE operations SET payload_json = '', plan_json = NULL
          WHERE state IN (${placeholders}) AND updated_at < ?
          AND (payload_json <> '' OR plan_json IS NOT NULL)`
      )
      .run(...PRUNABLE_STATES, cutoff);
    return result.changes;
  }

  recordRetrieval(input: RetrievalEventInput): RetrievalEvent {
    this.assertOpen();
    const record = normalizeRetrieval(input, this.timestamp());
    const run = this.database.transaction((): RetrievalEvent => {
      const existing = this.selectRetrieval(record.retrieval_id);
      if (existing !== undefined) return existing;
      this.database
        .prepare(
          `INSERT INTO retrieval_events (
            retrieval_id, principal_id, scope, scope_ids_json, returned_ids_json,
            item_count, token_used, token_limit, mode, outcome, partial, duration_ms,
            filter_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.retrieval_id,
          record.principal_id,
          record.scope,
          JSON.stringify(record.scope_ids),
          JSON.stringify(record.returned_ids),
          record.item_count,
          record.token_used,
          record.token_limit,
          record.mode,
          record.outcome,
          record.partial ? 1 : 0,
          record.duration_ms,
          JSON.stringify({ mode: 'project', identifier: record.scope }),
          record.created_at
        );
      return record;
    });
    return run.immediate();
  }

  getRetrieval(retrieval_id: string): RetrievalEvent | undefined {
    this.assertOpen();
    return this.selectRetrieval(retrieval_id);
  }

  recordRetrievalV2(input: RetrievalEventInputV2): RetrievalEventV2 {
    this.assertOpen();
    const record = normalizeRetrievalV2(input, this.timestamp());
    const run = this.database.transaction((): RetrievalEventV2 => {
      const existing = this.getRetrievalV2(record.retrieval_id);
      if (existing !== undefined) return existing;
      this.database
        .prepare(
          `INSERT INTO retrieval_events (
            retrieval_id, principal_id, scope, scope_ids_json, returned_ids_json,
            item_count, token_used, token_limit, mode, outcome, partial, duration_ms,
            filter_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.retrieval_id,
          record.actor_id,
          record.primary_project_id,
          JSON.stringify(record.searched_project_ids),
          JSON.stringify(record.returned_ids),
          record.item_count,
          record.token_used,
          record.token_limit,
          record.mode,
          record.outcome,
          record.partial ? 1 : 0,
          record.duration_ms,
          JSON.stringify(record.filter),
          record.created_at
        );
      return record;
    });
    return run.immediate();
  }

  getRetrievalV2(retrieval_id: string): RetrievalEventV2 | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM retrieval_events WHERE retrieval_id = ?')
      .get(retrieval_id) as RetrievalRow | undefined;
    return row === undefined ? undefined : toRetrievalV2(row);
  }

  pruneRetrievalEvents(now: Date): number {
    this.assertOpen();
    const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
    const result = this.database
      .prepare('DELETE FROM retrieval_events WHERE created_at < ?')
      .run(cutoff);
    return result.changes;
  }

  replayFeedback(input: FeedbackWrite): FeedbackWriteResult | undefined {
    this.assertOpen();
    const normalized = normalizeFeedback(input);
    try {
      const run = this.database.transaction((): FeedbackWriteResult | undefined => {
        const key = this.getIdempotencyKey(normalized.idempotency_key);
        if (key === undefined) return undefined;
        return this.resolveFeedbackKey(input, normalized, key);
      });
      return run.immediate();
    } catch (error) {
      this.markFeedbackFailure(normalized.idempotency_key, error);
      throw error;
    }
  }

  recordFeedback(input: FeedbackWrite): FeedbackWriteResult {
    this.assertOpen();
    const normalized = normalizeFeedback(input);
    try {
      const run = this.database.transaction((): FeedbackWriteResult => {
        const key = this.getIdempotencyKey(normalized.idempotency_key);
        if (key !== undefined) return this.resolveFeedbackKey(input, normalized, key);
        const feedback_id = this.ids.next();
        const created_at = this.timestamp();
        this.database
          .prepare(
            `INSERT INTO feedback_records (
              feedback_id, principal_id, idempotency_key, scope, logical_id, revision_id,
              retrieval_id, related_id, verdict, reason, warning, payload_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            feedback_id,
            normalized.principal_id,
            normalized.idempotency_key,
            normalized.scope,
            normalized.logical_id,
            normalized.revision_id,
            normalized.retrieval_id,
            normalized.related_id,
            normalized.verdict,
            normalized.reason,
            normalized.warning,
            normalized.payload_hash,
            created_at
          );
        const stored = this.selectFeedbackById(feedback_id);
        if (stored === undefined) {
          throw recoveryRequired(`feedback ${feedback_id} was not persisted`);
        }
        this.writeKeyBinding(normalized.idempotency_key, 'new', 'bound', {
          tool: 'brain_feedback',
          project_id: normalized.scope,
          payload_hash: normalized.payload_hash,
          target_kind: 'feedback',
          target_id: feedback_id
        });
        this.clearOperationalLossAcknowledgement();
        return { kind: 'new', entry: stored };
      });
      return run.immediate();
    } catch (error) {
      this.markFeedbackFailure(normalized.idempotency_key, error);
      throw error;
    }
  }

  private markFeedbackFailure(idempotencyKey: string, error: unknown): void {
    const resolution = keyResolutionOf(error);
    if (resolution !== undefined) this.markKeyOutcome(idempotencyKey, resolution);
  }

  private resolveFeedbackKey(
    raw: FeedbackWrite,
    normalized: NormalizedFeedback,
    initial: IdempotencyKeyRow
  ): FeedbackWriteResult {
    let key = initial;
    if (key.resolution === 'unresolved') key = this.classifyLegacyKey(key);
    if (key.resolution === 'conflict') {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${normalized.idempotency_key} was used for different feedback`
      });
    }
    if (key.resolution === 'recovery_required') {
      throw recoveryRequired(
        `idempotency key ${normalized.idempotency_key} has unverifiable historical records`
      );
    }
    if (key.resolution === 'released' || key.target_kind !== 'feedback') {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${normalized.idempotency_key} was used for a different tool`
      });
    }
    if (key.project_id !== normalized.scope) {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${normalized.idempotency_key} was used in a different project`
      });
    }
    const row = key.target_id === null ? undefined : this.selectFeedbackRowById(key.target_id);
    if (row === undefined) {
      throw markResolution(
        recoveryRequired(
          `idempotency key ${normalized.idempotency_key} points at a missing feedback record`
        ),
        'recovery_required'
      );
    }
    if (key.payload_hash !== null) {
      const expected =
        key.origin === 'legacy'
          ? legacyFeedbackHash(raw, row.principal_id)
          : feedbackSemanticHash(raw);
      if (expected !== key.payload_hash) {
        throw new BrainError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `idempotency key ${normalized.idempotency_key} was used for different feedback`
        });
      }
      return { kind: 'replay', entry: toFeedback(row) };
    }
    if (!feedbackMatches(row, normalized)) {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${normalized.idempotency_key} was used for different feedback`
      });
    }
    const storedAtBoundary = [...row.reason].length >= FEEDBACK_REASON_MAX_LENGTH;
    const incomingLonger = [...raw.reason].length > FEEDBACK_REASON_MAX_LENGTH;
    if (storedAtBoundary || incomingLonger) {
      throw markResolution(
        recoveryRequired(
          `idempotency key ${normalized.idempotency_key} cannot prove equality against a truncated historical reason`
        ),
        'recovery_required'
      );
    }
    return { kind: 'replay', entry: toFeedback(row) };
  }

  getFeedback(feedback_id: string): FeedbackEntry | undefined {
    this.assertOpen();
    return this.selectFeedbackById(feedback_id);
  }

  listFeedback(scope?: string): FeedbackEntry[] {
    this.assertOpen();
    const rows =
      scope === undefined
        ? (this.database
            .prepare('SELECT * FROM feedback_records ORDER BY created_at ASC, rowid ASC')
            .all() as FeedbackRow[])
        : (this.database
            .prepare(
              'SELECT * FROM feedback_records WHERE scope = ? ORDER BY created_at ASC, rowid ASC'
            )
            .all(scope) as FeedbackRow[]);
    return rows.map(toFeedback);
  }

  hasUnresolvedQualityConcern(scope: string, logical_id: string, revision_id: string): boolean {
    this.assertOpen();
    return (
      this.database
        .prepare(
          `SELECT 1 AS present FROM feedback_records
           WHERE scope = ? AND logical_id = ? AND revision_id = ? AND warning = ? LIMIT 1`
        )
        .get(scope, logical_id, revision_id, 'unresolved_quality_concern') !== undefined
    );
  }

  purgeFeedback(scope: string): number {
    this.assertOpen();
    const result = this.database.prepare('DELETE FROM feedback_records WHERE scope = ?').run(scope);
    return result.changes;
  }

  appendAudit(event: AuditEvent): AuditEventRecord {
    this.assertOpen();
    const keys = Object.keys(event);
    if (
      keys.length !== AUDIT_FIELDS.length ||
      !keys.every((key) => (AUDIT_FIELDS as readonly string[]).includes(key))
    ) {
      throw invalidInput('audit events are restricted to the content-free allowlist');
    }
    const request_id = requireAuditText(event.request_id, 'request_id');
    const tool = requireAuditText(event.tool, 'tool');
    const outcome = requireAuditText(event.outcome, 'outcome');
    const duration_ms = requireFiniteCount(event.duration_ms, 'duration_ms');
    const note_count = requireFiniteCount(event.note_count, 'note_count');
    const created_at = this.timestamp();
    this.database
      .prepare(
        `INSERT INTO audit_events (request_id, tool, outcome, duration_ms, note_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(request_id, tool, outcome, duration_ms, note_count, created_at);
    return { request_id, tool, outcome, duration_ms, note_count, created_at };
  }

  listAudit(): AuditEventRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare('SELECT * FROM audit_events ORDER BY created_at ASC, rowid ASC')
      .all() as AuditRow[];
    return rows.map(toAudit);
  }

  pruneAuditEvents(now: Date): number {
    this.assertOpen();
    const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
    const result = this.database
      .prepare('DELETE FROM audit_events WHERE created_at < ?')
      .run(cutoff);
    return result.changes;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private reconcileProjectReservation(
    value: ProjectReservation,
    existing: PersistedProject
  ): ProjectReservationResult {
    if (
      existing.project.id !== value.project_id ||
      existing.project.repository_identity !== value.repository_identity ||
      existing.provisioning.creation_operation_id !== value.creation_operation_id
    ) {
      throw conflict(
        'repository identity is already bound to a different project reservation',
        existing.provisioning.creation_operation_id
      );
    }
    return { kind: 'replay', project: existing };
  }

  private readProject(
    column: 'id' | 'repository_identity' | 'legacy_scope',
    value: string
  ): PersistedProject | undefined {
    const row = this.database
      .prepare(`SELECT * FROM projects_v2 WHERE ${column} = ?`)
      .get(value) as ProjectRow | undefined;
    return row === undefined ? undefined : this.projectFromRow(row);
  }

  private projectFromRow(row: ProjectRow): PersistedProject {
    const provisioning = this.database
      .prepare('SELECT * FROM project_provisioning WHERE project_id = ?')
      .get(row.id) as ProjectProvisioningRow | undefined;
    if (provisioning === undefined) {
      throw recoveryRequired(`project ${row.id} has no provisioning record`);
    }
    return toPersistedProject(row, provisioning);
  }

  private requireProject(identifier: string): PersistedProject {
    const project =
      this.getProjectById(identifier) ??
      this.getProjectByIdentity(identifier) ??
      this.getProjectByLegacyScope(identifier);
    if (project === undefined) {
      throw invalidInput('project does not exist');
    }
    return project;
  }

  private persistApprovalProvenance(id: string, plan: PlannedWrite): void {
    const approval = plan.revision.approval;
    if (approval === undefined) return;
    this.database
      .prepare(
        `INSERT INTO operation_approvals (
          operation_id, scope, logical_id, revision_id, principal_id, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO NOTHING`
      )
      .run(
        id,
        plan.revision.scope,
        plan.revision.id,
        plan.revision.revision_id,
        approval.principal_id,
        approval.payload_hash
      );
  }

  private clearOperationalLossAcknowledgement(): void {
    this.database
      .prepare('DELETE FROM runtime_metadata WHERE key = ?')
      .run(OPERATIONAL_LOSS_ACKNOWLEDGEMENT);
  }

  private static backfillApprovalProvenance(database: Database.Database): void {
    const rows = database
      .prepare('SELECT operation_id, plan_json FROM operations WHERE plan_json IS NOT NULL')
      .all() as { operation_id: string; plan_json: string }[];
    const insert = database.prepare(
      `INSERT INTO operation_approvals (
        operation_id, scope, logical_id, revision_id, principal_id, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO NOTHING`
    );
    const backfill = database.transaction(() => {
      for (const row of rows) {
        let plan: PlannedWrite;
        try {
          plan = JSON.parse(row.plan_json) as PlannedWrite;
        } catch {
          continue;
        }
        const revision = plan?.revision;
        const approval = revision?.approval;
        if (
          revision === undefined ||
          approval === undefined ||
          typeof revision.scope !== 'string' ||
          typeof revision.id !== 'string' ||
          typeof revision.revision_id !== 'string' ||
          typeof approval.principal_id !== 'string' ||
          typeof approval.payload_hash !== 'string'
        ) {
          continue;
        }
        insert.run(
          row.operation_id,
          revision.scope,
          revision.id,
          revision.revision_id,
          approval.principal_id,
          approval.payload_hash
        );
      }
    });
    backfill.immediate();
  }

  private selectByKey(principal_id: string, idempotency_key: string): OperationRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM operations WHERE principal_id = ? AND idempotency_key = ?')
      .get(principal_id, idempotency_key) as OperationRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  private selectRetrieval(retrieval_id: string): RetrievalEvent | undefined {
    const row = this.database
      .prepare('SELECT * FROM retrieval_events WHERE retrieval_id = ?')
      .get(retrieval_id) as RetrievalRow | undefined;
    return row === undefined ? undefined : toRetrieval(row);
  }

  private selectFeedbackById(feedback_id: string): FeedbackEntry | undefined {
    const row = this.selectFeedbackRowById(feedback_id);
    return row === undefined ? undefined : toFeedback(row);
  }

  private selectFeedbackRowById(feedback_id: string): FeedbackRow | undefined {
    return this.database
      .prepare('SELECT * FROM feedback_records WHERE feedback_id = ?')
      .get(feedback_id) as FeedbackRow | undefined;
  }

  private selectFeedbackRowByKey(
    principal_id: string,
    idempotency_key: string
  ): FeedbackRow | undefined {
    return this.database
      .prepare(
        'SELECT * FROM feedback_records WHERE principal_id = ? AND idempotency_key = ?'
      )
      .get(principal_id, idempotency_key) as FeedbackRow | undefined;
  }

  private requireRow(id: string): OperationRow {
    const row = this.database
      .prepare('SELECT * FROM operations WHERE operation_id = ?')
      .get(id) as OperationRow | undefined;
    if (row === undefined) throw notFound(id);
    return row;
  }

  private timestamp(): string {
    return this.clock.now().toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw invalidInput('operation journal is closed');
  }
}

export interface LocalWriteReservation {
  operation_id: string;
  idempotency_key: string;
  tool: string;
  path: string;
  payload_hash: string;
  source: string;
  expected_etag: string | null;
  id: string | null;
  revision_id: string | null;
  preimage_hash: string | null;
  revision_hash: string | null;
}

export type LocalWriteState =
  | 'prepared'
  | 'history_persisted'
  | 'materialized'
  | 'conflict'
  | 'complete'
  | 'failed';

export interface LocalWriteRecord extends LocalWriteReservation {
  state: LocalWriteState;
  indexed: boolean;
  receipt_json: string | null;
  updated_at: string;
}

export interface LocalDocumentRecord {
  path: string;
  id: string;
  revision_id: string;
  raw_hash: string;
  etag: string;
  updated_at: string;
}

export interface LocalIndexRecord {
  path: string;
  revision_id: string;
  raw_hash: string;
  enqueued_at: string;
}

export type LocalWriteReservationResult =
  | { kind: 'new'; record: LocalWriteRecord }
  | { kind: 'replay'; record: LocalWriteRecord };

export interface LocalMoveReservation {
  operation_id: string;
  idempotency_key: string;
  from_path: string;
  to_path: string;
  payload_hash: string;
  manifest_json: string;
}

export type LocalMoveState =
  | 'prepared'
  | 'manifest_persisted'
  | 'validated'
  | 'moved'
  | 'edits_applied'
  | 'records_updated'
  | 'complete'
  | 'conflict'
  | 'failed';

export interface LocalMoveRecord extends LocalMoveReservation {
  state: LocalMoveState;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalMoveFileRecord {
  operation_id: string;
  path: string;
  role: 'source' | 'edit';
  expected_hash: string;
  new_hash: string | null;
  new_raw: string | null;
  preimage_raw: string | Buffer;
  state: 'pending' | 'applied';
  updated_at: string;
}

export type LocalMoveReservationResult =
  | { kind: 'new'; record: LocalMoveRecord }
  | { kind: 'replay'; record: LocalMoveRecord };

export interface LocalMoveStepRecord {
  operation_id: string;
  ordinal: number;
  from_path: string;
  to_path: string;
  state: 'pending' | 'complete';
  updated_at: string;
}

export type LocalConsolidationState =
  | 'prepared'
  | 'history_persisted'
  | 'primary_applied'
  | 'references_applied'
  | 'removals_applied'
  | 'complete'
  | 'conflict'
  | 'failed'
  | 'recovery_required';

export interface LocalConsolidationRecord {
  operation_id: string;
  idempotency_key: string;
  logical_id: string;
  manifest_json: string;
  progress_json: string;
  state: LocalConsolidationState;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

export type LocalConsolidationReservationResult =
  | { kind: 'new'; record: LocalConsolidationRecord }
  | { kind: 'replay'; record: LocalConsolidationRecord };

interface LocalConsolidationRow {
  operation_id: string;
  idempotency_key: string;
  logical_id: string;
  manifest_json: string;
  progress_json: string;
  state: string;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalWriteRow {
  operation_id: string;
  idempotency_key: string;
  tool: string;
  path: string;
  payload_hash: string;
  source: string;
  expected_etag: string | null;
  id: string | null;
  revision_id: string | null;
  preimage_hash: string | null;
  revision_hash: string | null;
  state: string;
  indexed: number;
  receipt_json: string | null;
  updated_at: string;
}

interface LocalDocumentRow {
  path: string;
  id: string;
  revision_id: string;
  raw_hash: string;
  etag: string;
  updated_at: string;
}

interface LocalIndexRow {
  path: string;
  revision_id: string;
  raw_hash: string;
  enqueued_at: string;
}

interface LocalMoveRow {
  operation_id: string;
  idempotency_key: string;
  from_path: string;
  to_path: string;
  payload_hash: string;
  manifest_json: string;
  state: string;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

interface LocalMoveFileRow {
  operation_id: string;
  path: string;
  role: string;
  expected_hash: string;
  new_hash: string | null;
  new_raw: string | null;
  preimage_raw: string | Buffer;
  state: string;
  updated_at: string;
}

interface LocalMoveStepRow {
  operation_id: string;
  ordinal: number;
  from_path: string;
  to_path: string;
  state: string;
  updated_at: string;
}

const LOCAL_WRITE_STATES = [
  'prepared',
  'history_persisted',
  'materialized',
  'conflict',
  'complete',
  'failed'
] as const satisfies readonly LocalWriteState[];

function requireLocalWriteState(value: string): LocalWriteState {
  if ((LOCAL_WRITE_STATES as readonly string[]).includes(value)) {
    return value as LocalWriteState;
  }
  throw recoveryRequired('local write has an unknown stored state');
}

function toLocalWrite(row: LocalWriteRow): LocalWriteRecord {
  return {
    operation_id: row.operation_id,
    idempotency_key: row.idempotency_key,
    tool: row.tool,
    path: row.path,
    payload_hash: row.payload_hash,
    source: row.source,
    expected_etag: row.expected_etag,
    id: row.id,
    revision_id: row.revision_id,
    preimage_hash: row.preimage_hash,
    revision_hash: row.revision_hash,
    state: requireLocalWriteState(row.state),
    indexed: row.indexed === 1,
    receipt_json: row.receipt_json,
    updated_at: row.updated_at
  };
}

function toLocalDocument(row: LocalDocumentRow): LocalDocumentRecord {
  return {
    path: row.path,
    id: row.id,
    revision_id: row.revision_id,
    raw_hash: row.raw_hash,
    etag: row.etag,
    updated_at: row.updated_at
  };
}

function toLocalIndex(row: LocalIndexRow): LocalIndexRecord {
  return {
    path: row.path,
    revision_id: row.revision_id,
    raw_hash: row.raw_hash,
    enqueued_at: row.enqueued_at
  };
}

const LOCAL_MOVE_STATES = [
  'prepared',
  'manifest_persisted',
  'validated',
  'moved',
  'edits_applied',
  'records_updated',
  'complete',
  'conflict',
  'failed'
] as const satisfies readonly LocalMoveState[];

const LOCAL_MOVE_FILE_STATES = ['pending', 'applied'] as const;

function requireLocalMoveState(value: string): LocalMoveState {
  if ((LOCAL_MOVE_STATES as readonly string[]).includes(value)) {
    return value as LocalMoveState;
  }
  throw recoveryRequired('a local move has an unknown stored state');
}

function requireLocalMoveFileState(value: string): 'pending' | 'applied' {
  if ((LOCAL_MOVE_FILE_STATES as readonly string[]).includes(value)) {
    return value as 'pending' | 'applied';
  }
  throw recoveryRequired('a local move file has an unknown stored state');
}

function requireLocalMoveRole(value: string): 'source' | 'edit' {
  if (value === 'source' || value === 'edit') return value;
  throw recoveryRequired('a local move file has an unknown role');
}

function toLocalMove(row: LocalMoveRow): LocalMoveRecord {
  return {
    operation_id: row.operation_id,
    idempotency_key: row.idempotency_key,
    from_path: row.from_path,
    to_path: row.to_path,
    payload_hash: row.payload_hash,
    manifest_json: row.manifest_json,
    state: requireLocalMoveState(row.state),
    receipt_json: row.receipt_json,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toLocalMoveFile(row: LocalMoveFileRow): LocalMoveFileRecord {
  return {
    operation_id: row.operation_id,
    path: row.path,
    role: requireLocalMoveRole(row.role),
    expected_hash: row.expected_hash,
    new_hash: row.new_hash,
    new_raw: row.new_raw,
    preimage_raw: row.preimage_raw,
    state: requireLocalMoveFileState(row.state),
    updated_at: row.updated_at
  };
}

function requireLocalMoveStepState(value: string): 'pending' | 'complete' {
  if (value === 'pending' || value === 'complete') return value;
  throw recoveryRequired('a local move step has an unknown stored state');
}

function toLocalMoveStep(row: LocalMoveStepRow): LocalMoveStepRecord {
  return {
    operation_id: row.operation_id,
    ordinal: row.ordinal,
    from_path: row.from_path,
    to_path: row.to_path,
    state: requireLocalMoveStepState(row.state),
    updated_at: row.updated_at
  };
}

const LOCAL_CONSOLIDATION_STATES = [
  'prepared',
  'history_persisted',
  'primary_applied',
  'references_applied',
  'removals_applied',
  'complete',
  'conflict',
  'failed',
  'recovery_required'
] as const satisfies readonly LocalConsolidationState[];

function requireLocalConsolidationState(value: string): LocalConsolidationState {
  if ((LOCAL_CONSOLIDATION_STATES as readonly string[]).includes(value)) {
    return value as LocalConsolidationState;
  }
  throw recoveryRequired('a local consolidation has an unknown stored state');
}

function toLocalConsolidation(row: LocalConsolidationRow): LocalConsolidationRecord {
  return {
    operation_id: row.operation_id,
    idempotency_key: row.idempotency_key,
    logical_id: row.logical_id,
    manifest_json: row.manifest_json,
    progress_json: row.progress_json,
    state: requireLocalConsolidationState(row.state),
    receipt_json: row.receipt_json,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const LOCAL_WRITE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS local_write_operations (
     operation_id TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     tool TEXT NOT NULL,
     path TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     source TEXT NOT NULL,
     expected_etag TEXT,
     id TEXT,
     revision_id TEXT,
     preimage_hash TEXT,
     revision_hash TEXT,
     state TEXT NOT NULL,
     indexed INTEGER NOT NULL DEFAULT 0,
     receipt_json TEXT,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS local_documents (
     path TEXT PRIMARY KEY,
     id TEXT NOT NULL UNIQUE,
     revision_id TEXT NOT NULL,
     raw_hash TEXT NOT NULL,
     etag TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS local_index_queue (
     path TEXT PRIMARY KEY,
     revision_id TEXT NOT NULL,
     raw_hash TEXT NOT NULL,
     enqueued_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS local_move_operations (
     operation_id TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     from_path TEXT NOT NULL,
     to_path TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     manifest_json TEXT NOT NULL,
     state TEXT NOT NULL,
     receipt_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS local_move_files (
     operation_id TEXT NOT NULL,
     path TEXT NOT NULL,
     role TEXT NOT NULL,
     expected_hash TEXT NOT NULL,
     new_hash TEXT,
     new_raw TEXT,
     preimage_raw TEXT NOT NULL,
     state TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (operation_id, path, role)
   )`,
  `CREATE TABLE IF NOT EXISTS local_move_steps (
     operation_id TEXT NOT NULL,
     ordinal INTEGER NOT NULL,
     from_path TEXT NOT NULL,
     to_path TEXT NOT NULL,
     state TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (operation_id, ordinal)
   )`,
  `CREATE TABLE IF NOT EXISTS local_consolidations (
     operation_id TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     logical_id TEXT NOT NULL,
     manifest_json TEXT NOT NULL,
     progress_json TEXT NOT NULL,
     state TEXT NOT NULL,
     receipt_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`
];

export class LocalWriteJournal {
  private readonly database: Database.Database;
  private closed = false;

  private constructor(database: Database.Database) {
    this.database = database;
  }

  static open(path: string): LocalWriteJournal {
    let database: Database.Database;
    try {
      database = new Database(path);
    } catch (cause) {
      throw recoveryRequired(`local document journal at ${path} cannot be opened`, cause);
    }
    try {
      database.pragma('foreign_keys = ON');
      database.pragma('synchronous = FULL');
      if (path !== ':memory:') database.pragma('journal_mode = WAL');
      for (const statement of LOCAL_WRITE_SCHEMA) database.exec(statement);
    } catch (error) {
      database.close();
      if (isBrainError(error)) throw error;
      throw recoveryRequired(`local document journal at ${path} cannot be initialized`, error);
    }
    return new LocalWriteJournal(database);
  }

  reserve(input: LocalWriteReservation & { updated_at: string }): LocalWriteReservationResult {
    this.assertOpen();
    const existing = this.findByKey(input.idempotency_key);
    if (existing !== undefined) {
      if (existing.payload_hash !== input.payload_hash) {
        throw new BrainError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `idempotency key ${input.idempotency_key} was used for a different request`
        });
      }
      return { kind: 'replay', record: existing };
    }
    this.database
      .prepare(
        `INSERT INTO local_write_operations (
           operation_id, idempotency_key, tool, path, payload_hash, source,
           expected_etag, id, revision_id, preimage_hash, revision_hash, state, indexed, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?)`
      )
      .run(
        input.operation_id,
        input.idempotency_key,
        input.tool,
        input.path,
        input.payload_hash,
        input.source,
        input.expected_etag,
        input.id,
        input.revision_id,
        input.preimage_hash,
        input.revision_hash,
        input.updated_at
      );
    const stored = this.findById(input.operation_id);
    if (stored === undefined) throw recoveryRequired(`local write ${input.operation_id} was not persisted`);
    return { kind: 'new', record: stored };
  }

  update(
    operation_id: string,
    fields: Partial<
      Pick<
        LocalWriteRecord,
        'preimage_hash' | 'revision_hash' | 'state' | 'indexed' | 'receipt_json' | 'updated_at'
      >
    >
  ): LocalWriteRecord {
    this.assertOpen();
    const current = this.findById(operation_id);
    if (current === undefined) throw notFound(operation_id);
    const next = { ...current, ...fields };
    this.database
      .prepare(
        `UPDATE local_write_operations
           SET preimage_hash = ?, revision_hash = ?, state = ?, indexed = ?,
               receipt_json = ?, updated_at = ?
           WHERE operation_id = ?`
      )
      .run(
        next.preimage_hash,
        next.revision_hash,
        next.state,
        next.indexed ? 1 : 0,
        next.receipt_json,
        next.updated_at,
        operation_id
      );
    const stored = this.findById(operation_id);
    if (stored === undefined) throw recoveryRequired(`local write ${operation_id} disappeared`);
    return stored;
  }

  findByKey(idempotency_key: string): LocalWriteRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_write_operations WHERE idempotency_key = ?')
      .get(idempotency_key) as LocalWriteRow | undefined;
    return row === undefined ? undefined : toLocalWrite(row);
  }

  hasOperationWithPrefix(prefix: string): boolean {
    this.assertOpen();
    for (const table of ['local_write_operations', 'local_move_operations', 'local_consolidations']) {
      const row = this.database.prepare(
        `SELECT 1 FROM ${table} WHERE substr(idempotency_key, 1, ?) = ? LIMIT 1`
      ).get(prefix.length, prefix);
      if (row !== undefined) return true;
    }
    return false;
  }

  findById(operation_id: string): LocalWriteRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_write_operations WHERE operation_id = ?')
      .get(operation_id) as LocalWriteRow | undefined;
    return row === undefined ? undefined : toLocalWrite(row);
  }

  findByRevision(revision_id: string): LocalWriteRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_write_operations WHERE revision_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(revision_id) as LocalWriteRow | undefined;
    return row === undefined ? undefined : toLocalWrite(row);
  }

  listIncomplete(): LocalWriteRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT * FROM local_write_operations WHERE state NOT IN ('complete', 'conflict', 'failed') ORDER BY updated_at ASC, operation_id ASC"
      )
      .all() as LocalWriteRow[];
    return rows.map(toLocalWrite);
  }

  recordDocument(input: LocalDocumentRecord): void {
    this.assertOpen();
    this.database
      .prepare(
        `INSERT INTO local_documents (path, id, revision_id, raw_hash, etag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           id = excluded.id,
           revision_id = excluded.revision_id,
           raw_hash = excluded.raw_hash,
           etag = excluded.etag,
           updated_at = excluded.updated_at`
      )
      .run(input.path, input.id, input.revision_id, input.raw_hash, input.etag, input.updated_at);
  }

  findDocumentByPath(path: string): LocalDocumentRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_documents WHERE path = ?')
      .get(path) as LocalDocumentRow | undefined;
    return row === undefined ? undefined : toLocalDocument(row);
  }

  findDocumentById(id: string): LocalDocumentRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_documents WHERE id = ?')
      .get(id) as LocalDocumentRow | undefined;
    return row === undefined ? undefined : toLocalDocument(row);
  }

  deleteDocument(path: string): void {
    this.assertOpen();
    this.database.prepare('DELETE FROM local_documents WHERE path = ?').run(path);
  }

  moveDocument(input: LocalDocumentRecord, from: string): void {
    this.assertOpen();
    const apply = this.database.transaction((): void => {
      this.database.prepare('DELETE FROM local_documents WHERE path = ?').run(from);
      this.recordDocument(input);
    });
    apply.immediate();
  }

  enqueueIndex(input: LocalIndexRecord): void {
    this.assertOpen();
    this.database
      .prepare(
        `INSERT INTO local_index_queue (path, revision_id, raw_hash, enqueued_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           revision_id = excluded.revision_id,
           raw_hash = excluded.raw_hash,
           enqueued_at = excluded.enqueued_at`
      )
      .run(input.path, input.revision_id, input.raw_hash, input.enqueued_at);
  }

  listIndex(): LocalIndexRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare('SELECT * FROM local_index_queue ORDER BY enqueued_at ASC, path ASC')
      .all() as LocalIndexRow[];
    return rows.map(toLocalIndex);
  }

  dequeueIndex(path: string): void {
    this.assertOpen();
    this.database.prepare('DELETE FROM local_index_queue WHERE path = ?').run(path);
  }

  reserveMove(
    input: LocalMoveReservation & { created_at: string; updated_at: string },
    files: readonly LocalMoveFileRecord[],
    steps: readonly Omit<LocalMoveStepRecord, 'operation_id'>[]
  ): LocalMoveReservationResult {
    this.assertOpen();
    const existing = this.findMoveByKey(input.idempotency_key);
    if (existing !== undefined) {
      if (existing.payload_hash !== input.payload_hash) {
        throw new BrainError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `idempotency key ${input.idempotency_key} was used for a different move`
        });
      }
      return { kind: 'replay', record: existing };
    }
    const insertMove = this.database.prepare(
      `INSERT INTO local_move_operations (
         operation_id, idempotency_key, from_path, to_path, payload_hash, manifest_json,
         state, receipt_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`
    );
    const insertStep = this.database.prepare(
      `INSERT INTO local_move_steps (
         operation_id, ordinal, from_path, to_path, state, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const run = this.database.transaction((): void => {
      insertMove.run(
        input.operation_id,
        input.idempotency_key,
        input.from_path,
        input.to_path,
        input.payload_hash,
        input.manifest_json,
        input.created_at,
        input.updated_at
      );
      for (const file of files) this.insertMoveFile(file);
      for (const step of steps) {
        insertStep.run(
          input.operation_id,
          step.ordinal,
          step.from_path,
          step.to_path,
          step.state,
          step.updated_at
        );
      }
    });
    run.immediate();
    const stored = this.findMoveById(input.operation_id);
    if (stored === undefined) throw recoveryRequired(`local move ${input.operation_id} was not persisted`);
    return { kind: 'new', record: stored };
  }

  updateMove(
    operation_id: string,
    fields: Partial<Pick<LocalMoveRecord, 'state' | 'receipt_json' | 'updated_at'>>
  ): LocalMoveRecord {
    this.assertOpen();
    const current = this.findMoveById(operation_id);
    if (current === undefined) throw notFound(operation_id);
    const next = { ...current, ...fields };
    this.database
      .prepare(
        `UPDATE local_move_operations
           SET state = ?, receipt_json = ?, updated_at = ?
           WHERE operation_id = ?`
      )
      .run(next.state, next.receipt_json, next.updated_at, operation_id);
    const stored = this.findMoveById(operation_id);
    if (stored === undefined) throw recoveryRequired(`local move ${operation_id} disappeared`);
    return stored;
  }

  findMoveByKey(idempotency_key: string): LocalMoveRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_move_operations WHERE idempotency_key = ?')
      .get(idempotency_key) as LocalMoveRow | undefined;
    return row === undefined ? undefined : toLocalMove(row);
  }

  findMoveById(operation_id: string): LocalMoveRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_move_operations WHERE operation_id = ?')
      .get(operation_id) as LocalMoveRow | undefined;
    return row === undefined ? undefined : toLocalMove(row);
  }

  listIncompleteMoves(): LocalMoveRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT * FROM local_move_operations WHERE state NOT IN ('complete', 'conflict', 'failed') ORDER BY created_at ASC, operation_id ASC"
      )
      .all() as LocalMoveRow[];
    return rows.map(toLocalMove);
  }

  insertMoveFile(input: LocalMoveFileRecord): void {
    this.assertOpen();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO local_move_files (
           operation_id, path, role, expected_hash, new_hash, new_raw, preimage_raw, state, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.operation_id,
        input.path,
        input.role,
        input.expected_hash,
        input.new_hash,
        input.new_raw,
        input.preimage_raw,
        input.state,
        input.updated_at
      );
  }

  updateMoveFile(
    operation_id: string,
    path: string,
    role: 'source' | 'edit',
    state: 'pending' | 'applied',
    updated_at: string
  ): void {
    this.assertOpen();
    const result = this.database
      .prepare(
        `UPDATE local_move_files SET state = ?, updated_at = ?
         WHERE operation_id = ? AND path = ? AND role = ?`
      )
      .run(state, updated_at, operation_id, path, role);
    if (result.changes !== 1) {
      throw recoveryRequired(`local move file ${path} could not be updated`);
    }
  }

  listMoveFiles(operation_id: string): LocalMoveFileRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        `SELECT * FROM local_move_files WHERE operation_id = ?
         ORDER BY CASE role WHEN 'source' THEN 0 ELSE 1 END ASC, path ASC`
      )
      .all(operation_id) as LocalMoveFileRow[];
    return rows.map(toLocalMoveFile);
  }

  updateMoveStep(
    operation_id: string,
    ordinal: number,
    state: 'pending' | 'complete',
    updated_at: string
  ): void {
    this.assertOpen();
    const result = this.database
      .prepare(
        `UPDATE local_move_steps SET state = ?, updated_at = ?
         WHERE operation_id = ? AND ordinal = ?`
      )
      .run(state, updated_at, operation_id, ordinal);
    if (result.changes !== 1) {
      throw recoveryRequired(`local move step ${ordinal} could not be updated`);
    }
  }

  listMoveSteps(operation_id: string): LocalMoveStepRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare('SELECT * FROM local_move_steps WHERE operation_id = ? ORDER BY ordinal ASC')
      .all(operation_id) as LocalMoveStepRow[];
    return rows.map(toLocalMoveStep);
  }

  reserveConsolidation(
    input: {
      operation_id: string;
      idempotency_key: string;
      logical_id: string;
      manifest_json: string;
      created_at: string;
      updated_at: string;
    }
  ): LocalConsolidationReservationResult {
    this.assertOpen();
    const existing = this.findConsolidationByKey(input.idempotency_key);
    if (existing !== undefined) {
      if (existing.manifest_json !== input.manifest_json) {
        throw new BrainError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `idempotency key ${input.idempotency_key} was used for a different consolidation`
        });
      }
      return { kind: 'replay', record: existing };
    }
    this.database
      .prepare(
        `INSERT INTO local_consolidations (
           operation_id, idempotency_key, logical_id, manifest_json, progress_json,
           state, receipt_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, '{}', 'prepared', NULL, ?, ?)`
      )
      .run(
        input.operation_id,
        input.idempotency_key,
        input.logical_id,
        input.manifest_json,
        input.created_at,
        input.updated_at
      );
    const stored = this.findConsolidationById(input.operation_id);
    if (stored === undefined) {
      throw recoveryRequired(`local consolidation ${input.operation_id} was not persisted`);
    }
    return { kind: 'new', record: stored };
  }

  updateConsolidation(
    operation_id: string,
    fields: Partial<
      Pick<LocalConsolidationRecord, 'progress_json' | 'state' | 'receipt_json' | 'updated_at'>
    >
  ): LocalConsolidationRecord {
    this.assertOpen();
    const current = this.findConsolidationById(operation_id);
    if (current === undefined) throw notFound(operation_id);
    const next = { ...current, ...fields };
    this.database
      .prepare(
        `UPDATE local_consolidations
           SET progress_json = ?, state = ?, receipt_json = ?, updated_at = ?
           WHERE operation_id = ?`
      )
      .run(next.progress_json, next.state, next.receipt_json, next.updated_at, operation_id);
    const stored = this.findConsolidationById(operation_id);
    if (stored === undefined) throw recoveryRequired(`local consolidation ${operation_id} disappeared`);
    return stored;
  }

  findConsolidationByKey(idempotency_key: string): LocalConsolidationRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_consolidations WHERE idempotency_key = ?')
      .get(idempotency_key) as LocalConsolidationRow | undefined;
    return row === undefined ? undefined : toLocalConsolidation(row);
  }

  findConsolidationById(operation_id: string): LocalConsolidationRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_consolidations WHERE operation_id = ?')
      .get(operation_id) as LocalConsolidationRow | undefined;
    return row === undefined ? undefined : toLocalConsolidation(row);
  }

  listIncompleteConsolidations(): LocalConsolidationRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT * FROM local_consolidations WHERE state NOT IN ('complete', 'conflict', 'failed') ORDER BY created_at ASC, operation_id ASC"
      )
      .all() as LocalConsolidationRow[];
    return rows.map(toLocalConsolidation);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw invalidInput('local document journal is closed');
  }
}
export const LOCAL_OPERATION_STATES = [
  'pending',
  'finalized',
  'conflicted',
  'recovery_required'
] as const;

export type LocalOperationJournalState = (typeof LOCAL_OPERATION_STATES)[number];

export interface LocalOperationReservation {
  operation_id: string;
  idempotency_key: string;
  tool: string;
  action: string;
  project_id: string | null;
  payload_hash: string;
  payload_json: string;
}

export interface LocalOperationRecord extends LocalOperationReservation {
  plan_json: string | null;
  progress_json: string | null;
  state: LocalOperationJournalState;
  storage_key: string | null;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

export type LocalOperationReservationResult =
  | { kind: 'new'; record: LocalOperationRecord }
  | { kind: 'replay'; record: LocalOperationRecord };

interface LocalOperationRow {
  operation_id: string;
  idempotency_key: string;
  tool: string;
  action: string;
  project_id: string | null;
  payload_hash: string;
  payload_json: string;
  plan_json: string | null;
  progress_json: string | null;
  state: string;
  storage_key: string | null;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

const LOCAL_OPERATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS local_operations (
     operation_id TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     tool TEXT NOT NULL,
     action TEXT NOT NULL,
     project_id TEXT,
     payload_hash TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     plan_json TEXT,
     progress_json TEXT,
     state TEXT NOT NULL,
     storage_key TEXT,
     receipt_json TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS local_operations_state_idx
     ON local_operations (state, updated_at, operation_id)`,
  `CREATE TABLE IF NOT EXISTS local_subordinate_operations (
     operation_id TEXT NOT NULL,
     effect_index INTEGER NOT NULL,
     kind TEXT NOT NULL,
     key TEXT NOT NULL UNIQUE,
     document_operation_id TEXT,
     state TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (operation_id, effect_index)
    )`,
  `CREATE TABLE IF NOT EXISTS local_feedback_effects (
     operation_id TEXT PRIMARY KEY,
     feedback_id TEXT NOT NULL UNIQUE,
     id TEXT NOT NULL,
     revision_id TEXT NOT NULL,
     verdict TEXT NOT NULL,
     reason TEXT NOT NULL
   )`
];

function requireLocalOperationState(value: string): LocalOperationJournalState {
  if ((LOCAL_OPERATION_STATES as readonly string[]).includes(value)) {
    return value as LocalOperationJournalState;
  }
  throw recoveryRequired('local operation has an unknown stored state');
}

function toLocalOperation(row: LocalOperationRow): LocalOperationRecord {
  return {
    operation_id: row.operation_id,
    idempotency_key: row.idempotency_key,
    tool: row.tool,
    action: row.action,
    project_id: row.project_id,
    payload_hash: row.payload_hash,
    payload_json: row.payload_json,
    plan_json: row.plan_json,
    progress_json: row.progress_json,
    state: requireLocalOperationState(row.state),
    storage_key: row.storage_key,
    receipt_json: row.receipt_json,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export type LocalSubordinateState = 'reserved' | 'complete' | 'failed';

export interface LocalSubordinateRecord {
  operation_id: string;
  effect_index: number;
  kind: string;
  key: string;
  document_operation_id: string | null;
  state: LocalSubordinateState;
  created_at: string;
  updated_at: string;
}

export type LocalSubordinateReservationResult =
  | { kind: 'new'; record: LocalSubordinateRecord }
  | { kind: 'replay'; record: LocalSubordinateRecord };

interface LocalSubordinateRow {
  operation_id: string;
  effect_index: number;
  kind: string;
  key: string;
  document_operation_id: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

function requireLocalSubordinateState(value: string): LocalSubordinateState {
  if (value === 'reserved' || value === 'complete' || value === 'failed') return value;
  throw recoveryRequired('a local subordinate operation has an unknown stored state');
}

function toLocalSubordinate(row: LocalSubordinateRow): LocalSubordinateRecord {
  return {
    operation_id: row.operation_id,
    effect_index: row.effect_index,
    kind: row.kind,
    key: row.key,
    document_operation_id: row.document_operation_id,
    state: requireLocalSubordinateState(row.state),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export class LocalOperationJournal {
  private readonly database: Database.Database;
  private closed = false;

  private constructor(database: Database.Database) {
    this.database = database;
  }

  static open(path: string): LocalOperationJournal {
    let database: Database.Database;
    try {
      database = new Database(path);
    } catch (cause) {
      throw recoveryRequired(`local operation journal at ${path} cannot be opened`, cause);
    }
    try {
      database.pragma('foreign_keys = ON');
      database.pragma('synchronous = FULL');
      database.pragma('busy_timeout = 5000');
      if (path !== ':memory:') database.pragma('journal_mode = WAL');
      for (const statement of LOCAL_OPERATION_SCHEMA) database.exec(statement);
      try {
        database.exec('ALTER TABLE local_operations ADD COLUMN progress_json TEXT');
      } catch {
        undefined;
      }
      try {
        database.exec('ALTER TABLE local_subordinate_operations ADD COLUMN document_operation_id TEXT');
      } catch {
        undefined;
      }
    } catch (error) {
      database.close();
      if (isBrainError(error)) throw error;
      throw recoveryRequired(`local operation journal at ${path} cannot be initialized`, error);
    }
    return new LocalOperationJournal(database);
  }

  reserve(
    input: Omit<LocalOperationReservation, 'operation_id'> & { operation_id?: string; created_at: string; updated_at: string },
    allocateId?: () => string
  ): LocalOperationReservationResult {
    this.assertOpen();
    const reconcile = (): LocalOperationReservationResult | undefined => {
      const existing = this.findByKey(input.idempotency_key);
      if (existing === undefined) return undefined;
      if (existing.payload_hash !== input.payload_hash || existing.tool !== input.tool) {
        throw new BrainError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `idempotency key ${input.idempotency_key} was used for a different request`
        });
      }
      return { kind: 'replay', record: existing };
    };
    const run = this.database.transaction((): LocalOperationReservationResult => {
      const existing = reconcile();
      if (existing !== undefined) return existing;
      const operationId = input.operation_id ?? allocateId?.();
      if (operationId === undefined) throw recoveryRequired('a local operation identity is required');
      try {
        this.database
          .prepare(
            `INSERT INTO local_operations (
               operation_id, idempotency_key, tool, action, project_id,
               payload_hash, payload_json, plan_json, progress_json, state, storage_key,
               receipt_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?)`
          )
          .run(
            operationId,
            input.idempotency_key,
            input.tool,
            input.action,
            input.project_id,
            input.payload_hash,
            input.payload_json,
            input.created_at,
            input.updated_at
          );
      } catch (error) {
        const raced = reconcile();
        if (raced !== undefined) return raced;
        throw error;
      }
      const stored = this.findById(operationId);
      if (stored === undefined) {
        throw recoveryRequired(`local operation ${operationId} was not persisted`);
      }
      return { kind: 'new', record: stored };
    });
    return run.immediate();
  }

  recordFeedback(input: { operation_id: string; feedback_id: string; id: string;
    revision_id: string; verdict: string; reason: string }): void {
    this.assertOpen();
    const existing = this.getFeedbackEffect(input.operation_id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(input)) {
        throw recoveryRequired('the durable feedback effect disagrees with its plan');
      }
      return;
    }
    this.database.prepare(`INSERT INTO local_feedback_effects
      (operation_id, feedback_id, id, revision_id, verdict, reason) VALUES (?, ?, ?, ?, ?, ?)`).run(
      input.operation_id, input.feedback_id, input.id, input.revision_id, input.verdict, input.reason
    );
  }

  getFeedbackEffect(operationId: string): { operation_id: string; feedback_id: string; id: string;
    revision_id: string; verdict: string; reason: string } | undefined {
    this.assertOpen();
    return this.database.prepare('SELECT * FROM local_feedback_effects WHERE operation_id = ?').get(operationId) as
      { operation_id: string; feedback_id: string; id: string; revision_id: string;
        verdict: string; reason: string } | undefined;
  }

  reserveSubordinate(
    input: {
      operation_id: string;
      effect_index: number;
      kind: string;
      key: string;
      created_at: string;
      updated_at: string;
    }
  ): LocalSubordinateReservationResult {
    this.assertOpen();
    const existing = this.database
      .prepare('SELECT * FROM local_subordinate_operations WHERE key = ?')
      .get(input.key) as LocalSubordinateRow | undefined;
    if (existing !== undefined) {
      if (existing.operation_id !== input.operation_id || existing.effect_index !== input.effect_index) {
        throw new BrainError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `subordinate key ${input.key} is already bound to another effect`
        });
      }
      return { kind: 'replay', record: toLocalSubordinate(existing) };
    }
    this.database
      .prepare(
        `INSERT INTO local_subordinate_operations (
           operation_id, effect_index, kind, key, document_operation_id, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, 'reserved', ?, ?)`
      )
      .run(
        input.operation_id,
        input.effect_index,
        input.kind,
        input.key,
        input.created_at,
        input.updated_at
      );
    const stored = this.listSubordinates(input.operation_id).find(
      (entry) => entry.effect_index === input.effect_index
    );
    if (stored === undefined) {
      throw recoveryRequired(`subordinate operation ${input.key} was not persisted`);
    }
    return { kind: 'new', record: stored };
  }

  listSubordinates(operation_id: string): LocalSubordinateRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare('SELECT * FROM local_subordinate_operations WHERE operation_id = ? ORDER BY effect_index ASC')
      .all(operation_id) as LocalSubordinateRow[];
    return rows.map(toLocalSubordinate);
  }

  replaceLegacyConsolidationSubordinates(input: {
    operation_id: string;
    expected: readonly LocalSubordinateRecord[];
    key: string;
    document_operation_id: string | null;
    created_at: string;
    updated_at: string;
  }): void {
    this.assertOpen();
    try {
      this.database.transaction(() => {
        const current = this.listSubordinates(input.operation_id);
        if (JSON.stringify(current) !== JSON.stringify(input.expected)) {
          throw recoveryRequired('the historical subordinate rows changed during rebinding');
        }
        const occupying = this.findSubordinateByKey(input.key);
        if (occupying !== undefined && occupying.operation_id !== input.operation_id) {
          throw recoveryRequired('the historical consolidation key belongs to another operation');
        }
        this.database.prepare('DELETE FROM local_subordinate_operations WHERE operation_id = ?')
          .run(input.operation_id);
        this.database.prepare(
          `INSERT INTO local_subordinate_operations
             (operation_id, effect_index, kind, key, document_operation_id, state, created_at, updated_at)
           VALUES (?, 0, 'consolidation', ?, ?, 'reserved', ?, ?)`
        ).run(input.operation_id, input.key, input.document_operation_id, input.created_at, input.updated_at);
      }).immediate();
    } catch (error) {
      if (isBrainError(error)) throw error;
      throw recoveryRequired('the historical consolidation linkage could not be rebound', error);
    }
  }

  setSubordinateDocumentOperation(
    operation_id: string,
    effect_index: number,
    document_operation_id: string
  ): void {
    this.assertOpen();
    const result = this.database
      .prepare(
        `UPDATE local_subordinate_operations SET document_operation_id = ?, updated_at = ?
         WHERE operation_id = ? AND effect_index = ?
           AND (document_operation_id IS NULL OR document_operation_id = ?)`
      )
      .run(document_operation_id, new Date().toISOString(), operation_id, effect_index, document_operation_id);
    if (result.changes !== 1) {
      throw recoveryRequired(`subordinate effect ${effect_index} has conflicting document-operation linkage`);
    }
  }

  findSubordinateByKey(key: string): LocalSubordinateRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_subordinate_operations WHERE key = ?')
      .get(key) as LocalSubordinateRow | undefined;
    return row === undefined ? undefined : toLocalSubordinate(row);
  }

  deleteSubordinates(operation_id: string): void {
    this.assertOpen();
    this.database
      .prepare('DELETE FROM local_subordinate_operations WHERE operation_id = ?')
      .run(operation_id);
  }

  markSubordinate(operation_id: string, effect_index: number, state: LocalSubordinateState): void {
    this.assertOpen();
    this.database
      .prepare(
        `UPDATE local_subordinate_operations SET state = ?, updated_at = ?
         WHERE operation_id = ? AND effect_index = ?`
      )
      .run(state, new Date().toISOString(), operation_id, effect_index);
  }

  update(
    operation_id: string,
    fields: Partial<
      Pick<
        LocalOperationRecord,
        'plan_json' | 'progress_json' | 'state' | 'storage_key' | 'receipt_json' | 'updated_at'
      >
    >
  ): LocalOperationRecord {
    this.assertOpen();
    const current = this.findById(operation_id);
    if (current === undefined) throw notFound(operation_id);
    const next = { ...current, ...fields };
    this.database
      .prepare(
        `UPDATE local_operations
           SET plan_json = ?, progress_json = ?, state = ?, storage_key = ?, receipt_json = ?, updated_at = ?
           WHERE operation_id = ?`
      )
      .run(
        next.plan_json,
        next.progress_json,
        next.state,
        next.storage_key,
        next.receipt_json,
        next.updated_at,
        operation_id
      );
    const stored = this.findById(operation_id);
    if (stored === undefined) throw recoveryRequired(`local operation ${operation_id} disappeared`);
    return stored;
  }

  findById(operation_id: string): LocalOperationRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_operations WHERE operation_id = ?')
      .get(operation_id) as LocalOperationRow | undefined;
    return row === undefined ? undefined : toLocalOperation(row);
  }

  findByKey(idempotency_key: string): LocalOperationRecord | undefined {
    this.assertOpen();
    const row = this.database
      .prepare('SELECT * FROM local_operations WHERE idempotency_key = ?')
      .get(idempotency_key) as LocalOperationRow | undefined;
    return row === undefined ? undefined : toLocalOperation(row);
  }

  listIncomplete(): LocalOperationRecord[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        "SELECT * FROM local_operations WHERE state NOT IN ('finalized', 'conflicted') ORDER BY updated_at ASC, operation_id ASC"
      )
      .all() as LocalOperationRow[];
    return rows.map(toLocalOperation);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw invalidInput('local operation journal is closed');
  }
}
