import { randomUUID, createHash } from 'node:crypto';
import { watch as watchFiles, type FSWatcher } from 'node:fs';
import { BrainError, isBrainError } from '../contracts/errors.js';
import type { Clock, IdSource } from '../core/types.js';
import type { RevisionStore } from '../storage/revision-store.js';
import { selectCatalogueEntry } from './catalogue.js';
import { parseDocument } from './document-codec.js';
import type { CurrentDocument, DocumentStatus } from './document.js';
import { resolveLink } from './link-resolver.js';
import { extractLinks, isExternalTarget, type LinkReference } from './links.js';

export const CURRENT_VAULT_DEBOUNCE_MS = 250;
export const CURRENT_VAULT_RESCAN_INTERVAL_MS = 30_000;

export interface CurrentVaultScan {
  paths: string[];
  complete: boolean;
}

export interface CurrentVault {
  listMarkdown(): Promise<string[]>;
  scanMarkdown?(): Promise<CurrentVaultScan>;
  readMarkdown(
    relativePath: string
  ): Promise<{ raw: string; raw_hash: string; relative_path: string }>;
}

export interface CurrentIdentity {
  id: string;
  path: string;
}

export type CurrentIdentityMatch =
  | { id: string; from: string; to: string }
  | { id: string; conflict: 'duplicate_id'; paths: string[] };

export function matchCurrentIdentity(
  previous: readonly CurrentIdentity[],
  next: readonly CurrentIdentity[]
): CurrentIdentityMatch[] {
  const pathsFor = (entries: readonly CurrentIdentity[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const entry of entries) {
      const list = map.get(entry.id) ?? [];
      if (!list.includes(entry.path)) list.push(entry.path);
      map.set(entry.id, list);
    }
    return map;
  };
  const before = pathsFor(previous);
  const after = pathsFor(next);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const matches: CurrentIdentityMatch[] = [];
  for (const id of ids) {
    const from = before.get(id) ?? [];
    const to = after.get(id) ?? [];
    if (from.length > 1 || to.length > 1) {
      matches.push({
        id,
        conflict: 'duplicate_id',
        paths: [...new Set([...from, ...to])].sort()
      });
      continue;
    }
    if (from.length === 1 && to.length === 1 && from[0] !== to[0]) {
      matches.push({ id, from: from[0], to: to[0] });
    }
  }
  return matches;
}

export interface CurrentSource {
  path: string;
  hash: string;
  etag: string;
  title: string;
  type: string;
  status: DocumentStatus;
  aliases: string[];
  tags: string[];
  observed_at: string;
  id?: string;
  revision_id?: string;
  project?: string;
}

export interface CurrentHistory {
  id: string;
  path: string;
  hash: string;
  observed_at: string;
  revision_id?: string;
}

export interface CurrentIndexEntry {
  path: string;
  raw: string;
  etag: string;
  id?: string;
  revision_id?: string;
}

interface StoredCurrent {
  source: CurrentSource;
  raw: string;
}

export interface CurrentCatalogueOptions {
  revisions?: RevisionStore;
  ids?: IdSource;
  clock?: Clock;
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdSource = { next: () => randomUUID() };

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function cancelled(): BrainError {
  return new BrainError({ code: 'CANCELLED', message: 'the reconciliation was cancelled' });
}

function errorCode(error: unknown): string {
  if (isBrainError(error)) return error.code;
  return 'INVALID_INPUT';
}

function titleFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const withoutExtension = base.endsWith('.md') ? base.slice(0, -3) : base;
  return withoutExtension.length > 0 ? withoutExtension : 'Untitled';
}

interface FallbackMetadata {
  title: string;
  type: string;
  status: DocumentStatus;
  aliases: string[];
  tags: string[];
  id?: string;
  project?: string;
}

function readFallback(raw: string, path: string): FallbackMetadata {
  try {
    const document = parseDocument(raw, path);
    return {
      title: document.title,
      type: document.type,
      status: document.status,
      aliases: [...document.aliases],
      tags: [...document.tags],
      ...(document.id === undefined ? {} : { id: document.id }),
      ...(document.project === undefined ? {} : { project: document.project })
    };
  } catch {
    return {
      title: titleFromPath(path),
      type: 'note',
      status: 'candidate',
      aliases: [],
      tags: []
    };
  }
}

function legacyRevision(raw: string): boolean {
  return (
    /^[ \t]*brain_id[ \t]*:/m.test(raw) && /^[ \t]*brain_revision_id[ \t]*:/m.test(raw)
  );
}

function noteLink(reference: LinkReference): boolean {
  const target = reference.target.trim();
  if (target.length === 0) return false;
  if (isExternalTarget(target)) return false;
  const withoutFragment = target.split('#')[0].split('|')[0];
  const leaf = withoutFragment.slice(withoutFragment.lastIndexOf('/') + 1);
  const dot = leaf.lastIndexOf('.');
  if (dot > 0 && !/\.(md|markdown)$/i.test(leaf)) return false;
  return true;
}

export class CurrentCatalogue {
  private readonly entries = new Map<string, StoredCurrent>();
  private readonly histories = new Map<string, CurrentHistory>();
  private readonly conflicts = new Map<string, CurrentSource[]>();
  readonly revisions: RevisionStore | undefined;
  readonly idSource: IdSource;
  private readonly clock: Clock;
  private closed = false;

  private constructor(options: CurrentCatalogueOptions) {
    this.revisions = options.revisions;
    this.idSource = options.ids ?? systemIds;
    this.clock = options.clock ?? systemClock;
  }

  static open(options: CurrentCatalogueOptions = {}): CurrentCatalogue {
    return new CurrentCatalogue(options);
  }

  all(): CurrentSource[] {
    return [...this.entries.values()]
      .map((entry) => entry.source)
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  getById(id: string): CurrentSource | undefined {
    for (const entry of this.entries.values()) {
      if (entry.source.id === id) return entry.source;
    }
    return undefined;
  }

  getByPath(path: string): CurrentSource | undefined {
    return this.entries.get(path)?.source;
  }

  resolve(reference: { id?: string; path?: string; title?: string }): CurrentSource | undefined {
    return selectCatalogueEntry(this.all(), {
      ...(reference.id === undefined ? {} : { id: reference.id }),
      ...(reference.path === undefined ? {} : { path: reference.path })
    });
  }

  historyFor(id: string): CurrentHistory | undefined {
    return this.histories.get(id);
  }

  rawFor(path: string): string | undefined {
    return this.entries.get(path)?.raw;
  }

  clearConflicts(): void {
    this.conflicts.clear();
  }

  recordConflict(id: string, sources: readonly CurrentSource[]): void {
    this.conflicts.set(id, sources.map((source) => ({ ...source })));
  }

  conflictsFor(id: string): CurrentSource[] {
    return (this.conflicts.get(id) ?? []).map((source) => ({ ...source }));
  }

  conflictIds(): string[] {
    return [...this.conflicts.keys()].sort();
  }

  upsert(entry: CurrentIndexEntry): void {
    this.assertOpen();
    if (typeof entry?.path !== 'string' || entry.path.length === 0) {
      throw invalidInput('a current catalogue entry needs a path');
    }
    if (typeof entry.etag !== 'string' || entry.etag.length === 0) {
      throw invalidInput('a current catalogue entry needs an etag');
    }
    const existing = this.entries.get(entry.path);
    const metadata = readFallback(entry.raw, entry.path);
    const id = entry.id ?? metadata.id;
    const source: CurrentSource = {
      path: entry.path,
      hash: entry.etag,
      etag: entry.etag,
      title: metadata.title,
      type: metadata.type,
      status: metadata.status,
      aliases: metadata.aliases,
      tags: metadata.tags,
      observed_at:
        existing !== undefined && existing.source.hash === entry.etag
          ? existing.source.observed_at
          : this.clock.now().toISOString(),
      ...(id === undefined ? {} : { id }),
      ...(id === undefined || entry.revision_id === undefined
        ? {}
        : { revision_id: entry.revision_id }),
      ...(metadata.project === undefined ? {} : { project: metadata.project })
    };
    this.entries.set(entry.path, { source, raw: entry.raw });
    this.recordHistory(source);
  }

  remove(path: string): void {
    this.assertOpen();
    const existing = this.entries.get(path);
    if (existing === undefined) return;
    this.entries.delete(path);
    this.recordHistory(existing.source);
  }

  recordHistory(source: CurrentSource): void {
    if (source.id === undefined) return;
    const current = this.histories.get(source.id);
    if (current !== undefined && current.hash === source.hash && current.path === source.path) return;
    this.histories.set(source.id, {
      id: source.id,
      path: source.path,
      hash: source.hash,
      observed_at: source.observed_at,
      ...(source.revision_id === undefined ? {} : { revision_id: source.revision_id })
    });
  }

  async persistSnapshot(id: string, raw: string | undefined): Promise<void> {
    if (this.revisions === undefined || raw === undefined) return;
    await this.revisions.persistPreimage(id, raw);
  }

  async persistRevision(id: string | undefined, raw: string): Promise<string | undefined> {
    if (id === undefined || this.revisions === undefined) return undefined;
    const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
    const existing = await this.revisions.findRevisionByHash(id, hash);
    if (existing !== undefined) return existing;
    const revisionId = this.idSource.next();
    await this.revisions.persistRevision(id, revisionId, raw);
    return revisionId;
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw invalidInput('the current catalogue is closed');
  }
}

export interface CurrentVaultChange {
  path: string;
  previous_etag: string;
  etag: string;
  id?: string;
}

export interface CurrentVaultMove {
  id: string;
  from: string;
  to: string;
}

export interface CurrentVaultRemoval {
  path: string;
  id?: string;
  retained_revision_id?: string;
}

export interface CurrentVaultMalformed {
  path: string;
  reason: string;
}

export interface CurrentVaultDuplicate {
  id: string;
  paths: string[];
}

export interface CurrentVaultUnresolvedLink {
  path: string;
  target: string;
  state: 'unresolved' | 'ambiguous';
}

export interface ReconcileCurrentVaultReport {
  scanned: number;
  complete: boolean;
  added: CurrentSource[];
  changed: CurrentVaultChange[];
  moved: CurrentVaultMove[];
  removed: CurrentVaultRemoval[];
  malformed: CurrentVaultMalformed[];
  duplicate_ids: CurrentVaultDuplicate[];
  identity_conflicts?: CurrentVaultDuplicate[];
  unresolved_links: CurrentVaultUnresolvedLink[];
}

export interface ReconcileCurrentVaultInput {
  vault: CurrentVault;
  catalogue: CurrentCatalogue;
  signal?: AbortSignal;
}

interface ObservedDocument {
  path: string;
  raw: string;
  raw_hash: string;
  document: CurrentDocument;
}

export async function reconcileCurrentVault(
  input: ReconcileCurrentVaultInput
): Promise<ReconcileCurrentVaultReport> {
  const { vault, catalogue, signal } = input;
  if (signal?.aborted) throw cancelled();
  const report: ReconcileCurrentVaultReport = {
    scanned: 0,
    complete: true,
    added: [],
    changed: [],
    moved: [],
    removed: [],
    malformed: [],
    duplicate_ids: [],
    identity_conflicts: [],
    unresolved_links: []
  };

  const previous = catalogue.all();
  const previousByPath = new Map(previous.map((source) => [source.path, source]));
  let paths: string[];
  if (typeof vault.scanMarkdown === 'function') {
    const scan = await vault.scanMarkdown();
    paths = [...scan.paths].sort();
    report.complete = scan.complete;
  } else {
    paths = [...(await vault.listMarkdown())].sort();
  }
  report.scanned = paths.length;
  const listedPaths = new Set(paths);

  const observed: ObservedDocument[] = [];
  for (const path of paths) {
    if (signal?.aborted) throw cancelled();
    let read: { raw: string; raw_hash: string };
    try {
      read = await vault.readMarkdown(path);
    } catch (error) {
      report.malformed.push({ path, reason: errorCode(error) });
      continue;
    }
    try {
      const document = parseDocument(read.raw, path);
      observed.push({ path, raw: read.raw, raw_hash: read.raw_hash, document });
    } catch (error) {
      if (legacyRevision(read.raw)) continue;
      report.malformed.push({ path, reason: errorCode(error) });
    }
  }

  const pathsForId = (ids: readonly { id: string; path: string }[]): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const entry of ids) {
      const list = map.get(entry.id) ?? [];
      list.push(entry.path);
      map.set(entry.id, list);
    }
    return map;
  };
  const previousIdentityPaths = pathsForId(
    previous
      .filter((source): source is CurrentSource & { id: string } => source.id !== undefined)
      .map((source) => ({ id: source.id, path: source.path }))
  );
  const nextIdentityPaths = pathsForId(
    observed
      .filter((item): item is ObservedDocument & { document: CurrentDocument & { id: string } } =>
        item.document.id !== undefined
      )
      .map((item) => ({ id: item.document.id, path: item.path }))
  );
  const observedPaths = new Set(observed.map((item) => item.path));

  const duplicateIds = new Map<string, string[]>();
  catalogue.clearConflicts();
  const identityIds = [...new Set([...previousIdentityPaths.keys(), ...nextIdentityPaths.keys()])].sort();
  for (const id of identityIds) {
    const beforePaths = previousIdentityPaths.get(id) ?? [];
    const afterPaths = nextIdentityPaths.get(id) ?? [];
    const unresolvedPrior = beforePaths.some(
      (path) => !observedPaths.has(path) && (listedPaths.has(path) || !report.complete)
    );
    const uncertainMove =
      beforePaths.length > 0 &&
      (unresolvedPrior || !report.complete) &&
      afterPaths.some((path) => !beforePaths.includes(path));
    if (beforePaths.length <= 1 && afterPaths.length <= 1 && !uncertainMove) continue;
    const pathList = [...new Set([...beforePaths, ...afterPaths])].sort();
    duplicateIds.set(id, pathList);
    report.duplicate_ids.push({ id, paths: pathList });
    catalogue.recordConflict(
      id,
      observed
        .filter((item) => item.document.id === id)
        .map((item) => ({
          path: item.path,
          hash: item.raw_hash,
          etag: item.raw_hash,
          title: item.document.title,
          type: item.document.type,
          status: item.document.status,
          aliases: [...item.document.aliases],
          tags: [...item.document.tags],
          observed_at: new Date().toISOString(),
          id,
          ...(item.document.project === undefined ? {} : { project: item.document.project })
        }))
    );
  }

  const previousIdentities = previous
    .filter((source): source is CurrentSource & { id: string } =>
      source.id !== undefined && !duplicateIds.has(source.id)
    )
    .map((source) => ({ id: source.id, path: source.path }));
  const nextIdentities = observed
    .filter((item): item is ObservedDocument & { document: CurrentDocument & { id: string } } =>
      item.document.id !== undefined && !duplicateIds.has(item.document.id)
    )
    .map((item) => ({ id: item.document.id, path: item.path }));

  interface PlannedUpsert {
    path: string;
    raw: string;
    etag: string;
    id?: string;
    revision_id?: string;
  }
  interface PlannedMove extends PlannedUpsert {
    from: string;
    move_id: string;
  }
  interface PlannedChange extends PlannedUpsert {
    previous_etag: string;
    prior: CurrentSource;
  }

  const movedFrom = new Set<string>();
  const moveDestinations = new Set<string>();
  const movesByTo = new Map<string, { id: string; from: string; to: string }>();
  for (const match of matchCurrentIdentity(previousIdentities, nextIdentities)) {
    if ('to' in match) movesByTo.set(match.to, match);
  }

  const plannedMoves: PlannedMove[] = [];
  for (const item of observed) {
    if (signal?.aborted) throw cancelled();
    const id = item.document.id;
    if (id !== undefined && duplicateIds.has(id)) continue;
    const move = movesByTo.get(item.path);
    if (move === undefined || !report.complete) continue;
    const source = previousByPath.get(move.from);
    if (source === undefined) continue;
    moveDestinations.add(item.path);
    movedFrom.add(move.from);
    let revisionId = source.revision_id;
    if (source.id !== undefined && source.hash !== item.raw_hash) {
      await catalogue.persistSnapshot(source.id, catalogue.rawFor(move.from));
      if (signal?.aborted) throw cancelled();
      revisionId = await catalogue.persistRevision(source.id, item.raw);
    }
    plannedMoves.push({
      from: move.from,
      move_id: move.id,
      path: item.path,
      raw: item.raw,
      etag: item.raw_hash,
      ...(source.id === undefined ? {} : { id: source.id }),
      ...(revisionId === undefined ? {} : { revision_id: revisionId })
    });
  }

  const plannedAdds: PlannedUpsert[] = [];
  const plannedChanges: PlannedChange[] = [];
  for (const item of observed) {
    if (signal?.aborted) throw cancelled();
    if (moveDestinations.has(item.path)) continue;
    const id = item.document.id;
    if (id !== undefined && duplicateIds.has(id)) continue;

    const prior = previousByPath.get(item.path);
    if (prior === undefined) {
      const revisionId = await catalogue.persistRevision(id, item.raw);
      plannedAdds.push({
        path: item.path,
        raw: item.raw,
        etag: item.raw_hash,
        ...(id === undefined ? {} : { id }),
        ...(revisionId === undefined ? {} : { revision_id: revisionId })
      });
      continue;
    }

    if (prior.hash === item.raw_hash) continue;
    if (!report.complete && prior.id !== id) {
      report.identity_conflicts?.push({
        id: id ?? prior.id ?? item.path,
        paths: [item.path]
      });
      continue;
    }

    let revisionId: string | undefined;
    if (id !== undefined && id === prior.id) {
      await catalogue.persistSnapshot(id, catalogue.rawFor(prior.path));
      if (signal?.aborted) throw cancelled();
      revisionId = await catalogue.persistRevision(id, item.raw);
    } else if (id !== undefined) {
      if (prior.id !== undefined) {
        await catalogue.persistSnapshot(prior.id, catalogue.rawFor(prior.path));
      }
      if (signal?.aborted) throw cancelled();
      revisionId = await catalogue.persistRevision(id, item.raw);
    }
    plannedChanges.push({
      prior,
      previous_etag: prior.etag,
      path: item.path,
      raw: item.raw,
      etag: item.raw_hash,
      ...(id === undefined ? {} : { id }),
      ...(revisionId === undefined ? {} : { revision_id: revisionId })
    });
  }

  const plannedRemovals: CurrentSource[] = [];
  if (report.complete) {
    for (const source of previous) {
      if (listedPaths.has(source.path)) continue;
      if (movedFrom.has(source.path)) continue;
      if (source.id !== undefined && duplicateIds.has(source.id)) continue;
      plannedRemovals.push(source);
    }
  }

  if (signal?.aborted) throw cancelled();

  for (const move of plannedMoves) catalogue.remove(move.from);
  for (const move of plannedMoves) {
    catalogue.upsert({
      path: move.path,
      raw: move.raw,
      etag: move.etag,
      ...(move.id === undefined ? {} : { id: move.id }),
      ...(move.revision_id === undefined ? {} : { revision_id: move.revision_id })
    });
    report.moved.push({ id: move.move_id, from: move.from, to: move.path });
  }
  for (const add of plannedAdds) {
    catalogue.upsert({
      path: add.path,
      raw: add.raw,
      etag: add.etag,
      ...(add.id === undefined ? {} : { id: add.id }),
      ...(add.revision_id === undefined ? {} : { revision_id: add.revision_id })
    });
    const added = catalogue.getByPath(add.path);
    if (added !== undefined) report.added.push(added);
  }
  for (const change of plannedChanges) {
    catalogue.recordHistory(change.prior);
    catalogue.upsert({
      path: change.path,
      raw: change.raw,
      etag: change.etag,
      ...(change.id === undefined ? {} : { id: change.id }),
      ...(change.revision_id === undefined ? {} : { revision_id: change.revision_id })
    });
    report.changed.push({
      path: change.path,
      ...(change.id === undefined ? {} : { id: change.id }),
      previous_etag: change.previous_etag,
      etag: change.etag
    });
  }
  for (const source of plannedRemovals) {
    catalogue.remove(source.path);
    report.removed.push({
      path: source.path,
      ...(source.id === undefined ? {} : { id: source.id }),
      ...(source.revision_id === undefined ? {} : { retained_revision_id: source.revision_id })
    });
  }

  const current = catalogue.all();
  const linkCatalogue = new Map<string, string | undefined>();
  for (const source of current) linkCatalogue.set(source.path, source.id);
  for (const source of current) {
    const raw = catalogue.rawFor(source.path);
    if (raw === undefined) continue;
    for (const reference of extractLinks(raw)) {
      if (!noteLink(reference)) continue;
      const resolution = resolveLink(reference, source.path, linkCatalogue);
      if (resolution.state === 'resolved') continue;
      report.unresolved_links.push({
        path: source.path,
        target: reference.target,
        state: resolution.state
      });
    }
  }

  return report;
}

export type CurrentSourceLookup =
  | { state: 'current'; source: CurrentSource }
  | { state: 'refreshed'; source: CurrentSource }
  | { state: 'stale'; source: CurrentSource }
  | { state: 'conflict'; paths: string[] }
  | { state: 'missing' };

export interface ReadCurrentSourceInput {
  vault: CurrentVault;
  catalogue: CurrentCatalogue;
  reference: { id?: string; path?: string; title?: string };
  refresh?: boolean;
  signal?: AbortSignal;
}

export async function readCurrentSource(
  input: ReadCurrentSourceInput
): Promise<CurrentSourceLookup> {
  const { vault, catalogue, reference } = input;
  const refresh = input.refresh ?? true;

  const locate = (): CurrentSource | { conflict: string[] } | undefined => {
    if (reference.id !== undefined || reference.path !== undefined) {
      return selectCatalogueEntry(catalogue.all(), {
        ...(reference.id === undefined ? {} : { id: reference.id }),
        ...(reference.path === undefined ? {} : { path: reference.path })
      });
    }
    if (reference.title !== undefined) {
      const matches = catalogue.all().filter((source) => source.title === reference.title);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return { conflict: matches.map((source) => source.path).sort() };
    }
    return undefined;
  };

  const resolved = locate();
  if (resolved === undefined) return { state: 'missing' };
  if ('conflict' in resolved) return { state: 'conflict', paths: resolved.conflict };
  const source = resolved;

  let read: { raw: string; raw_hash: string } | undefined;
  try {
    read = await vault.readMarkdown(source.path);
  } catch {
    read = undefined;
  }
  if (read !== undefined && read.raw_hash === source.hash) return { state: 'current', source };
  if (read !== undefined && !refresh) return { state: 'stale', source };

  if (refresh) {
    await reconcileCurrentVault({
      vault,
      catalogue,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const again = locate();
    if (again === undefined) return { state: 'missing' };
    if ('conflict' in again) return { state: 'conflict', paths: again.conflict };
    let verified: { raw: string; raw_hash: string } | undefined;
    try {
      verified = await vault.readMarkdown(again.path);
    } catch {
      verified = undefined;
    }
    if (verified !== undefined && verified.raw_hash === again.hash) {
      return { state: 'refreshed', source: again };
    }
    return { state: 'stale', source: again };
  }
  return read === undefined ? { state: 'missing' } : { state: 'stale', source };
}

export interface ObserveCurrentVaultOptions {
  root: string;
  vault: CurrentVault;
  catalogue: CurrentCatalogue;
  signal?: AbortSignal;
  debounce_ms?: number;
  interval_ms?: number;
  onReconcile?: (report: ReconcileCurrentVaultReport) => void;
  onError?: (error: unknown) => void;
}

export interface CurrentVaultObserver {
  readonly closed: boolean;
  reconcileNow(): Promise<ReconcileCurrentVaultReport | undefined>;
  close(): Promise<void>;
}

export function observeCurrentVault(options: ObserveCurrentVaultOptions): CurrentVaultObserver {
  const debounceMs = options.debounce_ms ?? CURRENT_VAULT_DEBOUNCE_MS;
  const intervalMs = options.interval_ms ?? CURRENT_VAULT_RESCAN_INTERVAL_MS;
  let closed = false;
  let running = false;
  let debounceTimer: NodeJS.Timeout | undefined;
  let intervalTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  const report = (error: unknown): void => {
    if (closed) return;
    options.onError?.(error);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', onAbort);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (intervalTimer !== undefined) clearInterval(intervalTimer);
    try {
      watcher?.close();
    } catch {
      watcher = undefined;
    }
  };
  function onAbort(): void {
    void close();
  }

  const run = async (): Promise<ReconcileCurrentVaultReport | undefined> => {
    if (closed || running) return undefined;
    if (options.signal?.aborted) return undefined;
    running = true;
    try {
      const outcome = await reconcileCurrentVault({
        vault: options.vault,
        catalogue: options.catalogue,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
      options.onReconcile?.(outcome);
      return outcome;
    } catch (error) {
      if (!(isBrainError(error) && error.code === 'CANCELLED')) report(error);
      return undefined;
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (closed) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void run();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) {
    void close();
  } else {
    try {
      watcher = watchFiles(options.root, { recursive: true }, () => schedule());
      watcher.on('error', report);
      watcher.unref?.();
    } catch (error) {
      report(error);
    }
    intervalTimer = setInterval(() => {
      void run();
    }, intervalMs);
    intervalTimer.unref?.();
  }

  return {
    get closed(): boolean {
      return closed;
    },
    reconcileNow: run,
    close
  };
}
