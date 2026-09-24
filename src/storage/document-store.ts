import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { RENDERED_NOTE_MAX_BYTES } from '../core/limits.js';
import type { Clock, IdSource } from '../core/types.js';
import { parseDocument, renderDocument } from '../notes/document-codec.js';
import { collisionKey } from '../notes/paths.js';
import { LocalWriteJournal, type LocalWriteRecord } from './journal.js';
import { openRevisionStore, type RevisionStore } from './revision-store.js';
import { listVaultFilePaths, readBoundedBytes, vaultNoteSegments } from './vault.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdSource = { next: () => randomUUID() };

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function forbidden(message: string): BrainError {
  return new BrainError({ code: 'FORBIDDEN', message });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

function conflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

function limitExceeded(message: string): BrainError {
  return new BrainError({ code: 'LIMIT_EXCEEDED', message });
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function hasErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function sha256(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function wrapIo(message: string, error: unknown): BrainError {
  return isBrainError(error) ? error : recoveryRequired(message, error);
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    throw recoveryRequired(`directory ${directory} could not be fsynced`, error);
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

async function readNoteFile(
  root: string,
  segments: string[]
): Promise<{ raw: string; hash: string } | undefined> {
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) return undefined;
      throw recoveryRequired(`vault path ${segments.join('/')} cannot be inspected`, error);
    }
    if (info.isSymbolicLink()) {
      throw forbidden(`path ${segments.join('/')} contains a symbolic link`);
    }
    if (!info.isDirectory()) return undefined;
  }
  const target = join(root, ...segments);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return undefined;
    throw recoveryRequired(`vault path ${segments.join('/')} cannot be inspected`, error);
  }
  if (info.isSymbolicLink()) {
    throw forbidden(`path ${segments.join('/')} is a symbolic link`);
  }
  if (!info.isFile()) throw forbidden(`path ${segments.join('/')} is not a regular file`);
  if (info.size > RENDERED_NOTE_MAX_BYTES) {
    throw limitExceeded(
      `file ${segments.join('/')} is ${info.size} bytes and exceeds the ${RENDERED_NOTE_MAX_BYTES} byte limit`
    );
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrno(error, 'ELOOP')) {
      throw forbidden(`path ${segments.join('/')} contains a symbolic link`);
    }
    throw recoveryRequired(`file ${segments.join('/')} cannot be opened`, error);
  }
  let buffer: Buffer;
  try {
    const bounded = await readBoundedBytes(handle, RENDERED_NOTE_MAX_BYTES);
    if (bounded.kind === 'overflow') {
      throw limitExceeded(`file ${segments.join('/')} exceeds the ${RENDERED_NOTE_MAX_BYTES} byte limit`);
    }
    buffer = bounded.buffer;
  } finally {
    await handle.close();
  }
  const raw = buffer.toString('utf8');
  if (!Buffer.from(raw, 'utf8').equals(buffer)) {
    throw invalidInput(`file ${segments.join('/')} is not valid UTF-8`);
  }
  return { raw, hash: sha256(buffer) };
}

async function ensureWriteChain(root: string, segments: string[]): Promise<void> {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    throw recoveryRequired(`vault root ${root} cannot be inspected`, error);
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw recoveryRequired(`vault root ${root} is not a safe directory`);
  }
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (cause) {
          throw recoveryRequired(`vault directory ${segments[index]} cannot be created`, cause);
        }
        continue;
      }
      throw recoveryRequired(`vault directory ${segments[index]} cannot be inspected`, error);
    }
    if (info.isSymbolicLink()) {
      throw forbidden(`path ${segments.join('/')} contains a symbolic link`);
    }
    if (!info.isDirectory()) {
      throw invalidInput(`path ${segments.join('/')} has a non-directory component`);
    }
  }
}

async function writeTemporary(
  targetAbsolute: string,
  leaf: string,
  raw: string
): Promise<string> {
  const directory = dirname(targetAbsolute);
  const tempPath = join(directory, `.${leaf}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
  } catch (error) {
    throw wrapIo('a temporary file could not be fsynced on the vault filesystem', error);
  } finally {
    if (handle !== undefined) await handle.close();
  }
  return tempPath;
}

export interface DocumentIndexEntry {
  path: string;
  raw: string;
  etag: string;
  id?: string;
  revision_id: string;
}

export interface DocumentIndex {
  upsert(entry: DocumentIndexEntry): void | Promise<void>;
  remove?(path: string): void | Promise<void>;
}

export interface DocumentStoreFaults {
  journalPrepare?(): void | Promise<void>;
  historyPersist?(): void | Promise<void>;
  beforeReplace?(): void | Promise<void>;
  afterReplace?(): void | Promise<void>;
  indexUpdate?(): void | Promise<void>;
}

export interface DocumentStorePutInput {
  path: string;
  raw: string;
  expectedEtag: string | null;
  idempotencyKey: string;
  source: string;
}

export interface DocumentStorePutResult {
  id: string;
  path: string;
  etag: string;
  revision_id: string;
  indexed: boolean;
}

export interface DocumentStoreReadResult {
  raw: string;
  etag: string;
  id?: string;
  revision_id?: string;
}

export interface DocumentStoreRevisionRead {
  raw: string;
  hash: string;
  id?: string;
  revision_id?: string;
}

export interface DocumentStoreRecoveryReport {
  recovered: string[];
  pending: string[];
}

export interface DocumentStore {
  put(input: DocumentStorePutInput): Promise<DocumentStorePutResult>;
  readPath(path: string): Promise<DocumentStoreReadResult>;
  readRevision(id: string, revisionId: string): Promise<DocumentStoreRevisionRead>;
  recover(): Promise<DocumentStoreRecoveryReport>;
  close(): Promise<void>;
}

export interface OpenDocumentStoreOptions {
  vault: string;
  state: string;
  index?: DocumentIndex;
  faults?: DocumentStoreFaults;
  clock?: Clock;
  ids?: IdSource;
}

function payloadHash(input: DocumentStorePutInput): string {
  return sha256(
    JSON.stringify({
      path: input.path,
      raw: input.raw,
      expectedEtag: input.expectedEtag,
      source: input.source
    })
  );
}

class LocalDocumentStore implements DocumentStore {
  private readonly vaultRoot: string;
  private readonly journal: LocalWriteJournal;
  private readonly revisions: RevisionStore;
  private readonly index: DocumentIndex | undefined;
  private readonly faults: DocumentStoreFaults;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly journalPath: string;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(input: {
    vaultRoot: string;
    journal: LocalWriteJournal;
    journalPath: string;
    revisions: RevisionStore;
    index?: DocumentIndex;
    faults: DocumentStoreFaults;
    clock: Clock;
    ids: IdSource;
  }) {
    this.vaultRoot = input.vaultRoot;
    this.journal = input.journal;
    this.journalPath = input.journalPath;
    this.revisions = input.revisions;
    this.index = input.index;
    this.faults = input.faults;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  static async open(options: OpenDocumentStoreOptions): Promise<LocalDocumentStore> {
    if (typeof options?.vault !== 'string' || options.vault.length === 0) {
      throw invalidInput('a vault directory is required');
    }
    if (typeof options.state !== 'string' || options.state.length === 0) {
      throw invalidInput('a state directory is required');
    }
    const vaultRoot = resolve(options.vault);
    const stateRoot = resolve(options.state);
    const vaultInfo = await lstat(vaultRoot).catch(() => undefined);
    if (vaultInfo === undefined || vaultInfo.isSymbolicLink() || !vaultInfo.isDirectory()) {
      throw recoveryRequired(`vault root ${vaultRoot} is not a safe directory`);
    }
    const stateInfo = await lstat(stateRoot).catch(() => undefined);
    if (stateInfo === undefined || stateInfo.isSymbolicLink() || !stateInfo.isDirectory()) {
      throw recoveryRequired(`state root ${stateRoot} is not a safe directory`);
    }
    let vaultReal: string;
    let stateReal: string;
    try {
      [vaultReal, stateReal] = await Promise.all([realpath(vaultRoot), realpath(stateRoot)]);
    } catch (error) {
      throw recoveryRequired('the vault and state roots could not be resolved', error);
    }
    if (isInside(vaultReal, stateReal) || isInside(stateReal, vaultReal)) {
      throw invalidInput('the vault and state roots must not overlap');
    }
    const journalPath = join(stateRoot, 'documents.sqlite');
    const journal = LocalWriteJournal.open(journalPath);
    let revisions: RevisionStore;
    try {
      revisions = await openRevisionStore(stateRoot);
    } catch (error) {
      journal.close();
      throw error;
    }
    const store = new LocalDocumentStore({
      vaultRoot,
      journal,
      journalPath,
      revisions,
      ...(options.index === undefined ? {} : { index: options.index }),
      faults: options.faults ?? {},
      clock: options.clock ?? systemClock,
      ids: options.ids ?? systemIds
    });
    try {
      await store.recover();
    } catch (error) {
      await store.close();
      throw error;
    }
    return store;
  }

  async put(input: DocumentStorePutInput): Promise<DocumentStorePutResult> {
    return this.withLock(() => this.putSerialized(input));
  }

  private async putSerialized(input: DocumentStorePutInput): Promise<DocumentStorePutResult> {
    this.assertOpen();
    const segments = vaultNoteSegments(input.path);
    if (typeof input.raw !== 'string') throw invalidInput('raw must be a string');
    if (Buffer.byteLength(input.raw, 'utf8') > RENDERED_NOTE_MAX_BYTES) {
      throw invalidInput('raw exceeds the rendered note size limit');
    }
    if (input.expectedEtag !== null) {
      if (typeof input.expectedEtag !== 'string' || !HASH_PATTERN.test(input.expectedEtag)) {
        throw invalidInput('expectedEtag must be null or a sha256 digest');
      }
    }
    if (
      typeof input.idempotencyKey !== 'string' ||
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH
    ) {
      throw invalidInput('idempotencyKey must be a non-empty bounded string');
    }
    if (typeof input.source !== 'string' || input.source.length > 256) {
      throw invalidInput('source must be a bounded string');
    }

    const hash = payloadHash(input);
    const parsed = parseDocument(input.raw, input.path);
    const timestamp = this.clock.now().toISOString();
    const observed = await readNoteFile(this.vaultRoot, segments);
    const observedId =
      observed === undefined ? undefined : parseDocument(observed.raw, input.path).id;
    const existingByPath = this.journal.findDocumentByPath(input.path);

    let record = this.journal.findByKey(input.idempotencyKey);
    if (record !== undefined && record.payload_hash !== hash) {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${input.idempotencyKey} was used for a different request`
      });
    }
    if (record !== undefined && record.state === 'complete' && record.receipt_json !== null) {
      return JSON.parse(record.receipt_json) as DocumentStorePutResult;
    }
    if (record !== undefined && record.state === 'conflict') {
      throw conflict('the operation previously ended in conflict and cannot be retried');
    }

    const id = record?.id ?? parsed.id ?? observedId ?? existingByPath?.id ?? this.ids.next();
    const revisionId = record?.revision_id ?? this.ids.next();
    const document = parsed.id === undefined ? { ...parsed, id } : parsed;
    const rawToWrite = parsed.id === undefined ? renderDocument(document) : input.raw;
    const revisionHash = sha256(rawToWrite);
    const preimageHash = observed?.hash ?? null;

    if (record === undefined) {
      await this.runFault('journalPrepare', 'the write journal could not be prepared');
      const reserved = this.journal.reserve({
        operation_id: this.ids.next(),
        idempotency_key: input.idempotencyKey,
        tool: 'document_put',
        path: input.path,
        payload_hash: hash,
        source: input.source,
        expected_etag: input.expectedEtag,
        id,
        revision_id: revisionId,
        preimage_hash: preimageHash,
        revision_hash: revisionHash,
        updated_at: timestamp
      });
      record = reserved.record;
    }

    const alreadyMaterialized =
      observed !== undefined && observed.hash === revisionHash && observedId === id;

    if (!alreadyMaterialized) {
      if (observed === undefined) {
        if (input.expectedEtag !== null) {
          this.markConflict(record, timestamp);
          throw conflict(`path ${input.path} does not exist for the expected etag`);
        }
        const occupied = await listVaultFilePaths(this.vaultRoot);
        if (occupied.some((entry) => collisionKey(entry) === collisionKey(input.path))) {
          this.markConflict(record, timestamp);
          throw conflict(`path ${input.path} is occupied by a case-variant note`);
        }
      } else {
        if (input.expectedEtag === null) {
          this.markConflict(record, timestamp);
          throw conflict(`path ${input.path} already exists`);
        }
        if (observed.hash !== input.expectedEtag) {
          this.markConflict(record, timestamp);
          throw conflict(`path ${input.path} changed since the expected etag`);
        }
        const observedDocument = parseDocument(observed.raw, input.path);
        if (observedDocument.id !== undefined && observedDocument.id !== id) {
          this.markConflict(record, timestamp);
          throw conflict(`path ${input.path} is managed by a different logical id`);
        }
      }
      const byPath = this.journal.findDocumentByPath(input.path);
      if (byPath !== undefined && byPath.id !== id) {
        this.markConflict(record, timestamp);
        throw conflict(`path ${input.path} is managed by another logical id`);
      }
      const byId = this.journal.findDocumentById(id);
      if (byId !== undefined && byId.path !== input.path) {
        this.markConflict(record, timestamp);
        throw conflict(`logical id ${id} already exists at ${byId.path}`);
      }
      const vaultConflict = await this.findUncataloguedId(id, input.path);
      if (vaultConflict !== undefined) {
        this.markConflict(record, timestamp);
        throw conflict(`logical id ${id} already exists at ${vaultConflict}`);
      }
    }

    try {
      await this.faults.historyPersist?.();
      if (!alreadyMaterialized && observed !== undefined) {
        await this.revisions.persistPreimage(id, observed.raw);
      }
      await this.revisions.persistRevision(id, revisionId, rawToWrite);
    } catch (error) {
      throw wrapIo('revision history could not be persisted', error);
    }
    record = this.journal.update(record.operation_id, {
      state: 'history_persisted',
      preimage_hash: preimageHash,
      revision_hash: revisionHash,
      updated_at: timestamp
    });

    if (!alreadyMaterialized) {
      await ensureWriteChain(this.vaultRoot, segments);
      const target = join(this.vaultRoot, ...segments);
      const leaf = segments[segments.length - 1];
      const tempPath = await writeTemporary(target, leaf, rawToWrite);
      try {
        await this.faults.beforeReplace?.();
        const recheck = await readNoteFile(this.vaultRoot, segments);
        if ((recheck?.hash ?? null) !== preimageHash) {
          this.markConflict(record, timestamp);
          throw conflict(`path ${input.path} changed immediately before replacement`);
        }
        if (observed === undefined) {
          await link(tempPath, target);
        } else {
          await rename(tempPath, target);
        }
        await syncDirectory(dirname(target));
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw wrapIo('the current note file could not be replaced', error);
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
      await this.runFault('afterReplace', 'the materialized write could not be journaled');
    }

    const after = await readNoteFile(this.vaultRoot, segments);
    if (after === undefined || after.hash !== revisionHash) {
      this.markConflict(record, timestamp);
      throw conflict(`path ${input.path} diverged from the persisted revision after replacement`);
    }
    return this.finalize(record, after, id, revisionId, timestamp, true);
  }

  private async findUncataloguedId(id: string, targetPath: string): Promise<string | undefined> {
    const targetKey = collisionKey(targetPath);
    const paths = await listVaultFilePaths(this.vaultRoot);
    for (const candidate of paths) {
      if (!candidate.endsWith('.md')) continue;
      if (collisionKey(candidate) === targetKey) continue;
      let segments: string[];
      try {
        segments = vaultNoteSegments(candidate);
      } catch {
        continue;
      }
      const observed = await readNoteFile(this.vaultRoot, segments);
      if (observed === undefined) continue;
      let candidateId: string | undefined;
      try {
        candidateId = parseDocument(observed.raw, candidate).id;
      } catch {
        continue;
      }
      if (candidateId === id) return candidate;
    }
    return undefined;
  }

  private async finalize(
    record: LocalWriteRecord,
    observed: { raw: string; hash: string },
    id: string,
    revisionId: string,
    timestamp: string,
    applyIndexFault: boolean
  ): Promise<DocumentStorePutResult> {
    this.journal.recordDocument({
      path: record.path,
      id,
      revision_id: revisionId,
      raw_hash: observed.hash,
      etag: observed.hash,
      updated_at: timestamp
    });
    this.journal.update(record.operation_id, {
      state: 'materialized',
      revision_hash: observed.hash,
      updated_at: timestamp
    });
    this.journal.enqueueIndex({
      path: record.path,
      revision_id: revisionId,
      raw_hash: observed.hash,
      enqueued_at: timestamp
    });
    let indexed = false;
    if (this.index !== undefined) {
      try {
        if (applyIndexFault) await this.faults.indexUpdate?.();
        await this.index.upsert({
          path: record.path,
          raw: observed.raw,
          etag: observed.hash,
          id,
          revision_id: revisionId
        });
        indexed = true;
      } catch {
        indexed = false;
      }
    }
    if (indexed) this.journal.dequeueIndex(record.path);
    const receipt: DocumentStorePutResult = {
      id,
      path: record.path,
      etag: observed.hash,
      revision_id: revisionId,
      indexed
    };
    this.journal.update(record.operation_id, {
      state: 'complete',
      indexed,
      revision_hash: observed.hash,
      receipt_json: JSON.stringify(receipt),
      updated_at: this.clock.now().toISOString()
    });
    return receipt;
  }

  private async runFault(
    fault: keyof DocumentStoreFaults,
    message: string
  ): Promise<void> {
    const hook = this.faults[fault];
    if (hook === undefined) return;
    try {
      await hook();
    } catch (error) {
      throw wrapIo(message, error);
    }
  }

  async readPath(path: string): Promise<DocumentStoreReadResult> {
    this.assertOpen();
    const segments = vaultNoteSegments(path);
    const observed = await readNoteFile(this.vaultRoot, segments);
    if (observed === undefined) throw notFound(`path ${path} does not exist`);
    const document = parseDocument(observed.raw, path);
    const catalogue = this.journal.findDocumentByPath(path);
    const id = document.id ?? catalogue?.id;
    const revision_id =
      catalogue !== undefined && catalogue.raw_hash === observed.hash
        ? catalogue.revision_id
        : undefined;
    return {
      raw: observed.raw,
      etag: observed.hash,
      ...(id === undefined ? {} : { id }),
      ...(revision_id === undefined ? {} : { revision_id })
    };
  }

  async readRevision(id: string, revisionId: string): Promise<DocumentStoreRevisionRead> {
    this.assertOpen();
    const stored = await this.revisions.readRevision(id, revisionId);
    return {
      raw: stored.raw,
      hash: stored.hash,
      id: stored.id,
      revision_id: stored.revision_id
    };
  }

  async recover(): Promise<DocumentStoreRecoveryReport> {
    this.assertOpen();
    const recovered = new Set<string>();
    const pending = new Set<string>();
    for (const record of this.journal.listIncomplete()) {
      const outcome = await this.completeIncomplete(record);
      if (outcome === 'recovered') {
        recovered.add(record.path);
        pending.delete(record.path);
      } else if (outcome === 'pending') {
        pending.add(record.path);
      }
    }
    const indexReport = await this.reconcileIndex();
    for (const path of indexReport.recovered) {
      recovered.add(path);
      pending.delete(path);
    }
    for (const path of indexReport.pending) pending.add(path);
    return { recovered: [...recovered], pending: [...pending] };
  }

  private async completeIncomplete(
    record: LocalWriteRecord
  ): Promise<'recovered' | 'pending' | 'skip'> {
    if (record.id === null || record.revision_id === null || record.revision_hash === null) {
      return 'skip';
    }
    let segments: string[];
    try {
      segments = vaultNoteSegments(record.path);
    } catch {
      return 'skip';
    }
    const observed = await readNoteFile(this.vaultRoot, segments);
    if (observed === undefined || observed.hash !== record.revision_hash) return 'skip';
    let observedId: string | undefined;
    try {
      observedId = parseDocument(observed.raw, record.path).id;
    } catch {
      return 'skip';
    }
    if (observedId !== record.id) return 'skip';
    const receipt = await this.finalize(
      record,
      observed,
      record.id,
      record.revision_id,
      this.clock.now().toISOString(),
      false
    );
    return receipt.indexed ? 'recovered' : 'pending';
  }

  private async reconcileIndex(): Promise<DocumentStoreRecoveryReport> {
    const recovered: string[] = [];
    const pending: string[] = [];
    for (const row of this.journal.listIndex()) {
      let segments: string[];
      try {
        segments = vaultNoteSegments(row.path);
      } catch {
        pending.push(row.path);
        continue;
      }
      const observed = await readNoteFile(this.vaultRoot, segments);
      if (observed === undefined || observed.hash !== row.raw_hash) {
        pending.push(row.path);
        continue;
      }
      if (this.index === undefined) {
        pending.push(row.path);
        continue;
      }
      let id: string | undefined;
      try {
        id = parseDocument(observed.raw, row.path).id;
      } catch {
        pending.push(row.path);
        continue;
      }
      try {
        await this.index.upsert({
          path: row.path,
          raw: observed.raw,
          etag: observed.hash,
          ...(id === undefined ? {} : { id }),
          revision_id: row.revision_id
        });
      } catch {
        pending.push(row.path);
        continue;
      }
      this.journal.dequeueIndex(row.path);
      this.markOperationIndexed(row.revision_id);
      recovered.push(row.path);
    }
    return { recovered, pending };
  }

  private markOperationIndexed(revisionId: string): void {
    const operation = this.journal.findByRevision(revisionId);
    if (operation === undefined || operation.receipt_json === null || operation.indexed) return;
    const receipt = JSON.parse(operation.receipt_json) as DocumentStorePutResult;
    this.journal.update(operation.operation_id, {
      indexed: true,
      receipt_json: JSON.stringify({ ...receipt, indexed: true }),
      updated_at: this.clock.now().toISOString()
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    this.revisions.close();
    this.journal.close();
  }

  private markConflict(record: LocalWriteRecord, timestamp: string): void {
    this.journal.update(record.operation_id, { state: 'conflict', updated_at: timestamp });
  }

  private withLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw invalidInput(`document store ${this.journalPath} is closed`);
  }
}

export async function openDocumentStore(
  options: OpenDocumentStoreOptions
): Promise<DocumentStore> {
  return LocalDocumentStore.open(options);
}
