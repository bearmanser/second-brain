import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export const BACKUP_FORMAT_VERSION = 1;
export const SUPPORTED_BACKUP_FORMATS: readonly number[] = [1];

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
  files: ManifestFile[];
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function backupError(message: string): Error {
  return new Error(message);
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

function assertManifestShape(manifest: BackupManifest): void {
  if (manifest === null || typeof manifest !== 'object') {
    throw backupError('backup manifest is not an object');
  }
  if (!SUPPORTED_BACKUP_FORMATS.includes(manifest.format_version)) {
    throw backupError(`unsupported backup format version ${String(manifest.format_version)}`);
  }
  if (!Array.isArray(manifest.files)) {
    throw backupError('backup manifest has no file entries');
  }
  if (!Array.isArray(manifest.stores)) {
    throw backupError('backup manifest has no store list');
  }
  if (
    manifest.software === null ||
    typeof manifest.software !== 'object' ||
    Array.isArray(manifest.software)
  ) {
    throw backupError('backup manifest has no software version block');
  }
}

export function assertCompatibleStateSchema(manifest: BackupManifest, current: number): void {
  assertManifestShape(manifest);
  const schema = manifest.software.schema;
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) {
    throw backupError('backup manifest has an invalid application-state schema version');
  }
  if (schema > current) {
    throw backupError(
      `backup state schema version ${schema} is newer than this release supports (${current})`
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
  assertManifestShape(manifest);
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      typeof entry.size !== 'number' ||
      typeof entry.sha256 !== 'string'
    ) {
      throw backupError('backup manifest contains an invalid file entry');
    }
    if (seen.has(entry.path)) {
      throw backupError(`backup manifest contains a duplicate entry: ${entry.path}`);
    }
    seen.add(entry.path);
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
  }
}

export async function readManifestFile(path: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw backupError(`backup manifest cannot be read: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw backupError('backup manifest is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw backupError('backup manifest is not an object');
  }
  const manifest = parsed as BackupManifest;
  assertManifestShape(manifest);
  return manifest;
}

export async function writeManifestFile(path: string, manifest: BackupManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
