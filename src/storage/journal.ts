import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { BrainError, isBrainError } from '../contracts/errors.js';
import type { Clock, IdSource, MutationReceipt, PlannedWrite } from '../core/types.js';

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
const MIGRATION_FILE_PATTERN = /^(\d+)-[a-z0-9-]+\.sql$/;

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url));

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
