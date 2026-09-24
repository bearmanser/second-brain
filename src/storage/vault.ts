import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { BrainError } from '../contracts/errors.js';
import { RENDERED_NOTE_MAX_BYTES } from '../core/limits.js';
import type { ScopeConfig, VaultPort } from '../core/types.js';

const MARKER_PATTERN = /^[ \t]*brain_schema_version[ \t]*:/m;
const PREFIX_BYTES = 8 * 1024;
const MAX_READ_ATTEMPTS = 4;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const FD_DIRECTORY = '/proc/self/fd';
const FD_REALPATH_SUPPORTED = existsSync(FD_DIRECTORY);

function forbidden(message: string): BrainError {
  return new BrainError({ code: 'FORBIDDEN', message });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function limitExceeded(message: string): BrainError {
  return new BrainError({ code: 'LIMIT_EXCEEDED', message });
}

function unstable(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message, retryable: true });
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

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function segmentsOf(value: string): string[] {
  return value.split('/').filter((segment) => segment.length > 0);
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function isStrictlyInside(parent: string, child: string): boolean {
  return child.startsWith(`${parent}${sep}`);
}

function canonicalizeSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function validateRelativeRoot(scope: ScopeConfig): string[] {
  const value = scope.relative_root;
  if (typeof value !== 'string' || value.length === 0) {
    throw forbidden(`scope ${scope.id} has an empty relative_root`);
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    throw forbidden(`scope ${scope.id} has an absolute relative_root`);
  }
  if (value.includes('\\')) {
    throw forbidden(`scope ${scope.id} has a backslash in relative_root`);
  }
  if (/%[0-9a-fA-F]{2}/.test(value)) {
    throw forbidden(`scope ${scope.id} has a percent-encoded relative_root`);
  }
  const segments = segmentsOf(value);
  if (segments.length === 0) {
    throw forbidden(`scope ${scope.id} has an empty relative_root`);
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.startsWith('.')) {
      throw forbidden(`scope ${scope.id} has an unsafe relative_root segment`);
    }
  }
  return segments;
}

export function hasBrainMarker(raw: string): boolean {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return false;
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index;
      break;
    }
  }
  if (close === -1) return false;
  return MARKER_PATTERN.test(lines.slice(1, close).join('\n'));
}

export function vaultNoteSegments(relativePath: string): string[] {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw invalidInput('a vault path must be a non-empty string');
  }
  if (relativePath.includes('\0')) throw invalidInput('a vault path contains a null byte');
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw invalidInput('a vault path must be relative');
  }
  if (relativePath.includes('\\')) throw invalidInput('a vault path must use forward slashes');
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw invalidInput('a vault path must not contain empty segments');
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw invalidInput('path traversal is not allowed');
    if (segment.startsWith('.')) throw invalidInput('hidden path segments are not allowed');
    if (/[\u0000-\u001f\u007f]/u.test(segment)) {
      throw invalidInput('a vault path contains a control character');
    }
  }
  const leaf = segments[segments.length - 1];
  if (!leaf.endsWith('.md')) throw invalidInput('only Markdown documents can be addressed');
  return segments;
}

export interface VaultInventory {
  paths: string[];
  complete: boolean;
}

export async function scanVaultFilePaths(root: string): Promise<VaultInventory> {
  const rootPath = resolve(root);
  const results: string[] = [];
  let complete = true;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) {
        complete = false;
        return;
      }
      throw recoveryRequired(`vault directory ${directory} cannot be listed`, error);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(directory, entry.name);
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        complete = false;
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(absolute, relativePath);
        continue;
      }
      if (info.isFile()) results.push(relativePath);
    }
  };
  await walk(rootPath, '');
  results.sort();
  return { paths: results, complete };
}

export async function listVaultFilePaths(root: string): Promise<string[]> {
  return (await scanVaultFilePaths(root)).paths;
}

export interface ByteReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
}

export async function readBoundedBytes(
  handle: ByteReader,
  maxBytes: number
): Promise<{ kind: 'ok'; buffer: Buffer } | { kind: 'overflow' }> {
  const buffer = Buffer.alloc(maxBytes + 1);
  const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
  if (bytesRead > maxBytes) return { kind: 'overflow' };
  return { kind: 'ok', buffer: buffer.subarray(0, bytesRead) };
}

interface StableRead {
  kind: 'stable';
  value: { raw: string; raw_hash: string; relative_path: string };
}

interface UnstableRead {
  kind: 'unstable';
}

export class FileVault implements VaultPort {
  private readonly root: string;
  private readonly canonicalRoot: string;
  private readonly scopes: Map<string, ScopeConfig>;
  private readonly scopeRoots: Map<string, string>;

  constructor(root: string, scopes: ScopeConfig[]) {
    this.root = resolve(root);
    this.canonicalRoot = canonicalizeSync(this.root);
    this.scopes = new Map();
    this.scopeRoots = new Map();
    for (const scope of scopes) {
      this.scopeRoots.set(scope.id, this.validateConfiguredRoot(scope));
      this.scopes.set(scope.id, scope);
    }
  }

  registerScope(scope: ScopeConfig): void {
    const existing = this.scopes.get(scope.id);
    if (existing !== undefined) {
      if (
        existing.backend_project !== scope.backend_project ||
        existing.relative_root !== scope.relative_root
      ) {
        throw forbidden(`scope ${scope.id} is already registered with a different mapping`);
      }
      this.requireExistingScopeRoot(scope);
      return;
    }
    this.requireExistingScopeRoot(scope);
    const canonicalRoot = this.validateConfiguredRoot(scope);
    this.scopeRoots.set(scope.id, canonicalRoot);
    this.scopes.set(scope.id, { ...scope, repository_aliases: [...scope.repository_aliases] });
  }

  private requireExistingScopeRoot(scope: ScopeConfig): void {
    const directory = join(this.root, ...validateRelativeRoot(scope));
    let info;
    try {
      info = lstatSync(directory);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) {
        throw recoveryRequired(`scope root ${scope.relative_root} does not exist`, error);
      }
      throw recoveryRequired(`scope ${scope.id} cannot be inspected`, error);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw forbidden(`scope root ${scope.relative_root} is not a safe existing directory`);
    }
  }

  async list(scope: string): Promise<string[]> {
    const inventory = await this.inventory(scope);
    return inventory.managed;
  }

  async scan(scope: string): Promise<{ managed: string[]; unmanaged: string[] }> {
    return this.inventory(scope);
  }

  async listMarkdown(): Promise<string[]> {
    return (await this.scanMarkdown()).paths;
  }

  async scanMarkdown(): Promise<VaultInventory> {
    const inventory = await scanVaultFilePaths(this.root);
    return {
      paths: inventory.paths.filter((path) => path.toLowerCase().endsWith('.md')),
      complete: inventory.complete
    };
  }

  async readMarkdown(
    relativePath: string
  ): Promise<{ raw: string; raw_hash: string; relative_path: string }> {
    const segments = vaultNoteSegments(relativePath);
    const resolved = resolve(this.root, ...segments);
    if (!isStrictlyInside(this.root, resolved)) {
      throw forbidden('path is outside the vault root');
    }
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      await this.assertSegments(segments);
      const outcome = await this.readOnce(segments, this.canonicalRoot);
      if (outcome.kind === 'stable') return outcome.value;
    }
    throw unstable(`file ${segments.join('/')} changed or left the vault while it was being read`);
  }

  private async inventory(scope: string): Promise<{ managed: string[]; unmanaged: string[] }> {
    const config = this.requireScope(scope);
    const canonicalScopeRoot = this.scopeRoots.get(config.id);
    if (canonicalScopeRoot === undefined) {
      throw forbidden(`scope ${config.id} is not configured for vault access`);
    }
    const prefix = segmentsOf(config.relative_root);
    const directory = join(this.root, ...prefix);
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) return { managed: [], unmanaged: [] };
      throw recoveryRequired(`scope root ${directory} cannot be inspected`, error);
    }
    if (info.isSymbolicLink()) {
      throw forbidden(`scope root ${config.relative_root} is a symbolic link`);
    }
    if (!info.isDirectory()) return { managed: [], unmanaged: [] };
    await this.assertDirectoryChain(prefix);
    const canonicalDirectory = await this.canonicalPath(directory);
    if (canonicalDirectory === undefined || !isInside(this.canonicalRoot, canonicalDirectory)) {
      throw forbidden(`scope root ${config.relative_root} resolves outside the vault root`);
    }
    const managed: string[] = [];
    const unmanaged: string[] = [];
    await this.walk(directory, prefix.join('/'), canonicalScopeRoot, managed, unmanaged);
    managed.sort();
    unmanaged.sort();
    return { managed, unmanaged };
  }

  async read(
    scope: string,
    relativePath: string
  ): Promise<{ raw: string; raw_hash: string; relative_path: string }> {
    const config = this.requireScope(scope);
    const canonicalScopeRoot = this.scopeRoots.get(config.id);
    if (canonicalScopeRoot === undefined) {
      throw forbidden(`scope ${config.id} is not configured for vault access`);
    }
    const segments = this.validatePath(config, relativePath);
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      await this.assertSegments(segments);
      const outcome = await this.readOnce(segments, canonicalScopeRoot);
      if (outcome.kind === 'stable') return outcome.value;
    }
    throw unstable(`file ${segments.join('/')} changed or left its scope while it was being read`);
  }

  private validateConfiguredRoot(scope: ScopeConfig): string {
    const segments = validateRelativeRoot(scope);
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      let info;
      try {
        info = lstatSync(current);
      } catch (error) {
        if (hasErrno(error, 'ENOENT')) break;
        throw recoveryRequired(`scope ${scope.id} cannot be inspected`, error);
      }
      if (info.isSymbolicLink()) {
        throw forbidden(`scope ${scope.id} traverses the symbolic link ${current}`);
      }
      if (!info.isDirectory()) {
        throw forbidden(`scope ${scope.id} is not a directory at ${current}`);
      }
    }
    const canonicalExpected = canonicalizeSync(join(this.canonicalRoot, ...segments));
    if (!isInside(this.canonicalRoot, canonicalExpected)) {
      throw forbidden(`scope ${scope.id} resolves outside the vault root`);
    }
    return canonicalExpected;
  }

  private async readOnce(
    segments: string[],
    canonicalScopeRoot: string
  ): Promise<StableRead | UnstableRead> {
    const relativePath = segments.join('/');
    const absolute = join(this.root, ...segments);
    let handle;
    try {
      handle = await open(absolute, READ_FLAGS);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) throw notFound(`file ${relativePath} does not exist`);
      if (hasErrno(error, 'ELOOP')) throw forbidden(`path ${relativePath} contains a symbolic link`);
      throw recoveryRequired(`file ${relativePath} cannot be opened`, error);
    }
    try {
      const canonical = await this.canonicalForHandle(handle, absolute);
      if (canonical === undefined || !isStrictlyInside(canonicalScopeRoot, canonical)) {
        return { kind: 'unstable' };
      }
      const before = await handle.stat();
      if (!before.isFile()) throw notFound(`file ${relativePath} is not a regular file`);
      if (before.size > RENDERED_NOTE_MAX_BYTES) {
        throw limitExceeded(
          `file ${relativePath} is ${before.size} bytes and exceeds the ${RENDERED_NOTE_MAX_BYTES} byte limit`
        );
      }
      const bounded = await readBoundedBytes(handle, RENDERED_NOTE_MAX_BYTES);
      if (bounded.kind === 'overflow') {
        throw limitExceeded(`file ${relativePath} exceeds the ${RENDERED_NOTE_MAX_BYTES} byte limit`);
      }
      const buffer = bounded.buffer;
      const after = await handle.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        after.ino !== before.ino ||
        after.dev !== before.dev
      ) {
        return { kind: 'unstable' };
      }
      if (buffer.byteLength !== before.size) return { kind: 'unstable' };
      const raw = buffer.toString('utf8');
      if (!Buffer.from(raw, 'utf8').equals(buffer)) {
        throw invalidInput(`file ${relativePath} is not valid UTF-8`);
      }
      return {
        kind: 'stable',
        value: { raw, raw_hash: sha256(buffer), relative_path: relativePath }
      };
    } finally {
      await handle.close();
    }
  }

  private async walk(
    directory: string,
    relative: string,
    canonicalScopeRoot: string,
    managed: string[],
    unmanaged: string[]
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) return;
      throw recoveryRequired(`directory ${directory} cannot be listed`, error);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(directory, entry.name);
      const relativePath = `${relative}/${entry.name}`;
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        const canonical = await this.canonicalPath(absolute);
        if (canonical === undefined || !isStrictlyInside(canonicalScopeRoot, canonical)) continue;
        await this.walk(absolute, relativePath, canonicalScopeRoot, managed, unmanaged);
        continue;
      }
      if (!info.isFile()) continue;
      if (!entry.name.endsWith('.md')) {
        unmanaged.push(relativePath);
        continue;
      }
      const prefix = await this.readPrefix(absolute, info.size, canonicalScopeRoot);
      if (prefix !== undefined && hasBrainMarker(prefix)) {
        managed.push(relativePath);
      } else {
        unmanaged.push(relativePath);
      }
    }
  }

  private async readPrefix(
    absolute: string,
    size: number,
    canonicalScopeRoot: string
  ): Promise<string | undefined> {
    const length = Math.min(size, PREFIX_BYTES);
    let handle;
    try {
      handle = await open(absolute, READ_FLAGS);
    } catch {
      return undefined;
    }
    try {
      const canonical = await this.canonicalForHandle(handle, absolute);
      if (canonical === undefined || !isStrictlyInside(canonicalScopeRoot, canonical)) {
        return undefined;
      }
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  }

  private async canonicalForHandle(
    handle: FileHandle,
    absolute: string
  ): Promise<string | undefined> {
    const fd = handle.fd;
    if (FD_REALPATH_SUPPORTED && typeof fd === 'number' && fd >= 0) {
      try {
        const canonical = await realpath(`${FD_DIRECTORY}/${fd}`);
        if (!canonical.endsWith(' (deleted)')) return canonical;
      } catch {
        return undefined;
      }
    }
    return this.canonicalPath(absolute);
  }

  private async canonicalPath(path: string): Promise<string | undefined> {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  }

  private requireScope(scope: string): ScopeConfig {
    const config = this.scopes.get(scope);
    if (config === undefined) {
      throw forbidden(`scope ${scope} is not configured for vault access`);
    }
    return config;
  }

  private validatePath(config: ScopeConfig, relativePath: string): string[] {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw invalidInput('relative_path must be a non-empty string');
    }
    if (relativePath.includes('\0')) throw forbidden('relative_path contains a null byte');
    if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
      throw forbidden('absolute paths are not allowed');
    }
    if (relativePath.includes('\\')) throw forbidden('backslash separators are not allowed');
    if (/%[0-9a-fA-F]{2}/.test(relativePath)) {
      throw forbidden('percent-encoded paths are not allowed');
    }
    const rawSegments = relativePath.split('/');
    if (rawSegments.some((segment) => segment.length === 0)) {
      throw forbidden('empty path segments are not allowed');
    }
    for (const segment of rawSegments) {
      if (segment === '.' || segment === '..') throw forbidden('path traversal is not allowed');
      if (segment.startsWith('.')) throw forbidden('hidden path segments are not allowed');
    }
    const rootSegments = segmentsOf(config.relative_root);
    if (rawSegments.length <= rootSegments.length) {
      throw forbidden('path is outside the configured scope root');
    }
    for (let index = 0; index < rootSegments.length; index += 1) {
      if (rawSegments[index] !== rootSegments[index]) {
        throw forbidden('path is outside the configured scope root');
      }
    }
    const leaf = rawSegments[rawSegments.length - 1];
    if (!leaf.endsWith('.md')) throw invalidInput('only Markdown documents can be read');
    return rawSegments;
  }

  private async assertSegments(segments: string[]): Promise<string> {
    const resolved = resolve(this.root, ...segments);
    if (!isStrictlyInside(this.root, resolved)) {
      throw forbidden('path is outside the vault root');
    }
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (hasErrno(error, 'ENOENT')) {
          throw notFound(`file ${segments.join('/')} does not exist`);
        }
        throw recoveryRequired(`path ${segments.join('/')} cannot be inspected`, error);
      }
      if (info.isSymbolicLink()) {
        throw forbidden(`path ${segments.join('/')} contains a symbolic link`);
      }
      const last = index === segments.length - 1;
      if (!last && !info.isDirectory()) {
        throw notFound(`path ${segments.join('/')} does not exist`);
      }
      if (last && !info.isFile()) {
        throw notFound(`file ${segments.join('/')} is not a regular file`);
      }
    }
    return current;
  }

  private async assertDirectoryChain(segments: string[]): Promise<void> {
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (hasErrno(error, 'ENOENT')) {
          throw notFound(`scope root ${segments.join('/')} does not exist`);
        }
        throw recoveryRequired(`scope root ${segments.join('/')} cannot be inspected`, error);
      }
      if (info.isSymbolicLink()) {
        throw forbidden(`scope root ${segments.join('/')} contains a symbolic link`);
      }
      if (!info.isDirectory()) {
        throw forbidden(`scope root ${segments.join('/')} is not a directory`);
      }
    }
  }
}
