import Database from 'better-sqlite3';
import { uuidSchema } from '../contracts/content.js';
import { BrainError, isBrainError } from '../contracts/errors.js';
import {
  LIFECYCLES,
  NOTE_KINDS,
  type CataloguePort,
  type Clock,
  type Head,
  type Lifecycle,
  type NoteKind,
  type ScopeConfig,
  type SourceRef,
  type StoredRevision,
  type VaultPort
} from '../core/types.js';
import { applyMigrations, MIGRATIONS_DIRECTORY } from '../storage/journal.js';
import { decodeRevision, makeEtag, payloadHash } from './codec.js';

export interface ParsedRevision {
  revision: StoredRevision;
  raw_hash: string;
  relative_path: string;
}

export type HeadResolution =
  | { state: 'ready'; head: ParsedRevision }
  | { state: 'conflict'; reasons: string[]; heads: ParsedRevision[] };

export type CatalogueState =
  | 'ready'
  | 'manual_unreviewed'
  | 'conflict'
  | 'malformed'
  | 'unsupported_schema';

export interface CatalogueOptions {
  vault: VaultPort;
  scopes: ScopeConfig[];
  clock?: Clock;
}

const LIST_PAGE_SIZE = 50;

interface RevisionRow {
  scope: string;
  relative_path: string;
  revision_id: string | null;
  logical_id: string | null;
  raw_hash: string;
  title: string | null;
  kind: string | null;
  stored_status: string | null;
  effective_status: string | null;
  state: string;
  is_head: number;
  warnings_json: string;
  observed_at: string;
}

interface ParentRow {
  scope: string;
  revision_id: string;
  parent_revision_id: string;
  parent_raw_hash: string;
}

interface PeekedIdentity {
  logicalId?: string;
  revisionId?: string;
  scope?: string;
  status?: string;
  title?: string;
  kind?: string;
}

interface Observation {
  scope: string;
  path: string;
  raw_hash: string;
  revision?: StoredRevision;
  identity?: PeekedIdentity;
  state?: CatalogueState;
  warnings?: string[];
}

interface LoadedRows {
  parsed: ParsedRevision[];
  failures: { row: RevisionRow; state: string; reason: string }[];
}

const systemClock: Clock = { now: () => new Date() };

function conflict(message: string, code: 'CONFLICT' | 'RECOVERY_REQUIRED' = 'CONFLICT'): BrainError {
  return new BrainError({ code, message });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

function forbidden(message: string): BrainError {
  return new BrainError({ code: 'FORBIDDEN', message });
}

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function unsupportedSchema(message: string): BrainError {
  return new BrainError({ code: 'UNSUPPORTED_SCHEMA', message });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareText(left: string | null, right: string | null): number {
  const a = left ?? '';
  const b = right ?? '';
  return a < b ? -1 : a > b ? 1 : 0;
}

export function resolveHead(revisions: ParsedRevision[]): HeadResolution {
  if (revisions.length === 0) {
    return { state: 'conflict', reasons: ['empty'], heads: [] };
  }
  const reasons: string[] = [];
  const seenRevisionIds = new Set<string>();
  for (const item of revisions) {
    if (seenRevisionIds.has(item.revision.revision_id)) reasons.push('duplicate_revision_id');
    seenRevisionIds.add(item.revision.revision_id);
  }
  if (new Set(revisions.map((item) => item.revision.id)).size > 1) {
    reasons.push('multiple_logical_ids');
  }
  if (new Set(revisions.map((item) => item.revision.scope)).size > 1) {
    reasons.push('multiple_scopes');
  }
  const byRevisionId = new Map(revisions.map((item) => [item.revision.revision_id, item]));
  for (const item of revisions) {
    for (const parent of item.revision.parents) {
      const target = byRevisionId.get(parent.revision_id);
      if (target === undefined) {
        reasons.push('missing_parent');
      } else if (target.raw_hash !== parent.raw_hash) {
        reasons.push('parent_hash_mismatch');
      }
    }
  }
  if (hasCycle(revisions)) reasons.push('cycle');

  const parentIds = new Set(
    revisions.flatMap((item) => item.revision.parents.map((parent) => parent.revision_id))
  );
  const heads = revisions.filter((item) => !parentIds.has(item.revision.revision_id));

  if (reasons.length > 0) {
    return { state: 'conflict', reasons: unique(reasons), heads: heads.length > 0 ? heads : revisions };
  }
  if (heads.length !== 1) {
    return { state: 'conflict', reasons: ['fork'], heads };
  }
  return { state: 'ready', head: heads[0] };
}

function hasCycle(revisions: ParsedRevision[]): boolean {
  const parents = new Map<string, string[]>();
  for (const item of revisions) {
    parents.set(
      item.revision.revision_id,
      item.revision.parents.map((parent) => parent.revision_id)
    );
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const parent of parents.get(id) ?? []) {
      if (parents.has(parent) && visit(parent)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const id of parents.keys()) {
    if (visit(id)) return true;
  }
  return false;
}

function splitFrontmatterText(raw: string): string | undefined {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index;
      break;
    }
  }
  if (close === -1) return undefined;
  return lines.slice(1, close).join('\n');
}

function peekValue(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
  if (match === null) return undefined;
  const value = match[1].trim().replace(/^["']|["']$/g, '');
  return value.length > 0 ? value : undefined;
}

function peekIdentity(raw: string): PeekedIdentity {
  const frontmatter = splitFrontmatterText(raw);
  if (frontmatter === undefined) return {};
  return {
    logicalId: peekValue(frontmatter, 'brain_id'),
    revisionId: peekValue(frontmatter, 'brain_revision_id'),
    scope: peekValue(frontmatter, 'brain_scope'),
    status: peekValue(frontmatter, 'brain_status'),
    title: peekValue(frontmatter, 'brain_title'),
    kind: peekValue(frontmatter, 'type')
  };
}

function parseWarnings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return ['unreadable_warnings'];
  }
  return [];
}

function asLifecycle(value: string | null | undefined): Lifecycle {
  return (LIFECYCLES as readonly string[]).includes(value ?? '') ? (value as Lifecycle) : 'candidate';
}

export class RevisionCatalogue implements CataloguePort {
  private readonly database: Database.Database;
  private readonly vault: VaultPort;
  private readonly scopes: Set<string>;
  private readonly clock: Clock;
  private closed = false;

  private constructor(
    database: Database.Database,
    vault: VaultPort,
    scopes: Set<string>,
    clock: Clock
  ) {
    this.database = database;
    this.vault = vault;
    this.scopes = scopes;
    this.clock = clock;
  }

  static open(path: string, options: CatalogueOptions): RevisionCatalogue {
    const clock = options.clock ?? systemClock;
    let database: Database.Database;
    try {
      database = new Database(path);
    } catch (cause) {
      throw conflict(`catalogue database at ${path} cannot be opened`, 'RECOVERY_REQUIRED');
    }
    try {
      database.pragma('foreign_keys = ON');
      database.pragma('synchronous = FULL');
      if (path !== ':memory:') database.pragma('journal_mode = WAL');
      applyMigrations(database, MIGRATIONS_DIRECTORY, clock.now().toISOString());
    } catch (error) {
      database.close();
      if (isBrainError(error)) throw error;
      throw conflict(`catalogue database at ${path} cannot be initialized`, 'RECOVERY_REQUIRED');
    }
    return new RevisionCatalogue(
      database,
      options.vault,
      new Set(options.scopes.map((scope) => scope.id)),
      clock
    );
  }

  async reconcile(scope: string): Promise<void> {
    this.assertOpen();
    this.requireScope(scope);
    const paths = await this.vault.list(scope);
    const observations: Observation[] = [];
    for (const path of paths) {
      try {
        const read = await this.vault.read(scope, path);
        try {
          const revision = decodeRevision(read.raw);
          observations.push({ scope, path, raw_hash: read.raw_hash, revision });
        } catch (error) {
          const code = isBrainError(error) ? error.code : 'INVALID_INPUT';
          observations.push({
            scope,
            path,
            raw_hash: read.raw_hash,
            identity: peekIdentity(read.raw),
            state: code === 'UNSUPPORTED_SCHEMA' ? 'unsupported_schema' : 'malformed',
            warnings: [code === 'UNSUPPORTED_SCHEMA' ? 'unsupported_schema' : 'malformed']
          });
        }
      } catch (error) {
        if (isBrainError(error) && error.code === 'LIMIT_EXCEEDED') {
          observations.push({
            scope,
            path,
            raw_hash: '',
            state: 'malformed',
            warnings: ['oversized']
          });
          continue;
        }
        throw error;
      }
    }

    const rows: RevisionRow[] = [];
    const parents: ParentRow[] = [];
    const observedAt = this.clock.now().toISOString();
    const parsed = observations.filter(
      (item): item is Observation & { revision: StoredRevision } => item.revision !== undefined
    );
    const globalRevisionLocations = new Map<string, number>();
    for (const item of parsed) {
      globalRevisionLocations.set(
        item.revision.revision_id,
        (globalRevisionLocations.get(item.revision.revision_id) ?? 0) + 1
      );
    }

    const groups = new Map<string, (Observation & { revision: StoredRevision })[]>();
    for (const item of parsed) {
      const group = groups.get(item.revision.id) ?? [];
      group.push(item);
      groups.set(item.revision.id, group);
    }

    for (const group of groups.values()) {
      const groupWarnings: string[] = [];
      const seen = new Set<string>();
      for (const item of group) {
        if (seen.has(item.revision.revision_id)) groupWarnings.push('duplicate_identity');
        seen.add(item.revision.revision_id);
        if (item.revision.scope !== scope) groupWarnings.push('scope_mismatch');
        if ((globalRevisionLocations.get(item.revision.revision_id) ?? 0) > 1) {
          groupWarnings.push('duplicate_identity');
        }
      }
      const resolution = resolveHead(
        group.map((item) => ({
          revision: item.revision,
          raw_hash: item.raw_hash,
          relative_path: item.path
        }))
      );
      const structural = unique(groupWarnings);
      const conflictingPaths = new Set<string>();
      let conflictWarnings: string[] = [];
      if (resolution.state === 'conflict') {
        conflictWarnings = unique([...structural, ...resolution.reasons, 'conflict']);
        for (const head of resolution.heads) conflictingPaths.add(head.relative_path);
        if (structural.length > 0) {
          for (const item of group) conflictingPaths.add(item.path);
        }
      } else if (structural.length > 0) {
        conflictWarnings = unique([...structural, 'conflict']);
        for (const item of group) conflictingPaths.add(item.path);
      }
      const headRevisionId =
        resolution.state === 'ready' ? resolution.head.revision.revision_id : undefined;
      for (const item of group) {
        const revision = item.revision;
        const approvalChanged =
          revision.approval !== undefined && revision.approval.payload_hash !== payloadHash(revision);
        const isConflict = conflictingPaths.has(item.path);
        const warnings = isConflict
          ? conflictWarnings
          : approvalChanged
            ? ['manual_unreviewed']
            : [];
        const state: CatalogueState = isConflict
          ? 'conflict'
          : approvalChanged
            ? 'manual_unreviewed'
            : 'ready';
        rows.push({
          scope,
          relative_path: item.path,
          revision_id: revision.revision_id,
          logical_id: revision.id,
          raw_hash: item.raw_hash,
          title: revision.note.title,
          kind: revision.note.content.kind,
          stored_status: revision.status,
          effective_status: approvalChanged ? 'candidate' : revision.status,
          state,
          is_head: !isConflict && headRevisionId === revision.revision_id ? 1 : 0,
          warnings_json: JSON.stringify(warnings),
          observed_at: observedAt
        });
        for (const parent of revision.parents) {
          parents.push({
            scope,
            revision_id: revision.revision_id,
            parent_revision_id: parent.revision_id,
            parent_raw_hash: parent.raw_hash
          });
        }
      }
    }

    for (const item of observations) {
      if (item.revision !== undefined) continue;
      const identity = item.identity ?? {};
      rows.push({
        scope,
        relative_path: item.path,
        revision_id: identity.revisionId ?? null,
        logical_id: identity.logicalId ?? null,
        raw_hash: item.raw_hash,
        title: identity.title ?? null,
        kind: identity.kind ?? null,
        stored_status: identity.status ?? null,
        effective_status: asLifecycle(identity.status),
        state: item.state ?? 'malformed',
        is_head: 0,
        warnings_json: JSON.stringify(item.warnings ?? ['malformed']),
        observed_at: observedAt
      });
    }

    this.persist(scope, rows, parents);
    this.normalizeDuplicateConflicts();
  }

  async get(scope: string, id: string): Promise<Head> {
    this.assertOpen();
    this.requireScope(scope);
    const rows = this.rowsForLogicalId(scope, id);
    if (rows.length === 0) throw notFound(`note ${id} is not catalogued in scope ${scope}`);
    const loaded = await this.loadRows(scope, rows);
    return this.resolveUniqueHead(scope, id, loaded, rows);
  }

  async getRevision(scope: string, id: string, revisionId: string): Promise<Head> {
    this.assertOpen();
    this.requireScope(scope);
    const rows = this.rowsForRevision(scope, id, revisionId);
    if (rows.length === 0) {
      throw notFound(`revision ${revisionId} is not catalogued in scope ${scope}`);
    }
    const loaded = await this.loadRows(scope, rows);
    if (loaded.parsed.length === 0) {
      throw this.failureError(scope, id, loaded);
    }
    const allRows = this.rowsForLogicalId(scope, id);
    const all = await this.loadRows(scope, allRows);
    const resolution = resolveHead(all.parsed);
    const warnings: string[] = [];
    const failureReasons = unique([
      ...all.failures.map((failure) => failure.reason),
      ...loaded.failures.map((failure) => failure.reason)
    ]);
    let conflicted = false;
    if (resolution.state === 'conflict') {
      conflicted = true;
      warnings.push('conflict', ...resolution.reasons);
    }
    if (failureReasons.length > 0) {
      conflicted = true;
      warnings.push(...failureReasons, 'conflict');
    }
    if (this.hasForeignDuplicate(scope, all.parsed.map((item) => item.revision.revision_id))) {
      conflicted = true;
      warnings.push('duplicate_identity', 'conflict');
    }
    if (!conflicted && resolution.state === 'ready') {
      if (resolution.head.revision.revision_id !== revisionId) warnings.push('historical');
    }
    const target =
      loaded.parsed.find((item) => item.revision.revision_id === revisionId) ?? loaded.parsed[0];
    const row = rows.find((item) => item.revision_id === revisionId);
    if (row !== undefined && row.raw_hash !== target.raw_hash) warnings.push('stale_catalogue');
    return this.buildHead(target, unique(warnings), conflicted ? 'conflict' : undefined);
  }

  async locate(
    scope: string,
    id: string,
    revisionId?: string
  ): Promise<{ relative_path: string } | undefined> {
    this.assertOpen();
    this.requireScope(scope);
    const rows =
      revisionId === undefined ? this.rowsForLogicalId(scope, id) : this.rowsForRevision(scope, id, revisionId);
    const selected =
      revisionId === undefined
        ? rows.find((row) => row.is_head === 1) ??
          rows.find((row) => row.revision_id !== null) ??
          rows[0]
        : rows[0];
    return selected === undefined ? undefined : { relative_path: selected.relative_path };
  }

  async list(
    scope: string,
    filter: 'candidate' | 'conflict',
    cursor?: string
  ): Promise<{ items: SourceRef[]; next_cursor?: string }> {
    this.assertOpen();
    this.requireScope(scope);
    if (filter !== 'candidate' && filter !== 'conflict') {
      throw invalidInput(`unknown catalogue filter ${String(filter)}`);
    }
    const offset = this.decodeCursor(cursor, scope, filter);
    const duplicates = this.duplicateRevisionIds();
    const rows = filter === 'candidate' ? this.candidateRows(scope, duplicates) : this.conflictRows(scope, duplicates);
    const items = rows
      .map((row) => this.sourceRefFromRow(row, duplicates))
      .filter((item): item is SourceRef => item !== undefined);
    const page = items.slice(offset, offset + LIST_PAGE_SIZE);
    const next = offset + LIST_PAGE_SIZE < items.length ? this.encodeCursor(offset + LIST_PAGE_SIZE, scope, filter) : undefined;
    return next === undefined ? { items: page } : { items: page, next_cursor: next };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private resolveUniqueHead(
    scope: string,
    id: string,
    loaded: LoadedRows,
    rows: RevisionRow[]
  ): Head {
    const blocking = loaded.failures.filter((failure) => failure.state !== 'manual_unreviewed');
    const repository = loaded.parsed;
    if (repository.length === 0) {
      throw this.failureError(scope, id, loaded);
    }
    const resolution = resolveHead(repository);
    if (resolution.state === 'conflict') {
      throw conflict(`note ${id} has no unique valid head: ${resolution.reasons.join(', ')}`);
    }
    if (this.hasForeignDuplicate(scope, repository.map((item) => item.revision.revision_id))) {
      throw conflict(`note ${id} has a duplicate revision identity in another scope`);
    }
    const nonHeadConflicts = rows.filter(
      (row) =>
        row.state === 'conflict' ||
        row.state === 'malformed' ||
        (row.state === 'unsupported_schema' && row.revision_id !== resolution.head.revision.revision_id)
    );
    if (blocking.length > 0 || nonHeadConflicts.length > 0) {
      const reasons = unique([
        ...blocking.map((failure) => failure.reason),
        ...nonHeadConflicts.flatMap((row) => parseWarnings(row.warnings_json))
      ]);
      throw conflict(`note ${id} has conflicting files: ${reasons.join(', ')}`);
    }
    const stored = rows.find((row) => row.revision_id === resolution.head.revision.revision_id);
    const warnings: string[] = [];
    if (stored !== undefined && stored.raw_hash !== resolution.head.raw_hash) {
      warnings.push('stale_catalogue');
    }
    return this.buildHead(resolution.head, warnings);
  }

  private failureError(scope: string, id: string, loaded: LoadedRows): BrainError {
    const unsupported = loaded.failures.find((failure) => failure.state === 'unsupported_schema');
    if (unsupported !== undefined) {
      return unsupportedSchema(
        `revision for note ${id} in scope ${scope} uses an unsupported Brain schema version`
      );
    }
    const reasons = unique(loaded.failures.map((failure) => failure.reason));
    if (reasons.length === 0) {
      return notFound(`note ${id} is not catalogued in scope ${scope}`);
    }
    return conflict(`note ${id} has no parseable revision: ${reasons.join(', ')}`);
  }

  private async loadRows(scope: string, rows: RevisionRow[]): Promise<LoadedRows> {
    const parsed: ParsedRevision[] = [];
    const failures: LoadedRows['failures'] = [];
    for (const row of rows) {
      if (row.revision_id === null) {
        failures.push({ row, state: row.state, reason: row.state });
        continue;
      }
      let read: { raw: string; raw_hash: string; relative_path: string };
      try {
        read = await this.vault.read(scope, row.relative_path);
      } catch (error) {
        const code = isBrainError(error) ? error.code : 'INVALID_INPUT';
        failures.push({
          row,
          state: code === 'LIMIT_EXCEEDED' ? 'malformed' : code === 'NOT_FOUND' ? 'conflict' : 'malformed',
          reason: code === 'LIMIT_EXCEEDED' ? 'oversized' : code
        });
        continue;
      }
      let revision: StoredRevision;
      try {
        revision = decodeRevision(read.raw);
      } catch (error) {
        const code = isBrainError(error) ? error.code : 'INVALID_INPUT';
        failures.push({
          row,
          state: code === 'UNSUPPORTED_SCHEMA' ? 'unsupported_schema' : 'malformed',
          reason: code === 'UNSUPPORTED_SCHEMA' ? 'unsupported_schema' : 'malformed'
        });
        continue;
      }
      if (
        revision.id !== row.logical_id ||
        revision.revision_id !== row.revision_id ||
        revision.scope !== scope
      ) {
        failures.push({ row, state: 'conflict', reason: 'metadata_mismatch' });
        continue;
      }
      parsed.push({ revision, raw_hash: read.raw_hash, relative_path: read.relative_path });
    }
    return { parsed, failures };
  }

  private buildHead(
    item: ParsedRevision,
    baseWarnings: string[],
    forcedState?: Head['state']
  ): Head {
    const revision = item.revision;
    const approvalChanged =
      revision.approval !== undefined && revision.approval.payload_hash !== payloadHash(revision);
    const warnings = [...baseWarnings];
    if (approvalChanged && !warnings.includes('manual_unreviewed')) {
      warnings.push('manual_unreviewed');
    }
    const source: SourceRef = {
      id: revision.id,
      revision_id: revision.revision_id,
      scope: revision.scope,
      title: revision.note.title,
      kind: revision.note.content.kind,
      status: approvalChanged ? 'candidate' : revision.status,
      etag: makeEtag(revision.revision_id, item.raw_hash),
      relative_path: item.relative_path,
      warnings
    };
    return {
      revision,
      source,
      raw_hash: item.raw_hash,
      state: forcedState ?? (approvalChanged ? 'manual_unreviewed' : 'ready')
    };
  }

  private sourceRefFromRow(row: RevisionRow, duplicates?: Set<string>): SourceRef | undefined {
    if (row.logical_id === null || row.revision_id === null) return undefined;
    if (row.title === null || row.kind === null || row.effective_status === null) return undefined;
    if (!uuidSchema.safeParse(row.logical_id).success) return undefined;
    if (!uuidSchema.safeParse(row.revision_id).success) return undefined;
    if (!(NOTE_KINDS as readonly string[]).includes(row.kind)) return undefined;
    if (!(LIFECYCLES as readonly string[]).includes(row.effective_status)) return undefined;
    const warnings = parseWarnings(row.warnings_json);
    if (duplicates !== undefined && duplicates.has(row.revision_id) && !warnings.includes('duplicate_identity')) {
      warnings.push('duplicate_identity');
    }
    return {
      id: row.logical_id,
      revision_id: row.revision_id,
      scope: row.scope,
      title: row.title,
      kind: row.kind as NoteKind,
      status: row.effective_status as Lifecycle,
      etag: makeEtag(row.revision_id, row.raw_hash),
      relative_path: row.relative_path,
      warnings
    };
  }

  private candidateRows(scope: string, duplicates: Set<string>): RevisionRow[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM catalogue_revisions
         WHERE scope = ? AND state IN ('ready', 'manual_unreviewed')
           AND effective_status = 'candidate' AND is_head = 1
         ORDER BY logical_id ASC, revision_id ASC, relative_path ASC`
      )
      .all(scope) as RevisionRow[];
    return rows.filter((row) => row.revision_id === null || !duplicates.has(row.revision_id));
  }

  private conflictRows(scope: string, duplicates: Set<string>): RevisionRow[] {
    const stored = this.database
      .prepare(
        `SELECT * FROM catalogue_revisions
         WHERE scope = ? AND state = 'conflict'
         ORDER BY logical_id ASC, revision_id ASC, relative_path ASC`
      )
      .all(scope) as RevisionRow[];
    const ids = [...duplicates];
    const dynamic =
      ids.length === 0
        ? []
        : (this.database
            .prepare(
              `SELECT * FROM catalogue_revisions
               WHERE scope = ? AND revision_id IN (${ids.map(() => '?').join(', ')})
               ORDER BY logical_id ASC, revision_id ASC, relative_path ASC`
            )
            .all(scope, ...ids) as RevisionRow[]);
    const merged = new Map<string, RevisionRow>();
    for (const row of [...stored, ...dynamic]) merged.set(row.relative_path, row);
    return [...merged.values()].sort((left, right) => compareText(left.logical_id, right.logical_id)
      || compareText(left.revision_id, right.revision_id)
      || compareText(left.relative_path, right.relative_path));
  }

  private duplicateRevisionIds(): Set<string> {
    const rows = this.database
      .prepare(
        `SELECT revision_id FROM catalogue_revisions
         WHERE revision_id IS NOT NULL
         GROUP BY revision_id HAVING COUNT(*) > 1`
      )
      .all() as { revision_id: string }[];
    return new Set(rows.map((row) => row.revision_id));
  }

  private normalizeDuplicateConflicts(): void {
    const duplicates = this.duplicateRevisionIds();
    const candidates = this.database
      .prepare(
        `SELECT * FROM catalogue_revisions
         WHERE revision_id IS NOT NULL AND warnings_json LIKE '%duplicate_identity%'`
      )
      .all() as RevisionRow[];
    if (candidates.length === 0) return;
    const update = this.database.prepare(
      `UPDATE catalogue_revisions
       SET state = ?, is_head = ?, warnings_json = ?
       WHERE scope = ? AND relative_path = ?`
    );
    const run = this.database.transaction((): void => {
      for (const row of candidates) {
        if (row.revision_id === null || duplicates.has(row.revision_id)) continue;
        const warnings = parseWarnings(row.warnings_json);
        if (!warnings.includes('duplicate_identity')) continue;
        const other = warnings.filter((warning) => warning !== 'duplicate_identity');
        const nonConflict = other.filter((warning) => warning !== 'conflict');
        const hasStructuralConflict = nonConflict.some(
          (warning) => warning !== 'manual_unreviewed'
        );
        let state: CatalogueState;
        let nextWarnings: string[];
        if (nonConflict.length === 0) {
          state = 'ready';
          nextWarnings = [];
        } else if (!hasStructuralConflict) {
          state = 'manual_unreviewed';
          nextWarnings = unique(nonConflict);
        } else {
          state = 'conflict';
          nextWarnings = unique([...nonConflict, 'conflict']);
        }
        const isHead = this.isPersistedHead(row) && (state === 'ready' || state === 'manual_unreviewed');
        update.run(state, isHead ? 1 : 0, JSON.stringify(nextWarnings), row.scope, row.relative_path);
      }
    });
    run.immediate();
  }

  private isPersistedHead(row: RevisionRow): boolean {
    if (row.revision_id === null || row.logical_id === null) return false;
    const child = this.database
      .prepare(
        `SELECT 1 AS present
         FROM catalogue_parents AS parent
         JOIN catalogue_revisions AS child
           ON child.scope = parent.scope AND child.revision_id = parent.revision_id
         WHERE parent.scope = ? AND parent.parent_revision_id = ? AND child.logical_id = ?
         LIMIT 1`
      )
      .get(row.scope, row.revision_id, row.logical_id) as { present: number } | undefined;
    return child === undefined;
  }

  private foreignRowsFor(scope: string, revisionIds: string[]): RevisionRow[] {
    const ids = unique(revisionIds.filter((id) => id.length > 0));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.database
      .prepare(
        `SELECT * FROM catalogue_revisions
         WHERE scope <> ? AND revision_id IN (${placeholders})
         ORDER BY scope ASC, relative_path ASC`
      )
      .all(scope, ...ids) as RevisionRow[];
  }

  private hasForeignDuplicate(scope: string, revisionIds: string[]): boolean {
    return this.foreignRowsFor(scope, revisionIds).length > 0;
  }

  private rowsForLogicalId(scope: string, id: string): RevisionRow[] {
    return this.database
      .prepare('SELECT * FROM catalogue_revisions WHERE scope = ? AND logical_id = ? ORDER BY relative_path ASC')
      .all(scope, id) as RevisionRow[];
  }

  private rowsForRevision(scope: string, id: string, revisionId: string): RevisionRow[] {
    return this.database
      .prepare(
        'SELECT * FROM catalogue_revisions WHERE scope = ? AND logical_id = ? AND revision_id = ? ORDER BY relative_path ASC'
      )
      .all(scope, id, revisionId) as RevisionRow[];
  }

  private persist(scope: string, rows: RevisionRow[], parents: ParentRow[]): void {
    const run = this.database.transaction((): void => {
      this.database.prepare('DELETE FROM catalogue_parents WHERE scope = ?').run(scope);
      this.database.prepare('DELETE FROM catalogue_revisions WHERE scope = ?').run(scope);
      const insertRevision = this.database.prepare(
        `INSERT INTO catalogue_revisions (
          scope, relative_path, revision_id, logical_id, raw_hash, title, kind,
          stored_status, effective_status, state, is_head, warnings_json, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of rows) {
        insertRevision.run(
          row.scope,
          row.relative_path,
          row.revision_id,
          row.logical_id,
          row.raw_hash,
          row.title,
          row.kind,
          row.stored_status,
          row.effective_status,
          row.state,
          row.is_head,
          row.warnings_json,
          row.observed_at
        );
      }
      const insertParent = this.database.prepare(
        `INSERT OR IGNORE INTO catalogue_parents (scope, revision_id, parent_revision_id, parent_raw_hash)
         VALUES (?, ?, ?, ?)`
      );
      for (const parent of parents) {
        insertParent.run(parent.scope, parent.revision_id, parent.parent_revision_id, parent.parent_raw_hash);
      }
    });
    run.immediate();
  }

  private encodeCursor(offset: number, scope: string, filter: string): string {
    return Buffer.from(JSON.stringify({ offset, scope, filter }), 'utf8').toString('base64url');
  }

  private decodeCursor(cursor: string | undefined, scope: string, filter: string): number {
    if (cursor === undefined) return 0;
    let parsed: { offset?: unknown; scope?: unknown; filter?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
    } catch {
      throw invalidInput('catalogue cursor is not decodable');
    }
    if (
      parsed.scope !== scope ||
      parsed.filter !== filter ||
      typeof parsed.offset !== 'number' ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw invalidInput('catalogue cursor does not match the request');
    }
    return parsed.offset;
  }

  private requireScope(scope: string): void {
    if (!this.scopes.has(scope)) {
      throw forbidden(`scope ${scope} is not configured for catalogue access`);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw invalidInput('revision catalogue is closed');
  }
}
