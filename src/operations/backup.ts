import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';

export const BACKUP_FORMAT_VERSION = 1;
export const SUPPORTED_BACKUP_FORMATS: readonly number[] = [1];

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface VersionManifest {
  application: string;
  schema: number;
  images: Record<string, string>;
  stores?: string[];
  sensitive?: boolean;
  created_at?: string;
  volumes?: Record<string, string>;
}

export interface BackupSoftwareVersion {
  application: string;
  schema: number;
  images: Record<string, string>;
}

export interface BackupManifest {
  format_version: number;
  created_at: string;
  software: BackupSoftwareVersion;
  stores: string[];
  sensitive: boolean;
  volumes: Record<string, string>;
  files: ManifestFile[];
}

export type BackupArchiveMode = 'vault' | 'volume';

interface ArchiveEntry {
  path: string;
  type: string;
  linkTarget?: string;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function backupError(message: string): Error {
  return new Error(message);
}

function tarString(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function tarNumber(buffer: Buffer, offset: number, length: number): number {
  const field = buffer.subarray(offset, offset + length);
  if ((field[0] ?? 0) & 0x80) {
    const bytes = Buffer.from(field);
    bytes[0] = (bytes[0] ?? 0) & 0x7f;
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw backupError('archive contains an unsupported member size');
    return result;
  }
  const raw = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) throw backupError('archive contains an invalid numeric header');
  const result = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(result)) throw backupError('archive contains an unsupported member size');
  return result;
}

function tarChecksum(header: Buffer): number {
  let total = 0;
  for (let index = 0; index < header.length; index += 1) {
    total += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  return total;
}

function parsePax(buffer: Buffer): Map<string, string> {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space < 0) throw backupError('archive contains an invalid extended header');
    const length = Number.parseInt(buffer.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > buffer.length) {
      throw backupError('archive contains an invalid extended header');
    }
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) fields.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return fields;
}

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw backupError('archive ended in the middle of a member');
    offset += result.bytesRead;
  }
  return buffer;
}

function archivePath(value: string): string {
  const original = value;
  if (value.includes('\0')) throw backupError('archive member contains a null byte');
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw backupError(`archive member is an absolute path: ${original}`);
  }
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') throw backupError(`archive member contains traversal: ${original}`);
    segments.push(segment);
  }
  return segments.join('/');
}

async function readArchiveEntries(path: string): Promise<ArchiveEntry[]> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (handle === undefined) throw backupError(`backup archive cannot be read: ${path}`);
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let localPax = new Map<string, string>();
  const globalPax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  try {
    const stat = await handle.stat();
    while (offset + 512 <= stat.size) {
      const header = await readAt(handle, 512, offset);
      if (header.every((byte) => byte === 0)) break;
      const expectedChecksum = tarNumber(header, 148, 8);
      if (expectedChecksum !== tarChecksum(header)) {
        throw backupError(`archive has an invalid header at byte ${offset}`);
      }
      const size = tarNumber(header, 124, 12);
      const type = String.fromCharCode(header[156] ?? 0) || '0';
      const payloadOffset = offset + 512;
      const nextOffset = payloadOffset + Math.ceil(size / 512) * 512;
      if (nextOffset > stat.size) throw backupError('archive ended in the middle of a member');
      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (size > 16 * 1024 * 1024) throw backupError('archive extended header is too large');
        const payload = await readAt(handle, size, payloadOffset);
        if (type === 'x') localPax = parsePax(payload);
        if (type === 'g') {
          for (const [key, value] of parsePax(payload)) globalPax.set(key, value);
        }
        if (type === 'L') longName = payload.toString('utf8').replace(/[\0\n]+$/g, '');
        if (type === 'K') longLink = payload.toString('utf8').replace(/[\0\n]+$/g, '');
        offset = nextOffset;
        continue;
      }
      const name = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const headerPath = prefix.length > 0 ? `${prefix}/${name}` : name;
      const rawPath = localPax.get('path') ?? globalPax.get('path') ?? longName ?? headerPath;
      const rawLink = localPax.get('linkpath') ?? globalPax.get('linkpath') ?? longLink ?? tarString(header, 157, 100);
      const normalized = archivePath(rawPath);
      if (normalized.length > 0) {
        entries.push({
          path: normalized,
          type: type === '\0' ? '0' : type,
          ...((type === '2' || type === '1') ? { linkTarget: rawLink } : {})
        });
      }
      localPax = new Map<string, string>();
      longName = undefined;
      longLink = undefined;
      offset = nextOffset;
    }
  } finally {
    await handle.close();
  }
  return entries;
}

function parentPaths(path: string): string[] {
  const parents: string[] = [];
  let current = posix.dirname(path);
  while (current !== '.') {
    parents.push(current);
    current = posix.dirname(current);
  }
  return parents;
}

function resolveArchivedLink(
  entry: ArchiveEntry,
  byPath: Map<string, ArchiveEntry>,
  knownPaths: Set<string>
): 'inside' | 'broken' | 'escaping' {
  const initialTarget = entry.linkTarget ?? '';
  if (initialTarget.length === 0) return 'broken';
  if (initialTarget.startsWith('/')) return 'escaping';
  const pending = initialTarget.split('/');
  const resolved = posix.dirname(entry.path) === '.' ? [] : posix.dirname(entry.path).split('/');
  const followed = new Set<string>();
  while (pending.length > 0) {
    const component = pending.shift() ?? '';
    if (component.length === 0 || component === '.') continue;
    if (component === '..') {
      if (resolved.length === 0) return 'escaping';
      resolved.pop();
      continue;
    }
    resolved.push(component);
    const candidate = resolved.join('/');
    const nested = byPath.get(candidate);
    if (nested?.type === '2') {
      if (followed.has(candidate)) return 'broken';
      followed.add(candidate);
      const target = nested.linkTarget ?? '';
      if (target.length === 0) return 'broken';
      if (target.startsWith('/')) return 'escaping';
      const parent = posix.dirname(candidate);
      resolved.splice(0, resolved.length, ...(parent === '.' ? [] : parent.split('/')));
      pending.unshift(...target.split('/'));
      continue;
    }
    if (!knownPaths.has(candidate)) return 'broken';
  }
  return knownPaths.has(resolved.join('/')) ? 'inside' : 'broken';
}

export async function validateBackupArchive(path: string, mode: BackupArchiveMode): Promise<void> {
  const entries = await readArchiveEntries(path);
  const byPath = new Map<string, ArchiveEntry>();
  const knownPaths = new Set<string>(['']);
  for (const entry of entries) {
    if (byPath.has(entry.path)) throw backupError(`archive contains a duplicate member: ${entry.path}`);
    byPath.set(entry.path, entry);
    knownPaths.add(entry.path);
    for (const parent of parentPaths(entry.path)) knownPaths.add(parent);
  }
  for (const entry of entries) {
    for (const parent of parentPaths(entry.path)) {
      if (byPath.get(parent)?.type === '2') {
        throw backupError(`archive member is nested beneath a symbolic link: ${entry.path}`);
      }
    }
    if (entry.type !== '2') continue;
    if (mode === 'vault') {
      throw backupError(`vault archive contains symbolic link member: ${entry.path}`);
    }
    const result = resolveArchivedLink(entry, byPath, knownPaths);
    if (result === 'broken') {
      throw backupError(`named-volume archive contains broken symbolic link: ${entry.path} -> ${entry.linkTarget ?? ''}`);
    }
    if (result === 'escaping') {
      throw backupError(`named-volume archive contains escaping symbolic link: ${entry.path} -> ${entry.linkTarget ?? ''}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw backupError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RFC3339_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw backupError(`${label} must be an RFC3339 timestamp`);
  }
  return value;
}

export function requireRelativeBackupPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw backupError('backup path must be a non-empty relative path');
  }
  if (value.includes('\0')) {
    throw backupError('backup path must not contain a null byte');
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw backupError(`backup path must be relative: ${value}`);
  }
  if (value.includes('\\')) {
    throw backupError(`backup path must use forward slashes: ${value}`);
  }
  for (const segment of value.split('/')) {
    if (segment.length === 0) throw backupError(`backup path has an empty segment: ${value}`);
    if (segment === '.' || segment === '..') {
      throw backupError(`backup path must not contain traversal: ${value}`);
    }
  }
  return value;
}

export function resolveBackupPath(root: string, relativePath: string): string {
  requireRelativeBackupPath(relativePath);
  const base = resolve(root);
  const target = resolve(base, ...relativePath.split('/'));
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw backupError(`backup path escapes the backup root: ${relativePath}`);
  }
  return target;
}

function validateVolumeMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw backupError('backup manifest volumes must be an object');
  const volumes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    requireRelativeBackupPath(key);
    volumes[key] = requireNonEmptyString(entry, `backup manifest volumes.${key}`);
  }
  return volumes;
}

export function validateManifest(manifest: unknown): BackupManifest {
  if (!isRecord(manifest)) throw backupError('backup manifest is not an object');
  const format = manifest.format_version;
  if (typeof format !== 'number' || !Number.isInteger(format)) {
    throw backupError('backup manifest format_version must be an integer');
  }
  if (!SUPPORTED_BACKUP_FORMATS.includes(format)) {
    throw backupError(`unsupported backup format version ${String(format)}`);
  }
  requireTimestamp(manifest.created_at, 'backup manifest created_at');
  if (!isRecord(manifest.software)) {
    throw backupError('backup manifest has no software version block');
  }
  requireNonEmptyString(manifest.software.application, 'backup manifest software.application');
  const schema = manifest.software.schema;
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) {
    throw backupError('backup manifest software.schema must be a positive integer');
  }
  if (!isRecord(manifest.software.images)) {
    throw backupError('backup manifest software.images must be an object');
  }
  for (const [name, reference] of Object.entries(manifest.software.images)) {
    requireNonEmptyString(name, 'backup manifest software.images key');
    requireNonEmptyString(reference, `backup manifest software.images.${name}`);
  }
  if (!Array.isArray(manifest.stores)) {
    throw backupError('backup manifest has no store list');
  }
  const stores = manifest.stores.map((store, index) =>
    requireNonEmptyString(store, `backup manifest stores[${index}]`)
  );
  if (new Set(stores).size !== stores.length) {
    throw backupError('backup manifest store list contains duplicates');
  }
  if (typeof manifest.sensitive !== 'boolean') {
    throw backupError('backup manifest sensitive must be a boolean');
  }
  const volumes = validateVolumeMap(manifest.volumes ?? {});
  if (!Array.isArray(manifest.files)) {
    throw backupError('backup manifest has no file entries');
  }
  const files: ManifestFile[] = manifest.files.map((entry, index) => {
    if (!isRecord(entry)) {
      throw backupError(`backup manifest files[${index}] is not an object`);
    }
    const path = requireRelativeBackupPath(
      requireNonEmptyString(entry.path, `backup manifest files[${index}].path`)
    );
    const size = entry.size;
    if (typeof size !== 'number' || !Number.isFinite(size) || !Number.isInteger(size) || size < 0) {
      throw backupError(`backup manifest files[${index}].size must be a non-negative finite integer`);
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      throw backupError(`backup manifest files[${index}].sha256 must be a lowercase sha256 digest`);
    }
    return { path, size, sha256: entry.sha256 };
  });
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw backupError(`backup manifest contains a duplicate entry: ${file.path}`);
    }
    seen.add(file.path);
  }
  return {
    format_version: format,
    created_at: new Date(manifest.created_at as string).toISOString(),
    software: {
      application: manifest.software.application as string,
      schema,
      images: { ...(manifest.software.images as Record<string, string>) }
    },
    stores,
    sensitive: manifest.sensitive as boolean,
    volumes,
    files
  };
}

export function assertCompatibleStateSchema(manifest: BackupManifest, current: number): void {
  const validated = validateManifest(manifest);
  if (validated.software.schema > current) {
    throw backupError(
      `backup state schema version ${validated.software.schema} is newer than this release supports (${current})`
    );
  }
}

export function buildManifest(files: ManifestFile[], versions: VersionManifest): BackupManifest {
  return {
    format_version: BACKUP_FORMAT_VERSION,
    created_at: versions.created_at ?? new Date().toISOString(),
    software: {
      application: versions.application,
      schema: versions.schema,
      images: { ...versions.images }
    },
    stores: [...(versions.stores ?? [])],
    sensitive: versions.sensitive === true,
    volumes: { ...(versions.volumes ?? {}) },
    files: files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 }))
  };
}

export async function fileManifestEntry(root: string, relativePath: string): Promise<ManifestFile> {
  const absolute = resolveBackupPath(root, relativePath);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw backupError(`backup path is a symbolic link: ${relativePath}`);
  if (!info.isFile()) throw backupError(`backup path is not a regular file: ${relativePath}`);
  const buffer = await readFile(absolute);
  return { path: relativePath, size: buffer.byteLength, sha256: sha256(buffer) };
}

export async function collectManifestFiles(root: string): Promise<ManifestFile[]> {
  const base = resolve(root);
  const info = await lstat(base).catch(() => undefined);
  if (info === undefined) throw backupError(`backup root does not exist: ${root}`);
  if (!info.isDirectory()) throw backupError(`backup root is not a directory: ${root}`);
  const files: ManifestFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const child = await lstat(absolute);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      const buffer = await readFile(absolute);
      files.push({
        path: relative(base, absolute).split(sep).join('/'),
        size: buffer.byteLength,
        sha256: sha256(buffer)
      });
    }
  }
  await walk(base);
  return files;
}

export async function verifyManifest(root: string, manifest: BackupManifest): Promise<void> {
  const validated = validateManifest(manifest);
  for (const entry of validated.files) {
    const absolute = resolveBackupPath(root, entry.path);
    let buffer: Buffer;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw backupError(`checksum verification failed for ${entry.path}: not a regular file`);
      }
      buffer = await readFile(absolute);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('checksum')) throw error;
      throw backupError(`checksum verification failed for ${entry.path}: file is missing`);
    }
    if (buffer.byteLength !== entry.size || sha256(buffer) !== entry.sha256) {
      throw backupError(`checksum mismatch for ${entry.path}`);
    }
    if (entry.path.endsWith('.tar')) {
      await validateBackupArchive(
        absolute,
        entry.path.startsWith('volumes/') ? 'volume' : 'vault'
      );
    }
  }
}

export async function readManifestFile(path: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw backupError(`backup manifest cannot be read: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw backupError('backup manifest is not valid JSON');
  }
  return validateManifest(parsed);
}

export async function writeManifestFile(path: string, manifest: BackupManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
