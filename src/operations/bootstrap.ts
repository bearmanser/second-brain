import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  BACKEND_TIMEOUT_MS,
  CONCURRENT_READS,
  DYNAMIC_PROJECTS_MAX,
  INPUT_BODY_MAX_BYTES,
  MATERIALIZATION_TIMEOUT_MS,
  PROJECT_PROVISION_GLOBAL_PER_MINUTE,
  PROJECT_PROVISION_PER_PRINCIPAL_PER_MINUTE,
  RECONCILE_INTERVAL_MS,
  RENDERED_NOTE_MAX_BYTES,
  SCOPE_ID_PATTERN,
  TOOL_RESULT_MAX_BYTES
} from '../core/limits.js';
import type { Principal, ScopeConfig } from '../core/types.js';
import type { BrainConfig, CredentialRecord } from '../config/schema.js';
import { BrainError } from '../contracts/errors.js';
import { brainConfigSchema, credentialsFileSchema } from '../config/schema.js';
import { hasPermission } from './permissions.js';

export interface BootstrapOptions {
  root: string;
  scope?: string;
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

function scopeAliases(scope: string, primary: string | undefined): string[] {
  if (primary === undefined || scope !== primary) return [];
  return SCOPE_ALIASES[scope] ?? [scope];
}

function buildScopes(primary: string | undefined): ScopeConfig[] {
  const ids = primary === undefined ? [] : [primary];
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
      concurrent_reads: CONCURRENT_READS,
      project_provision_per_principal_per_minute: PROJECT_PROVISION_PER_PRINCIPAL_PER_MINUTE,
      project_provision_global_per_minute: PROJECT_PROVISION_GLOBAL_PER_MINUTE,
      dynamic_projects_max: DYNAMIC_PROJECTS_MAX
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

const DIRECTORY_ACCESS_MASK = fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK;

async function assertDirectoryAccess(
  path: string,
  uid: number,
  gid: number,
  mask: number,
  label: string
): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw invalidInput(`${label} is not accessible: ${path}`);
  }
  if (!info.isDirectory()) {
    throw invalidInput(`${label} is not a directory: ${path}`);
  }
  if (!hasPermission({ uid: info.uid, gid: info.gid, mode: info.mode }, uid, gid, mask)) {
    throw invalidInput(`${label} does not grant uid ${uid} the required permissions: ${path}`);
  }
}

async function ensureScopePath(
  vaultPath: string,
  relativeRoot: string,
  uid: number | undefined,
  gid: number | undefined,
  created: string[]
): Promise<void> {
  let current = vaultPath;
  for (const segment of relativeRoot.split('/').filter((entry) => entry.length > 0)) {
    current = join(current, segment);
    let info;
    try {
      info = await stat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw invalidInput(`vault scope path is not accessible: ${current}`);
      }
      await mkdir(current, { recursive: true, mode: DIRECTORY_MODE });
      await applyOwnership(current, uid, gid);
      created.push(current);
      continue;
    }
    if (!info.isDirectory()) {
      throw invalidInput(`vault scope path is not a directory: ${current}`);
    }
    if (uid !== undefined && uid !== 0) {
      const effectiveGid = gid ?? uid;
      if (!hasPermission({ uid: info.uid, gid: info.gid, mode: info.mode }, uid, effectiveGid, DIRECTORY_ACCESS_MASK)) {
        throw invalidInput(`vault scope path does not grant uid ${uid} the required permissions: ${current}`);
      }
    }
  }
}

function reviewerPrincipal(scope: string | undefined): Principal {
  const readScopes = scope === undefined ? ['shared'] : [scope];
  if (scope !== undefined && !readScopes.includes('shared')) readScopes.push('shared');
  return {
    id: randomUUID(),
    role: 'reviewer',
    read_scopes: readScopes,
    write_scopes: scope === undefined ? [] : [scope],
    review_scopes: scope === undefined ? [] : [scope]
  };
}

function ownerPrincipal(scopes: ScopeConfig[]): Principal {
  const ids = scopes.map((entry) => entry.id);
  return {
    id: randomUUID(),
    role: 'owner',
    read_scopes: ids,
    write_scopes: ids,
    review_scopes: ids
  };
}

function parseCredentialsDocument(text: string): { credentials: CredentialRecord[] } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw invalidInput('secrets/credentials.json is not valid JSON; refusing to modify it');
  }
  const parsed = credentialsFileSchema.safeParse(document);
  if (!parsed.success) {
    throw invalidInput('secrets/credentials.json is invalid; refusing to modify it');
  }
  return { credentials: parsed.data.credentials };
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
  const scope = options.scope === undefined ? undefined : requireScope(options.scope);
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
    preserved.push('vault');
  }

  if (uid !== undefined && uid !== 0) {
    const effectiveGid = gid ?? uid;
    await assertDirectoryAccess(vaultPath, uid, effectiveGid, DIRECTORY_ACCESS_MASK, 'vault path');
  }

  for (const entry of scopes) {
    await ensureScopePath(vaultPath, entry.relative_root, uid, gid, created);
  }

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

  const existingCredentials = await readIfExists(credentialsPath);
  const credentialsDocument =
    existingCredentials === undefined ? undefined : parseCredentialsDocument(existingCredentials);

  let ownerToken: string | undefined;
  const existingOwner = await readIfExists(ownerTokenPath);
  if (wantOwner) {
    if (existingOwner !== undefined) {
      ownerToken = existingOwner.trim();
      preserved.push(OWNER_TOKEN_RELATIVE);
    } else if (
      credentialsDocument !== undefined &&
      credentialsDocument.credentials.some((record) => record.principal.role === 'owner')
    ) {
      throw invalidInput(
        'an owner credential is recorded in secrets/credentials.json but secrets/owner-token is missing; restore the token file or remove the owner record before enabling owner_credential'
      );
    } else {
      ownerToken = newToken();
      await writeFile(ownerTokenPath, `${ownerToken}\n`, { mode: SECRET_MODE });
      await applyOwnership(ownerTokenPath, uid, gid);
      created.push(OWNER_TOKEN_RELATIVE);
    }
  } else if (existingOwner !== undefined) {
    preserved.push(OWNER_TOKEN_RELATIVE);
  }

  if (credentialsDocument === undefined) {
    const records: CredentialRecord[] = [
      { token_sha256: tokenDigest(reviewerToken), principal: reviewerPrincipal(scope) }
    ];
    if (wantOwner && ownerToken !== undefined) {
      records.push({ token_sha256: tokenDigest(ownerToken), principal: ownerPrincipal(scopes) });
    }
    await writeFile(credentialsPath, `${JSON.stringify({ credentials: records }, null, 2)}\n`, {
      mode: SECRET_MODE
    });
    await applyOwnership(credentialsPath, uid, gid);
    created.push(CREDENTIALS_RELATIVE);
  } else {
    const records = credentialsDocument.credentials;
    let changed = false;
    const reviewerDigest = tokenDigest(reviewerToken);
    if (!records.some((record) => record.token_sha256 === reviewerDigest)) {
      records.push({ token_sha256: reviewerDigest, principal: reviewerPrincipal(scope) });
      changed = true;
    }
    if (wantOwner && ownerToken !== undefined) {
      const ownerDigest = tokenDigest(ownerToken);
      if (!records.some((record) => record.token_sha256 === ownerDigest)) {
        records.push({ token_sha256: ownerDigest, principal: ownerPrincipal(scopes) });
        changed = true;
      }
    }
    if (changed) {
      await writeFile(credentialsPath, `${JSON.stringify({ credentials: records }, null, 2)}\n`, {
        mode: SECRET_MODE
      });
      await applyOwnership(credentialsPath, uid, gid);
      created.push(CREDENTIALS_RELATIVE);
    } else {
      preserved.push(CREDENTIALS_RELATIVE);
    }
  }

  await chmod(join(root, 'secrets'), 0o700);

  return { created, preserved, vault_path: vaultPath, config_path: configPath };
}
