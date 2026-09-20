import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  BACKEND_TIMEOUT_MS,
  CONCURRENT_READS,
  INPUT_BODY_MAX_BYTES,
  MATERIALIZATION_TIMEOUT_MS,
  RECONCILE_INTERVAL_MS,
  RENDERED_NOTE_MAX_BYTES,
  SCOPE_ID_PATTERN,
  TOOL_RESULT_MAX_BYTES
} from '../core/limits.js';
import type { Principal, ScopeConfig } from '../core/types.js';
import type { BrainConfig, CredentialRecord } from '../config/schema.js';
import { BrainError } from '../contracts/errors.js';
import { brainConfigSchema } from '../config/schema.js';

export interface BootstrapOptions {
  root: string;
  scope: string;
  vault_path?: string;
  uid?: number;
  gid?: number;
  owner_credential?: boolean;
}

export interface BootstrapResult {
  created: string[];
  preserved: string[];
  vault_path: string;
  config_path: string;
}

export const TOKEN_BYTES = 32;
export const CURSOR_KEY_BYTES = 32;
export const DEFAULT_SCOPE = 'freellmapi';
export const DEFAULT_VAULT_MOUNT = '/vault';
export const DEFAULT_STATE_MOUNT = '/var/lib/second-brain';
export const DEFAULT_CREDENTIALS_MOUNT = '/run/secrets/brain_credentials';
export const DEFAULT_CURSOR_MOUNT = '/run/secrets/brain_cursor';

const CONFIG_RELATIVE = 'config/brain.yaml';
const CREDENTIALS_RELATIVE = 'secrets/credentials.json';
const REVIEWER_TOKEN_RELATIVE = 'secrets/brain-token';
const CURSOR_KEY_RELATIVE = 'secrets/cursor-key';
const OWNER_TOKEN_RELATIVE = 'secrets/owner-token';

const SCOPE_RELATIVE_ROOTS: Record<string, string> = {
  freellmapi: 'Projects/freellmapi',
  shared: 'Shared',
  profile: 'Profile'
};

const SCOPE_ALIASES: Record<string, string[]> = {
  freellmapi: ['freellmapi', 'free-llm-api']
};

const SECRET_MODE = 0o600;
const CONFIG_MODE = 0o644;
const DIRECTORY_MODE = 0o775;

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function requireScope(scope: string): string {
  if (typeof scope !== 'string' || !SCOPE_ID_PATTERN.test(scope)) {
    throw invalidInput(`scope identifier must match ${SCOPE_ID_PATTERN.source}`);
  }
  return scope;
}

function relativeRoot(scope: string): string {
  return SCOPE_RELATIVE_ROOTS[scope] ?? `Projects/${scope}`;
}

function scopeAliases(scope: string, primary: string): string[] {
  if (scope !== primary) return [];
  return SCOPE_ALIASES[scope] ?? [scope];
}

function buildScopes(primary: string): ScopeConfig[] {
  const ids = [primary];
  if (!ids.includes('shared')) ids.push('shared');
  if (!ids.includes('profile')) ids.push('profile');
  return ids.map((id) => ({
    id,
    backend_project: id,
    relative_root: relativeRoot(id),
    repository_aliases: scopeAliases(id, primary)
  }));
}

function buildConfig(scopes: ScopeConfig[]): BrainConfig {
  return {
    endpoint: 'http://127.0.0.1:7331/mcp',
    backend_endpoint: 'http://memory:8000/mcp',
    port: 7331,
    mounts: { vault: DEFAULT_VAULT_MOUNT, state: DEFAULT_STATE_MOUNT },
    credentials_file: DEFAULT_CREDENTIALS_MOUNT,
    cursor_secret_file: DEFAULT_CURSOR_MOUNT,
    scopes,
    limits: {
      input_body_max_bytes: INPUT_BODY_MAX_BYTES,
      rendered_note_max_bytes: RENDERED_NOTE_MAX_BYTES,
      tool_result_max_bytes: TOOL_RESULT_MAX_BYTES,
      backend_timeout_ms: BACKEND_TIMEOUT_MS,
      materialization_timeout_ms: MATERIALIZATION_TIMEOUT_MS,
      reconcile_interval_ms: RECONCILE_INTERVAL_MS,
      concurrent_reads: CONCURRENT_READS
    },
    allowed_hosts: ['127.0.0.1', 'localhost'],
    allowed_origins: ['http://127.0.0.1:7331', 'http://localhost:7331'],
    result_delivery: 'structured'
  };
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readBinaryIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function scopePermissionMask(): number {
  return fsConstants.W_OK | fsConstants.X_OK;
}

function hasAccess(info: { uid: number; gid: number; mode: number }, uid: number, gid: number, mask: number): boolean {
  if (info.uid === uid && (info.mode & (mask << 6)) === mask << 6) return true;
  if (info.gid === gid && (info.mode & (mask << 3)) === mask << 3) return true;
  return (info.mode & mask) === mask;
}

async function assertScopesAccessible(
  vaultPath: string,
  scopes: ScopeConfig[],
  uid: number,
  gid: number
): Promise<void> {
  for (const scope of scopes) {
    const absolute = join(vaultPath, scope.relative_root);
    let info;
    try {
      info = await stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw invalidInput(`vault scope path is not accessible: ${absolute}`);
    }
    if (!info.isDirectory()) {
      throw invalidInput(`vault scope path is not a directory: ${absolute}`);
    }
    if (!hasAccess({ uid: info.uid, gid: info.gid, mode: info.mode }, uid, gid, scopePermissionMask())) {
      throw invalidInput(`vault scope path is not writable by uid ${uid}: ${absolute}`);
    }
  }
}

async function applyOwnership(path: string, uid?: number, gid?: number): Promise<void> {
  if (uid === undefined && gid === undefined) return;
  try {
    await chown(path, uid ?? -1, gid ?? -1);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const effective = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (code === 'EPERM' && effective !== undefined && (uid === undefined || uid === effective)) return;
    throw error;
  }
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const root = resolve(options.root);
  const scope = requireScope(options.scope ?? DEFAULT_SCOPE);
  const uid = options.uid;
  const gid = options.gid;
  const wantOwner = options.owner_credential === true;

  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'secrets'), { recursive: true, mode: 0o700 });

  const configPath = join(root, CONFIG_RELATIVE);
  const credentialsPath = join(root, CREDENTIALS_RELATIVE);
  const reviewerTokenPath = join(root, REVIEWER_TOKEN_RELATIVE);
  const cursorPath = join(root, CURSOR_KEY_RELATIVE);
  const ownerTokenPath = join(root, OWNER_TOKEN_RELATIVE);

  const scopes = buildScopes(scope);
  const created: string[] = [];
  const preserved: string[] = [];

  const existingConfig = await readIfExists(configPath);
  if (existingConfig === undefined) {
    const config = buildConfig(scopes);
    const parsed = brainConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw invalidInput('generated configuration failed validation');
    }
    await writeFile(configPath, stringify(config), { mode: CONFIG_MODE });
    await applyOwnership(configPath, uid, gid);
    created.push(CONFIG_RELATIVE);
  } else {
    preserved.push(CONFIG_RELATIVE);
  }

  const existingReviewer = await readIfExists(reviewerTokenPath);
  const reviewerToken = existingReviewer === undefined ? newToken() : existingReviewer.trim();
  if (existingReviewer === undefined) {
    await writeFile(reviewerTokenPath, `${reviewerToken}\n`, { mode: SECRET_MODE });
    await applyOwnership(reviewerTokenPath, uid, gid);
    created.push(REVIEWER_TOKEN_RELATIVE);
  } else {
    preserved.push(REVIEWER_TOKEN_RELATIVE);
  }

  const existingCursor = await readBinaryIfExists(cursorPath);
  if (existingCursor === undefined) {
    await writeFile(cursorPath, randomBytes(CURSOR_KEY_BYTES), { mode: SECRET_MODE });
    await applyOwnership(cursorPath, uid, gid);
    created.push(CURSOR_KEY_RELATIVE);
  } else {
    preserved.push(CURSOR_KEY_RELATIVE);
  }

  let ownerToken: string | undefined;
  const existingOwner = await readIfExists(ownerTokenPath);
  if (wantOwner) {
    ownerToken = existingOwner === undefined ? newToken() : existingOwner.trim();
    if (existingOwner === undefined) {
      await writeFile(ownerTokenPath, `${ownerToken}\n`, { mode: SECRET_MODE });
      await applyOwnership(ownerTokenPath, uid, gid);
      created.push(OWNER_TOKEN_RELATIVE);
    } else {
      preserved.push(OWNER_TOKEN_RELATIVE);
    }
  } else if (existingOwner !== undefined) {
    preserved.push(OWNER_TOKEN_RELATIVE);
  }

  const existingCredentials = await readIfExists(credentialsPath);
  if (existingCredentials === undefined) {
    const readScopes = [scope];
    if (!readScopes.includes('shared')) readScopes.push('shared');
    const reviewer: Principal = {
      id: randomUUID(),
      role: 'reviewer',
      read_scopes: readScopes,
      write_scopes: [scope],
      review_scopes: [scope]
    };
    const records: CredentialRecord[] = [
      { token_sha256: tokenDigest(reviewerToken), principal: reviewer }
    ];
    if (wantOwner && ownerToken !== undefined) {
      const owner: Principal = {
        id: randomUUID(),
        role: 'owner',
        read_scopes: scopes.map((entry) => entry.id),
        write_scopes: scopes.map((entry) => entry.id),
        review_scopes: scopes.map((entry) => entry.id)
      };
      records.push({ token_sha256: tokenDigest(ownerToken), principal: owner });
    }
    await writeFile(credentialsPath, `${JSON.stringify({ credentials: records }, null, 2)}\n`, {
      mode: SECRET_MODE
    });
    await applyOwnership(credentialsPath, uid, gid);
    created.push(CREDENTIALS_RELATIVE);
  } else {
    preserved.push(CREDENTIALS_RELATIVE);
  }

  const vaultPath = options.vault_path === undefined
    ? join(root, 'vault')
    : isAbsolute(options.vault_path)
      ? options.vault_path
      : resolve(root, options.vault_path);
  let vaultInfo;
  try {
    vaultInfo = await stat(vaultPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    vaultInfo = undefined;
  }
  if (vaultInfo === undefined) {
    await mkdir(vaultPath, { recursive: true, mode: DIRECTORY_MODE });
    for (const entry of scopes) {
      const scopePath = join(vaultPath, entry.relative_root);
      await mkdir(scopePath, { recursive: true, mode: DIRECTORY_MODE });
      await applyOwnership(scopePath, uid, gid);
    }
    await applyOwnership(vaultPath, uid, gid);
    created.push('vault');
  } else {
    if (!vaultInfo.isDirectory()) {
      throw invalidInput(`vault path is not a directory: ${vaultPath}`);
    }
    try {
      await access(vaultPath, fsConstants.R_OK | fsConstants.X_OK);
    } catch {
      throw invalidInput(`vault path is not readable: ${vaultPath}`);
    }
    if (uid !== undefined && uid !== 0) {
      const info = await stat(vaultPath);
      if (!hasAccess({ uid: info.uid, gid: info.gid, mode: info.mode }, uid, gid ?? uid, scopePermissionMask())) {
        throw invalidInput(`vault path is not writable by uid ${uid}: ${vaultPath}`);
      }
      await assertScopesAccessible(vaultPath, scopes, uid, gid ?? uid);
    }
    preserved.push('vault');
  }

  await chmod(join(root, 'secrets'), 0o700);

  return { created, preserved, vault_path: vaultPath, config_path: configPath };
}
