import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BrainError, isBrainError } from '../contracts/errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
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

function requireUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidInput(`${field} must be a UUID`);
  }
  return value;
}

function requireHash(value: string, field: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw invalidInput(`${field} must be a sha256 digest`);
  }
  return value;
}

export interface StoredRevisionBytes {
  id: string;
  revision_id: string;
  raw: string;
  hash: string;
  path: string;
}

export interface StoredPreimageBytes {
  id: string;
  hash: string;
  path: string;
}

export interface RevisionStore {
  persistPreimage(id: string, raw: string): Promise<StoredPreimageBytes>;
  persistRevision(id: string, revisionId: string, raw: string): Promise<StoredRevisionBytes>;
  readRevision(id: string, revisionId: string): Promise<StoredRevisionBytes>;
  hasRevision(id: string, revisionId: string): Promise<boolean>;
  close(): void;
}

export function historyDirectory(state: string): string {
  return join(state, 'history');
}

export function revisionLocation(state: string, id: string, revisionId: string): string {
  return join(state, 'history', requireUuid(id, 'id'), 'revisions', `${requireUuid(revisionId, 'revision_id')}.md`);
}

export function preimageLocation(state: string, id: string, hash: string): string {
  return join(state, 'history', requireUuid(id, 'id'), 'preimages', `${requireHash(hash, 'hash')}.md`);
}

async function assertSafeDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw recoveryRequired(`state path ${directory} is not a safe directory`);
    }
    return;
  } catch (error) {
    if (isBrainError(error)) throw error;
    if (!hasErrno(error, 'ENOENT')) {
      throw recoveryRequired(`state path ${directory} cannot be inspected`, error);
    }
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw recoveryRequired(`state directory ${directory} cannot be created`, error);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    return;
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

async function writeImmutable(path: string, raw: string, label: string): Promise<string> {
  const hash = sha256(raw);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw recoveryRequired(`${label} is not a regular file`);
    }
    const existing = await readFile(path, 'utf8');
    if (existing !== raw) {
      throw recoveryRequired(`${label} already exists with different bytes`);
    }
    return hash;
  } catch (error) {
    if (isBrainError(error)) throw error;
    if (!hasErrno(error, 'ENOENT')) {
      throw recoveryRequired(`${label} cannot be inspected`, error);
    }
  }
  const directory = dirname(path);
  await assertSafeDirectory(directory);
  const tempPath = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
  } catch (error) {
    throw recoveryRequired(`${label} cannot be written`, error);
  } finally {
    if (handle !== undefined) await handle.close();
  }
  try {
    await link(tempPath, path);
  } catch (error) {
    if (hasErrno(error, 'EEXIST')) {
      const existing = await readFile(path, 'utf8');
      if (existing !== raw) {
        throw recoveryRequired(`${label} was created concurrently with different bytes`, error);
      }
    } else {
      throw recoveryRequired(`${label} cannot be persisted`, error);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  await syncDirectory(directory);
  return hash;
}

class FileRevisionStore implements RevisionStore {
  private readonly state: string;

  constructor(state: string) {
    this.state = state;
  }

  async persistPreimage(id: string, raw: string): Promise<StoredPreimageBytes> {
    const hash = sha256(raw);
    const path = preimageLocation(this.state, id, hash);
    await writeImmutable(path, raw, `preimage ${hash}`);
    return { id, hash, path };
  }

  async persistRevision(id: string, revisionId: string, raw: string): Promise<StoredRevisionBytes> {
    const path = revisionLocation(this.state, id, revisionId);
    const hash = await writeImmutable(path, raw, `revision ${revisionId}`);
    return { id, revision_id: revisionId, raw, hash, path };
  }

  async readRevision(id: string, revisionId: string): Promise<StoredRevisionBytes> {
    const path = revisionLocation(this.state, id, revisionId);
    let raw: string;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw recoveryRequired(`revision ${revisionId} is not a regular file`);
      }
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isBrainError(error)) throw error;
      if (hasErrno(error, 'ENOENT')) {
        throw notFound(`revision ${revisionId} does not exist`);
      }
      throw recoveryRequired(`revision ${revisionId} cannot be read`, error);
    }
    return { id, revision_id: revisionId, raw, hash: sha256(raw), path };
  }

  async hasRevision(id: string, revisionId: string): Promise<boolean> {
    try {
      const info = await lstat(revisionLocation(this.state, id, revisionId));
      return info.isFile() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  }

  close(): void {
    return;
  }
}

export async function openRevisionStore(state: string): Promise<RevisionStore> {
  if (typeof state !== 'string' || state.length === 0) {
    throw invalidInput('a state directory is required');
  }
  await assertSafeDirectory(historyDirectory(state));
  return new FileRevisionStore(state);
}
