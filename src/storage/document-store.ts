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
import {
  planRename,
  renameSegments,
  type RenameFileSnapshot,
  type RenamePlan,
  type RenameReceipt
} from '../notes/rename.js';
import { LocalWriteJournal, type LocalMoveRecord, type LocalMoveFileRecord, type LocalWriteRecord } from './journal.js';
import { openRevisionStore, revisionHasId, type RevisionStore } from './revision-store.js';
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

interface MoveManifest {
  from: string;
  to: string;
  source_hash: string;
  moves: { from: string; to: string }[];
  edits: { path: string; expected_hash: string }[];
}

function parseMoveManifest(raw: string): MoveManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw recoveryRequired('a stored move manifest is not valid JSON', error);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw recoveryRequired('a stored move manifest is malformed');
  }
  const candidate = parsed as {
    from?: unknown;
    to?: unknown;
    source_hash?: unknown;
    moves?: unknown;
    edits?: unknown;
  };
  if (
    typeof candidate.from !== 'string' ||
    typeof candidate.to !== 'string' ||
    typeof candidate.source_hash !== 'string' ||
    !HASH_PATTERN.test(candidate.source_hash) ||
    !Array.isArray(candidate.moves) ||
    !Array.isArray(candidate.edits)
  ) {
    throw recoveryRequired('a stored move manifest is malformed');
  }
  for (const step of candidate.moves) {
    if (
      step === null ||
      typeof step !== 'object' ||
      typeof (step as { from?: unknown }).from !== 'string' ||
      typeof (step as { to?: unknown }).to !== 'string'
    ) {
      throw recoveryRequired('a stored move manifest has a malformed step');
    }
  }
  for (const edit of candidate.edits) {
    if (
      edit === null ||
      typeof edit !== 'object' ||
      typeof (edit as { path?: unknown }).path !== 'string' ||
      typeof (edit as { expected_hash?: unknown }).expected_hash !== 'string'
    ) {
      throw recoveryRequired('a stored move manifest has a malformed edit');
    }
  }
  return candidate as unknown as MoveManifest;
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
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
  rename?: RenameFaults;
}

export interface RenameFaults {
  afterReserve?(): void | Promise<void>;
  afterManifest?(): void | Promise<void>;
  afterValidate?(): void | Promise<void>;
  afterMove?(): void | Promise<void>;
  afterEdit?(path: string): void | Promise<void>;
  afterRecords?(): void | Promise<void>;
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
  applyRename(plan: RenamePlan): Promise<RenameReceipt>;
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
    if (!revisionHasId(rawToWrite, id)) {
      throw invalidInput('the managed note must have a readable frontmatter id matching its logical id');
    }
    const revisionHash = sha256(rawToWrite);
    const preimageHash = record === undefined ? observed?.hash ?? null : record.preimage_hash;
    const hadReservation = record !== undefined;
    if (record !== undefined && record.revision_hash !== revisionHash) {
      throw recoveryRequired(`reserved revision ${revisionId} differs from the proposed bytes`);
    }

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
      hadReservation && observed !== undefined && observed.hash === record.revision_hash && observedId === id;

    if (!alreadyMaterialized) {
      if (record.preimage_hash !== (observed?.hash ?? null)) {
        this.markConflict(record, timestamp);
        throw conflict(`path ${input.path} changed since the operation was reserved`);
      }
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
    }
    const collision = await this.findIdCollision(id, input.path);
    if (collision !== undefined) {
      this.markConflict(record, timestamp);
      throw conflict(`logical id ${id} already exists at ${collision}`);
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
      updated_at: timestamp
    });

    await this.verifyDurableHistory(record);

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
    await this.verifyDurableHistory(record);
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

  private async findIdCollision(id: string, path: string): Promise<string | undefined> {
    const byPath = this.journal.findDocumentByPath(path);
    if (byPath !== undefined && byPath.id !== id) return path;
    const byId = this.journal.findDocumentById(id);
    if (byId !== undefined && byId.path !== path) return byId.path;
    return this.findUncataloguedId(id, path);
  }

  private async verifyDurableHistory(record: LocalWriteRecord): Promise<void> {
    if (record.id === null || record.revision_id === null || record.revision_hash === null) {
      throw recoveryRequired(`operation ${record.operation_id} has no reserved revision`);
    }
    try {
      if (record.preimage_hash !== null) {
        await this.revisions.verifyPreimage(record.id, record.preimage_hash);
      }
      const revision = await this.revisions.readRevision(record.id, record.revision_id);
      if (revision.hash !== record.revision_hash) {
        throw recoveryRequired(`revision ${record.revision_id} differs from the reserved hash`);
      }
    } catch (error) {
      if (isBrainError(error) && error.code === 'NOT_FOUND') {
        throw recoveryRequired(`history for operation ${record.operation_id} is incomplete`, error);
      }
      throw wrapIo(`history for operation ${record.operation_id} is incomplete`, error);
    }
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
    fault: Exclude<keyof DocumentStoreFaults, 'rename'>,
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

  applyRename(plan: RenamePlan): Promise<RenameReceipt> {
    return this.withLock(() => this.applyRenameSerialized(plan));
  }

  private async applyRenameSerialized(plan: RenamePlan): Promise<RenameReceipt> {
    this.assertOpen();
    if (plan === null || typeof plan !== 'object') throw invalidInput('a rename plan is required');
    if (!Array.isArray(plan.conflicts) || !Array.isArray(plan.moves)) {
      throw invalidInput('the rename plan is malformed');
    }
    if (plan.conflicts.length > 0) {
      throw conflict('the rename plan still reports conflicts');
    }
    renameSegments(plan.from);
    renameSegments(plan.to);
    if (typeof plan.source_hash !== 'string' || !HASH_PATTERN.test(plan.source_hash)) {
      throw invalidInput('the rename plan is missing its source hash');
    }
    if (plan.moves.length === 0) throw invalidInput('the rename plan has no move steps');
    for (const step of plan.moves) {
      renameSegments(step.from);
      renameSegments(step.to);
    }
    const edits = Array.isArray(plan.edits) ? plan.edits : [];
    for (const edit of edits) {
      if (edit === null || typeof edit !== 'object') throw invalidInput('a rename edit is malformed');
      renameSegments(edit.path);
      if (typeof edit.expected_hash !== 'string' || !HASH_PATTERN.test(edit.expected_hash)) {
        throw invalidInput('a rename edit is missing its expected hash');
      }
      if (typeof edit.raw !== 'string') throw invalidInput('a rename edit is missing its bytes');
      if (Buffer.byteLength(edit.raw, 'utf8') > RENDERED_NOTE_MAX_BYTES) {
        throw limitExceeded('a rename edit exceeds the rendered note size limit');
      }
    }

    const key =
      typeof plan.idempotency_key === 'string' && plan.idempotency_key.length > 0
        ? plan.idempotency_key
        : `rename:${plan.from}->${plan.to}`;
    const payloadHash = sha256(
      JSON.stringify({
        from: plan.from,
        to: plan.to,
        source_hash: plan.source_hash,
        moves: plan.moves,
        edits
      })
    );
    let record = this.journal.findMoveByKey(key);
    if (record !== undefined && record.payload_hash !== payloadHash) {
      throw new BrainError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `idempotency key ${key} was used for a different move`
      });
    }
    if (record !== undefined && record.state === 'complete' && record.receipt_json !== null) {
      return JSON.parse(record.receipt_json) as RenameReceipt;
    }
    if (record !== undefined && record.state === 'conflict') {
      throw conflict('the move previously ended in conflict and cannot be retried');
    }

    if (record === undefined) {
      const timestamp = this.clock.now().toISOString();
      const reserved = this.journal.reserveMove({
        operation_id: this.ids.next(),
        idempotency_key: key,
        from_path: plan.from,
        to_path: plan.to,
        payload_hash: payloadHash,
        manifest_json: JSON.stringify({
          from: plan.from,
          to: plan.to,
          source_hash: plan.source_hash,
          moves: plan.moves,
          edits: edits.map((edit) => ({ path: edit.path, expected_hash: edit.expected_hash }))
        }),
        created_at: timestamp,
        updated_at: timestamp
      });
      record = reserved.record;
      await this.runRenameFault('afterReserve', 'the move could not be reserved');
      const source = await readNoteFile(this.vaultRoot, renameSegments(plan.from));
      if (source === undefined) {
        this.markMoveConflict(record.operation_id);
        throw conflict(`move source ${plan.from} does not exist`);
      }
      if (source.hash !== plan.source_hash) {
        this.markMoveConflict(record.operation_id);
        throw conflict(`move source ${plan.from} changed before the move`);
      }
      this.journal.insertMoveFile({
        operation_id: record.operation_id,
        path: plan.from,
        role: 'source',
        expected_hash: plan.source_hash,
        new_hash: null,
        new_raw: null,
        preimage_raw: source.raw,
        state: 'pending',
        updated_at: timestamp
      });
      for (const edit of edits) {
        const existing = await readNoteFile(this.vaultRoot, renameSegments(edit.path));
        if (existing === undefined) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`move edit target ${edit.path} does not exist`);
        }
        if (existing.hash !== edit.expected_hash) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`file ${edit.path} changed before the move`);
        }
        this.journal.insertMoveFile({
          operation_id: record.operation_id,
          path: edit.path,
          role: 'edit',
          expected_hash: edit.expected_hash,
          new_hash: sha256(edit.raw),
          new_raw: edit.raw,
          preimage_raw: existing.raw,
          state: 'pending',
          updated_at: timestamp
        });
      }
      record = this.journal.updateMove(record.operation_id, {
        state: 'manifest_persisted',
        updated_at: this.clock.now().toISOString()
      });
      await this.runRenameFault('afterManifest', 'the move manifest could not be persisted');
    }
    return this.runMove(record);
  }

  private async runMove(record: LocalMoveRecord): Promise<RenameReceipt> {
    const manifest = parseMoveManifest(record.manifest_json);
    const files = this.journal.listMoveFiles(record.operation_id);
    const sourceRow = files.find((file) => file.role === 'source');
    const editRows = files.filter((file) => file.role === 'edit');
    if (sourceRow === undefined) {
      this.markMoveConflict(record.operation_id);
      throw conflict(`move ${record.operation_id} has no source row`);
    }
    const fromSegments = renameSegments(manifest.from);
    const toSegments = renameSegments(manifest.to);
    try {
      const fromRead = await readNoteFile(this.vaultRoot, fromSegments);
      const toRead = await readNoteFile(this.vaultRoot, toSegments);
      const sourceFinalHash =
        editRows.find((edit) => edit.path === manifest.from)?.new_hash ?? sourceRow.expected_hash;
      const sourceMoved =
        fromRead === undefined &&
        toRead !== undefined &&
        (toRead.hash === sourceRow.expected_hash || toRead.hash === sourceFinalHash);

      for (const edit of editRows) {
        if (edit.state === 'applied') continue;
        const actualPath =
          edit.path === manifest.from
            ? sourceMoved
              ? manifest.to
              : manifest.from
            : edit.path;
        const observed = await readNoteFile(this.vaultRoot, renameSegments(actualPath));
        if (
          observed === undefined ||
          (observed.hash !== edit.expected_hash && observed.hash !== edit.new_hash)
        ) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`file ${actualPath} changed during the move`);
        }
      }

      if (!sourceMoved) {
        if (fromRead === undefined || fromRead.hash !== sourceRow.expected_hash) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`move source ${manifest.from} changed during the move`);
        }
        const occupied = await listVaultFilePaths(this.vaultRoot);
        const targetKey = collisionKey(manifest.to);
        const reservedTargets = new Set(manifest.moves.map((step) => step.to));
        for (const path of occupied) {
          if (path === manifest.from) continue;
          if (collisionKey(path) === targetKey || reservedTargets.has(path)) {
            this.markMoveConflict(record.operation_id);
            throw conflict(`move target ${path} is occupied`);
          }
        }
      }

      this.journal.updateMove(record.operation_id, {
        state: 'validated',
        updated_at: this.clock.now().toISOString()
      });
      await this.runRenameFault('afterValidate', 'the move could not be validated');

      if (!sourceMoved) {
        for (const step of manifest.moves) {
          const stepFrom = renameSegments(step.from);
          const stepTo = renameSegments(step.to);
          const current = await readNoteFile(this.vaultRoot, stepFrom);
          if (current === undefined) {
            const already = await readNoteFile(this.vaultRoot, stepTo);
            if (already !== undefined && already.hash === sourceRow.expected_hash) continue;
            this.markMoveConflict(record.operation_id);
            throw conflict(`move step source ${step.from} does not exist`);
          }
          if (current.hash !== sourceRow.expected_hash) {
            this.markMoveConflict(record.operation_id);
            throw conflict(`move step source ${step.from} changed`);
          }
          const destination = await readNoteFile(this.vaultRoot, stepTo);
          if (destination !== undefined) {
            this.markMoveConflict(record.operation_id);
            throw conflict(`move step target ${step.to} is occupied`);
          }
          await ensureWriteChain(this.vaultRoot, stepTo);
          try {
            await rename(join(this.vaultRoot, ...stepFrom), join(this.vaultRoot, ...stepTo));
            await syncDirectory(dirname(join(this.vaultRoot, ...stepTo)));
          } catch (error) {
            throw wrapIo('the note file could not be moved', error);
          }
        }
      }

      this.journal.updateMove(record.operation_id, {
        state: 'moved',
        updated_at: this.clock.now().toISOString()
      });
      await this.runRenameFault('afterMove', 'the move could not be recorded');

      for (const edit of editRows) {
        if (edit.state === 'applied') continue;
        const actualPath = edit.path === manifest.from ? manifest.to : edit.path;
        const segments = renameSegments(actualPath);
        const observed = await readNoteFile(this.vaultRoot, segments);
        if (observed !== undefined && observed.hash === edit.new_hash) {
          this.journal.updateMoveFile(
            record.operation_id,
            edit.path,
            'edit',
            'applied',
            this.clock.now().toISOString()
          );
          continue;
        }
        if (observed === undefined || observed.hash !== edit.expected_hash) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`file ${actualPath} changed immediately before the rewrite`);
        }
        if (edit.new_raw === null) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`move edit ${edit.path} has no replacement bytes`);
        }
        const target = join(this.vaultRoot, ...segments);
        const leaf = segments[segments.length - 1];
        const tempPath = await writeTemporary(target, leaf, edit.new_raw);
        try {
          const recheck = await readNoteFile(this.vaultRoot, segments);
          if ((recheck?.hash ?? null) !== edit.expected_hash) {
            this.markMoveConflict(record.operation_id);
            throw conflict(`file ${actualPath} changed immediately before the rewrite`);
          }
          await rename(tempPath, target);
          await syncDirectory(dirname(target));
        } catch (error) {
          await rm(tempPath, { force: true }).catch(() => undefined);
          throw wrapIo('a rewritten reference file could not be replaced', error);
        } finally {
          await rm(tempPath, { force: true }).catch(() => undefined);
        }
        this.journal.updateMoveFile(
          record.operation_id,
          edit.path,
          'edit',
          'applied',
          this.clock.now().toISOString()
        );
        await this.runRenameFault('afterEdit', 'the move edit could not be recorded', edit.path);
      }

      this.journal.updateMove(record.operation_id, {
        state: 'edits_applied',
        updated_at: this.clock.now().toISOString()
      });

      const indexed = await this.updateMoveRecords(manifest, editRows);
      this.journal.updateMove(record.operation_id, {
        state: 'records_updated',
        updated_at: this.clock.now().toISOString()
      });
      await this.runRenameFault('afterRecords', 'the move records could not be updated');

      const verified = await this.verifyMove(manifest, files);
      if (!verified) {
        this.markMoveConflict(record.operation_id);
        throw conflict('the rewritten references did not verify');
      }

      const receipt: RenameReceipt = {
        operation_id: record.operation_id,
        from: manifest.from,
        to: manifest.to,
        moved: true,
        edited: editRows.map((edit) => edit.path),
        indexed,
        verified: true
      };
      this.journal.updateMove(record.operation_id, {
        state: 'complete',
        receipt_json: JSON.stringify(receipt),
        updated_at: this.clock.now().toISOString()
      });
      return receipt;
    } catch (error) {
      if (isBrainError(error) && error.code === 'CONFLICT') throw error;
      throw wrapIo('the move could not be completed', error);
    }
  }

  private async updateMoveRecords(
    manifest: MoveManifest,
    editRows: readonly LocalMoveFileRecord[]
  ): Promise<string[]> {
    const timestamp = this.clock.now().toISOString();
    const indexed: string[] = [];
    const prior = this.journal.findDocumentByPath(manifest.from);
    this.journal.deleteDocument(manifest.from);
    const finalSource = await readNoteFile(this.vaultRoot, renameSegments(manifest.to));
    if (finalSource !== undefined && prior !== undefined) {
      this.journal.recordDocument({
        path: manifest.to,
        id: prior.id,
        revision_id: prior.revision_id,
        raw_hash: finalSource.hash,
        etag: finalSource.hash,
        updated_at: timestamp
      });
      this.journal.enqueueIndex({
        path: manifest.to,
        revision_id: prior.revision_id,
        raw_hash: finalSource.hash,
        enqueued_at: timestamp
      });
      if (this.index !== undefined) {
        try {
          this.index.remove?.(manifest.from);
          await this.index.upsert({
            path: manifest.to,
            raw: finalSource.raw,
            etag: finalSource.hash,
            id: prior.id,
            revision_id: prior.revision_id
          });
          indexed.push(manifest.to);
        } catch {
        }
      }
    } else if (this.index !== undefined) {
      try {
        this.index.remove?.(manifest.from);
      } catch {
      }
    }
    for (const edit of editRows) {
      if (edit.path === manifest.from) continue;
      const observed = await readNoteFile(this.vaultRoot, renameSegments(edit.path));
      if (observed === undefined) continue;
      const document = this.journal.findDocumentByPath(edit.path);
      this.journal.enqueueIndex({
        path: edit.path,
        revision_id: document?.revision_id ?? observed.hash,
        raw_hash: observed.hash,
        enqueued_at: timestamp
      });
      if (this.index !== undefined && document !== undefined) {
        try {
          await this.index.upsert({
            path: edit.path,
            raw: observed.raw,
            etag: observed.hash,
            id: document.id,
            revision_id: document.revision_id
          });
          indexed.push(edit.path);
        } catch {
        }
      }
    }
    return indexed;
  }

  private async verifyMove(
    manifest: MoveManifest,
    files: readonly LocalMoveFileRecord[]
  ): Promise<boolean> {
    const affected = new Set<string>();
    const snapshots: RenameFileSnapshot[] = [];
    for (const file of files) {
      if (affected.has(file.path)) continue;
      affected.add(file.path);
      snapshots.push({ path: file.path, raw: file.preimage_raw, hash: file.expected_hash });
    }
    let paths: string[];
    try {
      paths = await listVaultFilePaths(this.vaultRoot);
    } catch {
      return false;
    }
    for (const path of paths) {
      if (affected.has(path) || path === manifest.to) continue;
      let observed: { raw: string; hash: string } | undefined;
      try {
        observed = await readNoteFile(this.vaultRoot, renameSegments(path));
      } catch {
        continue;
      }
      if (observed === undefined) continue;
      snapshots.push({ path, raw: observed.raw, hash: observed.hash });
    }
    let replanned: RenamePlan;
    try {
      replanned = planRename({ from: manifest.from, to: manifest.to, files: snapshots });
    } catch {
      return false;
    }
    const expected = new Map(replanned.edits.map((edit) => [edit.path, edit.raw]));
    const observedEdits = new Map<string, string>();
    for (const file of files) {
      if (file.role !== 'edit' || file.new_raw === null) continue;
      observedEdits.set(file.path, file.new_raw);
    }
    if (expected.size !== observedEdits.size) return false;
    for (const [path, raw] of observedEdits) {
      if (expected.get(path) !== raw) return false;
    }
    return true;
  }

  private markMoveConflict(operation_id: string): void {
    this.journal.updateMove(operation_id, {
      state: 'conflict',
      updated_at: this.clock.now().toISOString()
    });
  }

  private async runRenameFault(
    name: keyof RenameFaults,
    message: string,
    detail?: string
  ): Promise<void> {
    const hooks = this.faults.rename as
      | Record<string, ((value?: string) => void | Promise<void>) | undefined>
      | undefined;
    if (hooks === undefined) return;
    const hook = hooks[name];
    if (hook === undefined) return;
    try {
      await hook(detail);
    } catch (error) {
      throw wrapIo(message, error);
    }
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
    for (const move of this.journal.listIncompleteMoves()) {
      const outcome = await this.resumeMove(move);
      if (outcome === 'recovered') {
        recovered.add(move.to_path);
        pending.delete(move.to_path);
      } else {
        pending.add(move.to_path);
      }
    }
    return { recovered: [...recovered], pending: [...pending] };
  }

  private async resumeMove(record: LocalMoveRecord): Promise<'recovered' | 'pending'> {
    try {
      await this.runMove(record);
      return 'recovered';
    } catch {
      return 'pending';
    }
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
    try {
      await this.verifyDurableHistory(record);
    } catch (error) {
      if (isBrainError(error) && error.code === 'RECOVERY_REQUIRED') return 'skip';
      throw error;
    }
    if (await this.findIdCollision(record.id, record.path) !== undefined) return 'skip';
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
