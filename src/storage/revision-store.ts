import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { RENDERED_NOTE_MAX_BYTES } from '../core/limits.js';
import { readBoundedBytes } from './vault.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FRONTMATTER_ID_PATTERN = /^(?:id|brain_id):[ \t]*([0-9a-fA-F-]{36})[ \t]*$/;

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

function readFrontmatterId(raw: string): string | undefined {
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
  for (const line of lines.slice(1, close)) {
    const match = FRONTMATTER_ID_PATTERN.exec(line);
    if (match !== null) return match[1].toLowerCase();
  }
  return undefined;
}

async function assertSafeRoot(root: string): Promise<void> {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    throw recoveryRequired(`state root ${root} cannot be inspected`, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw recoveryRequired(`state root ${root} is not a safe directory`);
  }
}

async function ensureDirectoryChain(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!hasErrno(error, 'ENOENT')) {
        throw recoveryRequired(`state path ${current} cannot be inspected`, error);
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (cause) {
        throw recoveryRequired(`state directory ${current} cannot be created`, cause);
      }
      continue;
    }
    if (info.isSymbolicLink()) {
      throw recoveryRequired(`state path ${current} is a symbolic link`);
    }
    if (!info.isDirectory()) {
      throw recoveryRequired(`state path ${current} is not a directory`);
    }
  }
  return current;
}

async function assertExistingDirectoryChain(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) {
        throw notFound(`history path ${parts.join('/')} does not exist`);
      }
      throw recoveryRequired(`state path ${current} cannot be inspected`, error);
    }
    if (info.isSymbolicLink()) {
      throw recoveryRequired(`state path ${current} is a symbolic link`);
    }
    if (!info.isDirectory()) {
      throw recoveryRequired(`state path ${current} is not a directory`);
    }
  }
  return current;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    throw recoveryRequired(`state directory ${directory} could not be fsynced`, error);
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

async function readBoundedFile(path: string, label: string): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) throw notFound(`${label} does not exist`);
    throw recoveryRequired(`${label} cannot be opened`, error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw recoveryRequired(`${label} is not a regular file`);
    if (info.size > RENDERED_NOTE_MAX_BYTES) {
      throw recoveryRequired(`${label} exceeds the ${RENDERED_NOTE_MAX_BYTES} byte limit`);
    }
    const bounded = await readBoundedBytes(handle, RENDERED_NOTE_MAX_BYTES);
    if (bounded.kind === 'overflow') {
      throw recoveryRequired(`${label} exceeds the ${RENDERED_NOTE_MAX_BYTES} byte limit`);
    }
    return bounded.buffer;
  } finally {
    await handle.close();
  }
}

async function writeImmutable(
  directory: string,
  fileName: string,
  raw: string,
  label: string
): Promise<{ hash: string; path: string }> {
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw recoveryRequired(`state path ${directory} is not a safe directory`);
  }
  const path = join(directory, fileName);
  const hash = sha256(raw);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw recoveryRequired(`${label} is not a regular file`);
    }
    const existing = await readBoundedFile(path, label);
    if (existing.toString('utf8') !== raw || !Buffer.from(existing.toString('utf8'), 'utf8').equals(existing)) {
      throw recoveryRequired(`${label} already exists with different bytes`);
    }
    return { hash, path };
  } catch (error) {
    if (isBrainError(error)) throw error;
    if (!hasErrno(error, 'ENOENT')) {
      throw recoveryRequired(`${label} cannot be inspected`, error);
    }
  }
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
      const existing = await readBoundedFile(path, label);
      if (existing.toString('utf8') !== raw) {
        throw recoveryRequired(`${label} was created concurrently with different bytes`, error);
      }
    } else {
      throw recoveryRequired(`${label} cannot be persisted`, error);
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
  await syncDirectory(directory);
  return { hash, path };
}

class FileRevisionStore implements RevisionStore {
  private readonly state: string;

  constructor(state: string) {
    this.state = state;
  }

  async persistPreimage(id: string, raw: string): Promise<StoredPreimageBytes> {
    const safeId = requireUuid(id, 'id');
    const hash = sha256(raw);
    const directory = await ensureDirectoryChain(this.state, ['history', safeId, 'preimages']);
    const stored = await writeImmutable(directory, `${hash}.md`, raw, `preimage ${hash}`);
    return { id: safeId, hash: stored.hash, path: stored.path };
  }

  async persistRevision(id: string, revisionId: string, raw: string): Promise<StoredRevisionBytes> {
    const safeId = requireUuid(id, 'id');
    const safeRevision = requireUuid(revisionId, 'revision_id');
    const directory = await ensureDirectoryChain(this.state, ['history', safeId, 'revisions']);
    const stored = await writeImmutable(directory, `${safeRevision}.md`, raw, `revision ${safeRevision}`);
    await writeImmutable(directory, `${safeRevision}.sha256`, stored.hash, `revision hash ${safeRevision}`);
    return { id: safeId, revision_id: safeRevision, raw, hash: stored.hash, path: stored.path };
  }

  async readRevision(id: string, revisionId: string): Promise<StoredRevisionBytes> {
    const safeId = requireUuid(id, 'id');
    const safeRevision = requireUuid(revisionId, 'revision_id');
    const directory = await assertExistingDirectoryChain(this.state, ['history', safeId, 'revisions']);
    const path = join(directory, `${safeRevision}.md`);
    const buffer = await readBoundedFile(path, `revision ${safeRevision}`);
    const raw = buffer.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(buffer)) {
      throw recoveryRequired(`revision ${safeRevision} is not valid UTF-8`);
    }
    const hash = sha256(buffer);
    const sidecar = await readBoundedFile(
      join(directory, `${safeRevision}.sha256`),
      `revision hash ${safeRevision}`
    );
    const recorded = sidecar.toString('ascii').trim();
    if (!HASH_PATTERN.test(recorded) || recorded !== hash) {
      throw recoveryRequired(`revision ${safeRevision} failed its recorded byte-integrity check`);
    }
    const documentId = readFrontmatterId(raw);
    if (documentId !== undefined && documentId !== safeId.toLowerCase()) {
      throw recoveryRequired(`revision ${safeRevision} does not belong to logical id ${safeId}`);
    }
    return { id: safeId, revision_id: safeRevision, raw, hash, path };
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
  await assertSafeRoot(state);
  await ensureDirectoryChain(state, ['history']);
  return new FileRevisionStore(state);
}
