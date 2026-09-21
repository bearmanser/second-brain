import { createHash } from 'node:crypto';
import { BrainError } from '../contracts/errors.js';
import { SCOPE_ID_PATTERN } from '../core/limits.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
const RAW_TRAVERSAL_SEGMENT = /[/:](?:\.|%2e)(?:\.|%2e)?(?=\/|$)/i;
const SCP_REMOTE = /^([A-Za-z0-9._-]+)@([^:/\s]+):(.+)$/;
const RESERVED_SCOPES = new Set(['shared', 'profile']);

const invalidRepository = (): BrainError =>
  new BrainError({
    code: 'INVALID_INPUT',
    message: 'remote_url must be a canonical HTTPS or SSH Git remote without credentials'
  });

function normalizePath(rawPath: string): string {
  if (ENCODED_SEPARATOR.test(rawPath) || rawPath.includes('\\')) throw invalidRepository();
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) throw invalidRepository();
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment.length === 0)) throw invalidRepository();

  const decoded = segments.map((segment) => {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw invalidRepository();
    }
    if (
      value.length === 0 ||
      value === '.' ||
      value === '..' ||
      value.includes('/') ||
      value.includes('\\') ||
      CONTROL_CHARACTERS.test(value)
    ) {
      throw invalidRepository();
    }
    return value;
  });

  const repository = decoded.at(-1)?.replace(/\.git$/i, '') ?? '';
  if (repository.length === 0 || repository === '.' || repository === '..') {
    throw invalidRepository();
  }
  decoded[decoded.length - 1] = repository;
  return decoded.join('/');
}

export function normalizeRepositoryIdentity(remoteUrl: string): string {
  if (
    remoteUrl.length === 0 ||
    remoteUrl !== remoteUrl.trim() ||
    CONTROL_CHARACTERS.test(remoteUrl) ||
    ENCODED_SEPARATOR.test(remoteUrl) ||
    RAW_TRAVERSAL_SEGMENT.test(remoteUrl) ||
    remoteUrl.includes('?') ||
    remoteUrl.includes('#')
  ) {
    throw invalidRepository();
  }

  const scp = SCP_REMOTE.exec(remoteUrl);
  if (scp !== null) {
    let hostname: string;
    try {
      hostname = new URL(`ssh://${scp[1]}@${scp[2]}`).hostname;
    } catch {
      throw invalidRepository();
    }
    if (hostname.length === 0) throw invalidRepository();
    return `${hostname.toLowerCase()}/${normalizePath(scp[3])}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw invalidRepository();
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') throw invalidRepository();
  if (parsed.password.length > 0) throw invalidRepository();
  if (parsed.protocol === 'https:' && parsed.username.length > 0) throw invalidRepository();
  if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.hostname.length === 0) {
    throw invalidRepository();
  }
  const host = parsed.port.length > 0 ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  return `${host.toLowerCase()}/${normalizePath(parsed.pathname)}`;
}

export function scopeCandidateForRepository(identity: string): string {
  const repository = identity.split('/').at(-1) ?? '';
  const candidate = repository
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (!SCOPE_ID_PATTERN.test(candidate) || RESERVED_SCOPES.has(candidate)) {
    throw invalidRepository();
  }
  return candidate;
}

export function scopeWithCollisionSuffix(candidate: string, identity: string): string {
  if (!SCOPE_ID_PATTERN.test(candidate)) throw invalidRepository();
  const suffix = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 10);
  const prefix = candidate.slice(0, 53).replace(/-+$/g, '');
  const scoped = `${prefix}-${suffix}`;
  if (!SCOPE_ID_PATTERN.test(scoped) || RESERVED_SCOPES.has(scoped)) throw invalidRepository();
  return scoped;
}
