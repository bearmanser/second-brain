import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { uuidSchema } from '../contracts/content.js';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { RECALL_MAX_SCOPES, RECALL_LIMIT_MAX, SCOPE_ID_PATTERN } from '../core/limits.js';
import {
  FEEDBACK_VERDICTS,
  RECALL_MODES,
  type Clock,
  type FeedbackVerdict,
  type IdSource,
  type MutationReceipt,
  type PlannedWrite,
  type RecallMode
} from '../core/types.js';
import { containsCredentials } from '../security/redact.js';

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

export const AUDIT_FIELDS = ['request_id', 'tool', 'outcome', 'duration_ms', 'note_count'] as const;
export type AuditField = (typeof AUDIT_FIELDS)[number];

export const RETRIEVAL_OUTCOMES = ['ok', 'partial', 'error'] as const;
export type RetrievalOutcome = (typeof RETRIEVAL_OUTCOMES)[number];

export const FEEDBACK_REASON_MAX_LENGTH = 240;
export const FEEDBACK_REASON_INPUT_MAX_LENGTH = 8000;

const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
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

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface ReceiptAvailability {
  materialized?: boolean;
  indexed?: boolean;
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
  scope: string;
  scope_ids_json: string;
  returned_ids_json: string;
  item_count: number;
  token_used: number;
  token_limit: number;
  mode: string;
  outcome: string;
  partial: number;
  duration_ms: number;
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

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
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
    scope: row.scope,
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
  const principal_id = requireUuid(input.principal_id, 'principal_id');
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
  const principal_id = requireUuid(input.principal_id, 'principal_id');
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
  const payload = {
    principal_id,
    idempotency_key,
    scope,
    logical_id,
    revision_id,
    retrieval_id,
    related_id,
    verdict: input.verdict,
    reason: input.reason,
    warning
  };
  const payload_hash = createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
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
    } catch (error) {
      database.close();
      if (isBrainError(error)) throw error;
      throw recoveryRequired(`operation journal at ${path} cannot be initialized`, error);
    }
    return new Journal(database, clock, ids);
  }

  reserve(input: OperationReservation): ReservationResult {
    this.assertOpen();
    const run = this.database.transaction((value: OperationReservation): ReservationResult => {
      const existing = this.selectByKey(value.principal_id, value.idempotency_key);
      if (existing !== undefined) return this.reconcile(value, existing);
      const operation_id = this.ids.next();
      const timestamp = this.timestamp();
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
      if (stored.operation_id === operation_id) return { kind: 'new', record: stored };
      return this.reconcile(value, stored);
    });
    return run.immediate(input);
  }

  savePlan(id: string, plan: PlannedWrite): void {
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
    });
    run.immediate();
  }

  mark(id: string, state: OperationState, receipt?: MutationReceipt): void {
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

  abort(id: string): void {
    this.assertOpen();
    const run = this.database.transaction((): void => {
      const row = this.requireRow(id);
      const current = requireState(row.state, id);
      if (current !== 'prepared' || row.plan_json !== null || row.receipt_json !== null) {
        throw conflict(`operation ${id} is not an abortable prepared reservation`, id);
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
            item_count, token_used, token_limit, mode, outcome, partial, duration_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    const existing = this.selectFeedbackRowByKey(normalized.principal_id, normalized.idempotency_key);
    if (existing === undefined) return undefined;
    if (!feedbackMatches(existing, normalized)) {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${normalized.idempotency_key} was used for different feedback`
      });
    }
    return { kind: 'replay', entry: toFeedback(existing) };
  }

  recordFeedback(input: FeedbackWrite): FeedbackWriteResult {
    this.assertOpen();
    const normalized = normalizeFeedback(input);
    const run = this.database.transaction((): FeedbackWriteResult => {
      const existing = this.selectFeedbackRowByKey(
        normalized.principal_id,
        normalized.idempotency_key
      );
      if (existing !== undefined) {
        if (!feedbackMatches(existing, normalized)) {
          throw new BrainError({
            code: 'IDEMPOTENCY_CONFLICT',
            message: `idempotency key ${normalized.idempotency_key} was used for different feedback`
          });
        }
        return { kind: 'replay', entry: toFeedback(existing) };
      }
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
      return { kind: 'new', entry: stored };
    });
    return run.immediate();
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

  private reconcile(value: OperationReservation, existing: OperationRecord): ReservationResult {
    if (
      existing.payload_hash !== value.payload_hash ||
      existing.scope !== value.scope
    ) {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${value.idempotency_key} was used for a different request`,
        operation_id: existing.operation_id
      });
    }
    return { kind: 'replay', record: existing };
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
