import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

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

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function backupError(message: string): Error {
  return new Error(message);
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
