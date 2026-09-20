import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { BrainError } from '../contracts/errors.js';
import { RENDERED_NOTE_MAX_BYTES } from '../core/limits.js';
import type { ScopeConfig, VaultPort } from '../core/types.js';

const MARKER_PATTERN = /^[ \t]*brain_schema_version[ \t]*:/m;
const PREFIX_BYTES = 8 * 1024;
const MAX_READ_ATTEMPTS = 4;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

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

interface StableRead {
  kind: 'stable';
  value: { raw: string; raw_hash: string; relative_path: string };
}

interface UnstableRead {
  kind: 'unstable';
}

export class FileVault implements VaultPort {
  private readonly root: string;
  private readonly scopes: Map<string, ScopeConfig>;

  constructor(root: string, scopes: ScopeConfig[]) {
    this.root = resolve(root);
    this.scopes = new Map(scopes.map((scope) => [scope.id, scope]));
  }

  async list(scope: string): Promise<string[]> {
    const config = this.requireScope(scope);
    const prefix = segmentsOf(config.relative_root);
    const directory = join(this.root, ...prefix);
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) return [];
      throw recoveryRequired(`scope root ${directory} cannot be inspected`, error);
    }
    if (info.isSymbolicLink()) {
      throw forbidden(`scope root ${config.relative_root} is a symbolic link`);
    }
    if (!info.isDirectory()) return [];
    const found: string[] = [];
    await this.walk(directory, prefix.join('/'), found);
    found.sort();
    return found;
  }

  async read(
    scope: string,
    relativePath: string
  ): Promise<{ raw: string; raw_hash: string; relative_path: string }> {
    const config = this.requireScope(scope);
    const segments = this.validatePath(config, relativePath);
    const absolute = await this.assertSegments(segments);
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      const outcome = await this.readOnce(absolute, segments.join('/'));
      if (outcome.kind === 'stable') return outcome.value;
    }
    throw unstable(`file ${segments.join('/')} changed while it was being read`);
  }

  private async readOnce(absolute: string, relativePath: string): Promise<StableRead | UnstableRead> {
    let handle;
    try {
      handle = await open(absolute, READ_FLAGS);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) throw notFound(`file ${relativePath} does not exist`);
      if (hasErrno(error, 'ELOOP')) throw forbidden(`path ${relativePath} contains a symbolic link`);
      throw recoveryRequired(`file ${relativePath} cannot be opened`, error);
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw notFound(`file ${relativePath} is not a regular file`);
      if (before.size > RENDERED_NOTE_MAX_BYTES) {
        throw limitExceeded(
          `file ${relativePath} is ${before.size} bytes and exceeds the ${RENDERED_NOTE_MAX_BYTES} byte limit`
        );
      }
      const buffer = await handle.readFile();
      const after = await handle.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
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

  private async walk(directory: string, relative: string, found: string[]): Promise<void> {
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
        await this.walk(absolute, relativePath, found);
        continue;
      }
      if (!info.isFile() || !entry.name.endsWith('.md')) continue;
      const prefix = await this.readPrefix(absolute, info.size);
      if (prefix !== undefined && hasBrainMarker(prefix)) found.push(relativePath);
    }
  }

  private async readPrefix(absolute: string, size: number): Promise<string | undefined> {
    const length = Math.min(size, PREFIX_BYTES);
    let handle;
    try {
      handle = await open(absolute, READ_FLAGS);
    } catch {
      return undefined;
    }
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch {
      return undefined;
    } finally {
      await handle.close();
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
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${sep}`)) {
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
}
