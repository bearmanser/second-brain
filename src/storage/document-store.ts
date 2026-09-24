import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
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
const MOVE_MAX_BYTES = 8 * 1024 * 1024;

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
  segments: string[],
  options: { maxBytes?: number; requireUtf8?: boolean } = {}
): Promise<{ raw: string; hash: string; text: boolean; bytes: Buffer } | undefined> {
  const maxBytes = options.maxBytes ?? RENDERED_NOTE_MAX_BYTES;
  const requireUtf8 = options.requireUtf8 ?? true;
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
  if (info.size > maxBytes) {
    throw limitExceeded(
      `file ${segments.join('/')} is ${info.size} bytes and exceeds the ${maxBytes} byte limit`
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
    const bounded = await readBoundedBytes(handle, maxBytes);
    if (bounded.kind === 'overflow') {
      throw limitExceeded(`file ${segments.join('/')} exceeds the ${maxBytes} byte limit`);
    }
    buffer = bounded.buffer;
  } finally {
    await handle.close();
  }
  const raw = buffer.toString('utf8');
  const text = Buffer.from(raw, 'utf8').equals(buffer);
  if (requireUtf8 && !text) {
    throw invalidInput(`file ${segments.join('/')} is not valid UTF-8`);
  }
  return { raw, hash: sha256(buffer), text, bytes: buffer };
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
  beforeMoveStep?(ordinal: string): void | Promise<void>;
  afterMoveLink?(ordinal: string): void | Promise<void>;
  afterMoveStage?(): void | Promise<void>;
  afterMoveStep?(ordinal: string): void | Promise<void>;
  afterMove?(): void | Promise<void>;
  beforeEditReplace?(path: string): void | Promise<void>;
  afterEditInodeCheck?(path: string): void | Promise<void>;
  afterEditInstall?(path: string): void | Promise<void>;
  beforeSourceRevisionPersist?(): void | Promise<void>;
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
      const source = await readNoteFile(this.vaultRoot, renameSegments(plan.from), {
        maxBytes: MOVE_MAX_BYTES,
        requireUtf8: false
      });
      if (source === undefined) {
        throw conflict(`move source ${plan.from} does not exist`);
      }
      if (source.hash !== plan.source_hash) {
        throw conflict(`move source ${plan.from} changed before the move`);
      }
      const operationId = this.ids.next();
      const fileRecords: LocalMoveFileRecord[] = [
        {
          operation_id: operationId,
          path: plan.from,
          role: 'source',
          expected_hash: plan.source_hash,
          new_hash: null,
          new_raw: null,
          preimage_raw: source.bytes,
          state: 'pending',
          updated_at: timestamp
        }
      ];
      for (const edit of edits) {
        const existing = await readNoteFile(this.vaultRoot, renameSegments(edit.path));
        if (existing === undefined) {
          throw conflict(`move edit target ${edit.path} does not exist`);
        }
        if (existing.hash !== edit.expected_hash) {
          throw conflict(`file ${edit.path} changed before the move`);
        }
        fileRecords.push({
          operation_id: operationId,
          path: edit.path,
          role: 'edit',
          expected_hash: edit.expected_hash,
          new_hash: sha256(edit.raw),
          new_raw: edit.raw,
          preimage_raw: existing.bytes,
          state: 'pending',
          updated_at: timestamp
        });
      }
      const stepRecords = plan.moves.map((step, ordinal) => ({
        ordinal,
        from_path: step.from,
        to_path: step.to,
        state: 'pending' as const,
        updated_at: timestamp
      }));
      const reserved = this.journal.reserveMove(
        {
          operation_id: operationId,
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
        },
        fileRecords,
        stepRecords
      );
      record = reserved.record;
      await this.runRenameFault('afterReserve', 'the move could not be reserved');
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
    const steps = this.journal.listMoveSteps(record.operation_id);
    const sourceRow = files.find((file) => file.role === 'source');
    const editRows = files.filter((file) => file.role === 'edit');
    if (sourceRow === undefined || files.length !== 1 + manifest.edits.length) {
      this.markMoveConflict(record.operation_id);
      throw conflict(`move ${record.operation_id} has an incomplete manifest`);
    }
    if (steps.length !== manifest.moves.length) {
      this.markMoveConflict(record.operation_id);
      throw conflict(`move ${record.operation_id} has incomplete move steps`);
    }
    const editForSource = editRows.find((edit) => edit.path === manifest.from);
    const sourceFinalHash = editForSource?.new_hash ?? sourceRow.expected_hash;
    try {
      await this.assertNoMoveStages(record.operation_id, [
        ...steps.flatMap((step) => [step.from_path, step.to_path]),
        ...editRows.map((edit) => edit.path)
      ]);
      const location = await this.locateMoveSource(manifest, steps, sourceRow.expected_hash, sourceFinalHash);
      let startPath: string;
      if (location.kind === 'duplicate') {
        startPath = await this.deduplicateMoveSource(
          location.paths,
          steps,
          record.operation_id
        );
      } else if (location.kind === 'occupied') {
        this.markMoveConflict(record.operation_id);
        throw conflict(`move target ${location.path} is occupied`);
      } else if (location.kind === 'missing') {
        this.markMoveConflict(record.operation_id);
        throw conflict(`move source ${manifest.from} is missing`);
      } else {
        startPath = location.path;
      }

      const sourceAtFinal = startPath === manifest.to;
      for (const edit of editRows) {
        if (edit.state === 'applied') continue;
        const actualPath =
          edit.path === manifest.from ? (sourceAtFinal ? manifest.to : manifest.from) : edit.path;
        const observed = await this.readMoveBytes(actualPath);
        if (
          observed === undefined ||
          (observed.hash !== edit.expected_hash && observed.hash !== edit.new_hash)
        ) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`file ${actualPath} changed during the move`);
        }
      }

      this.journal.updateMove(record.operation_id, {
        state: 'validated',
        updated_at: this.clock.now().toISOString()
      });
      await this.runRenameFault('afterValidate', 'the move could not be validated');

      let current = startPath;
      for (const step of steps) {
        const fromSeg = renameSegments(step.from_path);
        const toSeg = renameSegments(step.to_path);
        const atFrom = await this.readMoveBytes(step.from_path);
        const atTo = await this.readMoveBytes(step.to_path);
        const toHasSource = atTo !== undefined &&
          (atTo.hash === sourceRow.expected_hash ||
            (step.to_path === manifest.to && atTo.hash === sourceFinalHash));
        const fromHasSource = atFrom !== undefined && atFrom.hash === sourceRow.expected_hash;
        if (atFrom !== undefined && !fromHasSource) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`move step source ${step.from_path} changed`);
        }
        if (toHasSource) {
          if (fromHasSource) {
            const same = await this.sameVaultInode(step.from_path, step.to_path);
            if (!same) {
              this.markMoveConflict(record.operation_id);
              throw conflict(`move step ${step.from_path} duplicated with different bytes`);
            }
            await this.removeLinkedMoveSource(step.from_path, step.to_path, record.operation_id);
          }
          if (step.state !== 'complete') {
            this.journal.updateMoveStep(
              record.operation_id,
              step.ordinal,
              'complete',
              this.clock.now().toISOString()
            );
          }
          current = step.to_path;
          continue;
        }
        if (atTo !== undefined) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`move target ${step.to_path} is occupied`);
        }
        if (!fromHasSource) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`move step source ${step.from_path} changed or is missing`);
        }
        await ensureWriteChain(this.vaultRoot, toSeg);
        await this.runRenameFault(
          'beforeMoveStep',
          'the move step could not start',
          String(step.ordinal)
        );
        try {
          await link(join(this.vaultRoot, ...fromSeg), join(this.vaultRoot, ...toSeg));
        } catch (error) {
          if (hasErrno(error, 'EEXIST')) {
            this.markMoveConflict(record.operation_id);
            throw conflict(`move target ${step.to_path} was occupied concurrently`);
          }
          throw wrapIo('the note file could not be moved', error);
        }
        await syncDirectory(dirname(join(this.vaultRoot, ...toSeg)));
        await this.runRenameFault('afterMoveLink', 'the move source could not be removed', String(step.ordinal));
        await this.removeLinkedMoveSource(step.from_path, step.to_path, record.operation_id);
        this.journal.updateMoveStep(
          record.operation_id,
          step.ordinal,
          'complete',
          this.clock.now().toISOString()
        );
        await this.runRenameFault(
          'afterMoveStep',
          'the move step could not be recorded',
          String(step.ordinal)
        );
        current = step.to_path;
      }
      if (current !== manifest.to) {
        this.markMoveConflict(record.operation_id);
        throw conflict('the move did not reach its destination');
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
        const observed = await this.readMoveBytes(actualPath);
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
        await this.replaceMoveEdit(record.operation_id, actualPath, segments, edit);
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

      const finalSource = await this.readMoveBytes(manifest.to);
      if (finalSource === undefined || finalSource.hash !== sourceFinalHash) {
        this.markMoveConflict(record.operation_id);
        throw conflict('the moved note diverged from its expected bytes');
      }
      if (await this.movePathExists(manifest.from)) {
        this.markMoveConflict(record.operation_id);
        throw conflict(`move source ${manifest.from} still exists`);
      }
      for (const edit of editRows) {
        const actualPath = edit.path === manifest.from ? manifest.to : edit.path;
        const currentEdit = await this.readMoveBytes(actualPath);
        if (currentEdit === undefined || currentEdit.hash !== edit.new_hash) {
          this.markMoveConflict(record.operation_id);
          throw conflict(`file ${actualPath} diverged after the rewrite`);
        }
      }

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
    const finalSource = await this.readMoveText(manifest.to);
    if (prior !== undefined && finalSource === undefined) {
      throw conflict(`managed move source ${manifest.to} cannot be read`);
    }
    if (finalSource !== undefined && prior !== undefined) {
      let revisionId = prior.revision_id;
      if (finalSource.hash !== prior.raw_hash) {
        await this.runRenameFault('beforeSourceRevisionPersist', 'the moved revision could not be persisted');
        revisionId = this.ids.next();
        await this.revisions.persistRevision(prior.id, revisionId, finalSource.raw);
      }
      this.journal.moveDocument({
        path: manifest.to,
        id: prior.id,
        revision_id: revisionId,
        raw_hash: finalSource.hash,
        etag: finalSource.hash,
        updated_at: timestamp
      }, manifest.from);
      this.journal.enqueueIndex({
        path: manifest.to,
        revision_id: revisionId,
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
            revision_id: revisionId
          });
          indexed.push(manifest.to);
        } catch {
        }
      }
    } else {
      this.journal.deleteDocument(manifest.from);
      if (this.index !== undefined) {
        try {
          this.index.remove?.(manifest.from);
        } catch {
        }
      }
    }
    for (const edit of editRows) {
      if (edit.path === manifest.from) continue;
      const observed = await this.readMoveText(edit.path);
      if (observed === undefined) continue;
      const revisionId = await this.persistEditedDocument(
        edit.path,
        observed.raw,
        observed.hash,
        timestamp
      );
      this.journal.enqueueIndex({
        path: edit.path,
        revision_id: revisionId ?? observed.hash,
        raw_hash: observed.hash,
        enqueued_at: timestamp
      });
      if (this.index !== undefined && revisionId !== undefined) {
        const document = this.journal.findDocumentByPath(edit.path);
        if (document !== undefined) {
          try {
            await this.index.upsert({
              path: edit.path,
              raw: observed.raw,
              etag: observed.hash,
              id: document.id,
              revision_id: revisionId
            });
            indexed.push(edit.path);
          } catch {
          }
        }
      }
    }
    return indexed;
  }

  private async persistEditedDocument(
    path: string,
    raw: string,
    hash: string,
    timestamp: string
  ): Promise<string | undefined> {
    const existing = this.journal.findDocumentByPath(path);
    let id = existing?.id;
    if (id === undefined) {
      try {
        id = parseDocument(raw, path).id;
      } catch {
        id = undefined;
      }
    }
    if (id === undefined) return undefined;
    if (existing !== undefined && existing.raw_hash === hash) return existing.revision_id;
    const elsewhere = this.journal.findDocumentById(id);
    if (elsewhere !== undefined && elsewhere.path !== path) return undefined;
    const revisionId = this.ids.next();
    await this.revisions.persistRevision(id, revisionId, raw);
    this.journal.recordDocument({
      path,
      id,
      revision_id: revisionId,
      raw_hash: hash,
      etag: hash,
      updated_at: timestamp
    });
    return revisionId;
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
      const bytes = Buffer.isBuffer(file.preimage_raw)
        ? file.preimage_raw
        : Buffer.from(file.preimage_raw, 'utf8');
      const raw = bytes.toString('utf8');
      snapshots.push({
        path: file.path,
        raw: Buffer.from(raw, 'utf8').equals(bytes) ? raw : '',
        hash: file.expected_hash
      });
    }
    let paths: string[];
    try {
      paths = await listVaultFilePaths(this.vaultRoot);
    } catch {
      return false;
    }
    for (const path of paths) {
      if (affected.has(path) || path === manifest.to) continue;
      const observed = await this.readMoveBytes(path);
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
      const actualPath = file.path === manifest.from ? manifest.to : file.path;
      const observed = await this.readMoveText(actualPath);
      if (observed === undefined) return false;
      observedEdits.set(file.path, observed.raw);
    }
    if (expected.size !== observedEdits.size) return false;
    for (const [path, raw] of observedEdits) {
      if (expected.get(path) !== raw) return false;
    }
    return true;
  }

  private async readMoveBytes(
    path: string
  ): Promise<{ raw: string; hash: string; text: boolean } | undefined> {
    let segments: string[];
    try {
      segments = renameSegments(path);
    } catch {
      return undefined;
    }
    try {
      return await readNoteFile(this.vaultRoot, segments, {
        maxBytes: MOVE_MAX_BYTES,
        requireUtf8: false
      });
    } catch {
      return undefined;
    }
  }

  private async readMoveText(path: string): Promise<{ raw: string; hash: string } | undefined> {
    const observed = await this.readMoveBytes(path);
    if (observed === undefined || !observed.text) return undefined;
    return { raw: observed.raw, hash: observed.hash };
  }

  private async movePathExists(path: string): Promise<boolean> {
    try {
      await lstat(join(this.vaultRoot, ...renameSegments(path)));
      return true;
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private async assertNoMoveStages(operation_id: string, paths: readonly string[]): Promise<void> {
    const directories = new Set(
      paths.map((path) => dirname(join(this.vaultRoot, ...renameSegments(path))))
    );
    for (const directory of directories) {
      let entries: string[];
      try {
        entries = await readdir(directory);
      } catch (error) {
        if (hasErrno(error, 'ENOENT')) continue;
        throw error;
      }
      for (const entry of entries.filter((name) => name.startsWith('.move-stage-'))) {
        this.markMoveConflict(operation_id);
        throw conflict(`move has an interrupted file staging ${entry} in ${directory}`);
      }
    }
  }

  private async sameVaultInode(left: string, right: string): Promise<boolean> {
    try {
      const [a, b] = await Promise.all([
        lstat(join(this.vaultRoot, ...renameSegments(left))),
        lstat(join(this.vaultRoot, ...renameSegments(right)))
      ]);
      return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false;
    }
  }

  private async locateMoveSource(
    manifest: MoveManifest,
    steps: readonly { from_path: string; to_path: string }[],
    expectedHash: string,
    finalHash: string
  ): Promise<
    | { kind: 'at'; path: string }
    | { kind: 'duplicate'; paths: string[] }
    | { kind: 'occupied'; path: string }
    | { kind: 'missing' }
  > {
    const candidates: string[] = [];
    if (steps.length > 0) candidates.push(steps[0].from_path);
    for (const step of steps) candidates.push(step.to_path);
    const present: { path: string; hash: string }[] = [];
    for (const candidate of candidates) {
      const observed = await this.readMoveBytes(candidate);
      if (observed !== undefined) present.push({ path: candidate, hash: observed.hash });
      else if (await this.movePathExists(candidate)) return { kind: 'occupied', path: candidate };
    }
    const unexpected = present.find((entry) =>
      entry.hash !== expectedHash && !(entry.path === manifest.to && entry.hash === finalHash)
    );
    if (unexpected !== undefined) return { kind: 'occupied', path: unexpected.path };
    const matching = present.filter((entry) =>
      entry.hash === expectedHash || (entry.path === manifest.to && entry.hash === finalHash)
    );
    if (matching.length === 0) {
      const final = present.find((entry) => entry.path === manifest.to);
      if (final !== undefined) return { kind: 'occupied', path: final.path };
      return { kind: 'missing' };
    }
    if (matching.length > 1) return { kind: 'duplicate', paths: matching.map((entry) => entry.path) };
    return { kind: 'at', path: matching[0].path };
  }

  private async deduplicateMoveSource(
    paths: readonly string[],
    steps: readonly { from_path: string; to_path: string }[],
    operation_id: string
  ): Promise<string> {
    const ordered = [...steps.map((step) => step.from_path), ...steps.map((step) => step.to_path)];
    const sorted = [...paths].sort((left, right) => ordered.indexOf(left) - ordered.indexOf(right));
    const keep = sorted[sorted.length - 1];
    const keepInfo = await lstat(join(this.vaultRoot, ...renameSegments(keep)));
    for (const other of sorted.slice(0, -1)) {
      const otherInfo = await lstat(join(this.vaultRoot, ...renameSegments(other)));
      if (otherInfo.dev !== keepInfo.dev || otherInfo.ino !== keepInfo.ino) {
        this.markMoveConflict(operation_id);
        throw conflict(`move source ${other} diverged from ${keep}`);
      }
      await this.removeLinkedMoveSource(other, keep, operation_id);
    }
    return keep;
  }

  private async removeLinkedMoveSource(from: string, to: string, operation_id: string): Promise<void> {
    const source = join(this.vaultRoot, ...renameSegments(from));
    const stagedDirectory = await mkdtemp(join(dirname(source), '.move-stage-'));
    const staged = join(stagedDirectory, 'source');
    let preserve = false;
    try {
      await rename(source, staged);
      preserve = true;
      await this.runRenameFault('afterMoveStage', 'the staged source could not be checked');
      const [moved, destination] = await Promise.all([
        lstat(staged), lstat(join(this.vaultRoot, ...renameSegments(to)))
      ]);
      if (
        !moved.isFile() || !destination.isFile() ||
        moved.dev !== destination.dev || moved.ino !== destination.ino
      ) {
        try {
          await link(staged, source);
          preserve = false;
        } catch (error) {
          if (!hasErrno(error, 'EEXIST')) throw error;
        }
        this.markMoveConflict(operation_id);
        throw conflict(`move source ${from} changed after the destination was linked`);
      }
      await rm(staged);
      preserve = false;
      await syncDirectory(dirname(source));
    } finally {
      if (!preserve) {
        await rm(staged, { force: true }).catch(() => undefined);
        await rmdir(stagedDirectory).catch(() => undefined);
      }
    }
  }

  private async replaceMoveEdit(
    operation_id: string,
    actualPath: string,
    segments: string[],
    edit: LocalMoveFileRecord
  ): Promise<void> {
    const target = join(this.vaultRoot, ...segments);
    const leaf = segments[segments.length - 1];
    const replacement = edit.new_raw as string;
    const tempPath = await writeTemporary(target, leaf, replacement);
    let backup: string | undefined;
    let stagedDirectory: string | undefined;
    let staged: string | undefined;
    let preserveStaged = false;
    try {
      await this.runRenameFault(
        'beforeEditReplace',
        'the reference rewrite could not be committed',
        actualPath
      );
      backup = `${target}.move-backup-${this.ids.next()}`;
      try {
        await link(target, backup);
      } catch (error) {
        if (hasErrno(error, 'ENOENT')) {
          this.markMoveConflict(operation_id);
          throw conflict(`file ${actualPath} disappeared before the rewrite`);
        }
        throw wrapIo('the reference rewrite could not be pinned', error);
      }
      const backupLeaf = backup.slice(backup.lastIndexOf('/') + 1);
      const backupSegments = [...segments.slice(0, -1), backupLeaf];
      const pinned = await readNoteFile(this.vaultRoot, backupSegments, { requireUtf8: false });
      if (pinned === undefined || pinned.hash !== edit.expected_hash) {
        this.markMoveConflict(operation_id);
        throw conflict(`file ${actualPath} changed immediately before the rewrite`);
      }
      const [targetInfo, backupInfo] = await Promise.all([lstat(target), lstat(backup)]);
      if (targetInfo.dev !== backupInfo.dev || targetInfo.ino !== backupInfo.ino) {
        this.markMoveConflict(operation_id);
        throw conflict(`file ${actualPath} was replaced immediately before the rewrite`);
      }
      await this.runRenameFault('afterEditInodeCheck', 'the reference rewrite could not be staged', actualPath);
      stagedDirectory = await mkdtemp(join(dirname(target), '.move-stage-'));
      staged = join(stagedDirectory, 'preimage');
      await rename(target, staged);
      preserveStaged = true;
      const [stagedInfo, pinnedInfo] = await Promise.all([lstat(staged), lstat(backup)]);
      const stagedBytes = await readNoteFile(
        this.vaultRoot,
        [...segments.slice(0, -1), stagedDirectory.slice(stagedDirectory.lastIndexOf('/') + 1), 'preimage'],
        { requireUtf8: false }
      );
      if (
        stagedInfo.dev !== pinnedInfo.dev || stagedInfo.ino !== pinnedInfo.ino ||
        stagedBytes?.hash !== edit.expected_hash
      ) {
        try {
          await link(staged, target);
          preserveStaged = false;
        } catch (error) {
          if (!hasErrno(error, 'EEXIST')) throw error;
        }
        this.markMoveConflict(operation_id);
        throw conflict(`file ${actualPath} was replaced immediately before the rewrite`);
      }
      try {
        await link(tempPath, target);
        preserveStaged = false;
      } catch (error) {
        if (!hasErrno(error, 'EEXIST')) throw error;
        this.markMoveConflict(operation_id);
        throw conflict(`file ${actualPath} was occupied during the rewrite`);
      }
      await syncDirectory(dirname(target));
      await this.runRenameFault('afterEditInstall', 'the reference rewrite could not be verified', actualPath);
      const after = await readNoteFile(this.vaultRoot, segments, { requireUtf8: false });
      if (after === undefined || after.hash !== edit.new_hash) {
        this.markMoveConflict(operation_id);
        throw conflict(`file ${actualPath} diverged during the rewrite`);
      }
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (staged !== undefined && !preserveStaged) {
        await rm(staged, { force: true }).catch(() => undefined);
        if (stagedDirectory !== undefined) await rmdir(stagedDirectory).catch(() => undefined);
      }
      if (backup !== undefined) {
        await rm(backup, { force: true }).catch(() => undefined);
      }
    }
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
