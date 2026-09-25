import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import {
  BACKEND_TIMEOUT_MS,
  CONCURRENT_READS,
  DYNAMIC_PROJECTS_MAX,
  INPUT_BODY_MAX_BYTES,
  MATERIALIZATION_TIMEOUT_MS,
  PROJECT_PROVISION_GLOBAL_PER_MINUTE,
  RECONCILE_INTERVAL_MS,
  RENDERED_NOTE_MAX_BYTES,
  SCOPE_ID_PATTERN,
  TOOL_RESULT_MAX_BYTES
} from '../core/limits.js';
import type { ScopeConfig } from '../core/types.js';
import type { BrainConfig } from '../config/schema.js';
import { BrainError } from '../contracts/errors.js';
import { brainConfigSchema, TOKEN_SHA256_PATTERN } from '../config/schema.js';
import { hasPermission } from './permissions.js';

export interface BootstrapOptions {
  root: string;
  scope?: string;
  vault_path?: string;
  uid?: number;
  gid?: number;
}

export interface BootstrapResult {
  created: string[];
  preserved: string[];
  vault_path: string;
  config_path: string;
  env_path: string;
}

export const TOKEN_BYTES = 32;
export const CURSOR_KEY_BYTES = 32;
export const DEFAULT_VAULT_MOUNT = '/vault';
export const DEFAULT_STATE_MOUNT = '/var/lib/second-brain';
export const DEFAULT_CURSOR_MOUNT = '/run/secrets/brain_cursor';
export const TOKEN_ENV_KEY = 'BRAIN_TOKEN_SHA256';

const CONFIG_RELATIVE = 'config/brain.yaml';
const TOKEN_RELATIVE = 'secrets/brain-token';
const CURSOR_KEY_RELATIVE = 'secrets/cursor-key';
const LEGACY_CREDENTIALS_RELATIVE = 'secrets/credentials.json';
const OWNER_TOKEN_RELATIVE = 'secrets/owner-token';
const ENV_RELATIVE = '.env';

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
    port: 7331,
    mounts: { vault: DEFAULT_VAULT_MOUNT, state: DEFAULT_STATE_MOUNT },
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

function isInside(parent: string, child: string): boolean {
  const canonicalParent = resolve(parent);
  const canonicalChild = resolve(child);
  return canonicalChild === canonicalParent || canonicalChild.startsWith(`${canonicalParent}${sep}`);
}

function parseEnvDigests(text: string, path: string): string[] {
  const digests: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?BRAIN_TOKEN_SHA256\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const value = match[1].replace(/^["']|["']$/g, '');
    if (!TOKEN_SHA256_PATTERN.test(value)) {
      throw invalidInput(`${path} contains a malformed ${TOKEN_ENV_KEY} assignment`);
    }
    digests.push(value);
  }
  return digests;
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

  const configPath = join(root, CONFIG_RELATIVE);
  const tokenPath = join(root, TOKEN_RELATIVE);
  const cursorPath = join(root, CURSOR_KEY_RELATIVE);
  const envPath = join(root, ENV_RELATIVE);
  const legacyCredentialsPath = join(root, LEGACY_CREDENTIALS_RELATIVE);
  const ownerTokenPath = join(root, OWNER_TOKEN_RELATIVE);

  const scopes = buildScopes(scope);
  const created: string[] = [];
  const preserved: string[] = [];

  const vaultPath = options.vault_path === undefined
    ? join(root, 'vault')
    : isAbsolute(options.vault_path)
      ? options.vault_path
      : resolve(root, options.vault_path);

  for (const secretPath of [tokenPath, cursorPath, envPath]) {
    if (isInside(vaultPath, secretPath)) {
      throw invalidInput(`setup secrets must not live inside the vault: ${secretPath}`);
    }
  }

  const existingEnvPeek = await readIfExists(envPath);
  const envDigestsPeek = existingEnvPeek === undefined ? [] : parseEnvDigests(existingEnvPeek, envPath);
  if (envDigestsPeek.length > 1) {
    throw invalidInput(`${envPath} assigns ${TOKEN_ENV_KEY} more than once`);
  }
  const existingConfigPeek = await readIfExists(configPath);
  if (existingConfigPeek !== undefined && /credentials_file\s*:/u.test(existingConfigPeek)) {
    throw invalidInput(
      `legacy credentials configuration at ${configPath} requires explicit conversion before rerunning setup`
    );
  }
  const legacyIndicators: string[] = [];
  if ((await readIfExists(legacyCredentialsPath)) !== undefined) {
    legacyIndicators.push(legacyCredentialsPath);
  }
  if ((await readIfExists(ownerTokenPath)) !== undefined) {
    legacyIndicators.push(ownerTokenPath);
  }
  if (legacyIndicators.length > 0 && envDigestsPeek.length === 0) {
    throw invalidInput(
      `legacy credentials found at ${legacyIndicators.join(', ')}; select one digest explicitly with ` +
        `"auth migrate --credentials-file <path> --select-entry N" and set ${TOKEN_ENV_KEY} before rerunning setup`
    );
  }

  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'secrets'), { recursive: true, mode: 0o700 });

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

  const existingCursor = await readBinaryIfExists(cursorPath);
  if (existingCursor === undefined) {
    await writeFile(cursorPath, randomBytes(CURSOR_KEY_BYTES), { mode: SECRET_MODE });
    await applyOwnership(cursorPath, uid, gid);
    created.push(CURSOR_KEY_RELATIVE);
  } else {
    preserved.push(CURSOR_KEY_RELATIVE);
  }

  const existingEnv = await readIfExists(envPath);
  const envDigests = existingEnv === undefined ? [] : parseEnvDigests(existingEnv, envPath);
  if (envDigests.length > 1) {
    throw invalidInput(`${envPath} assigns ${TOKEN_ENV_KEY} more than once`);
  }

  const existingToken = await readIfExists(tokenPath);
  let digest = envDigests[0];
  if (existingToken !== undefined) {
    const raw = existingToken.trim();
    if (raw.length === 0) throw invalidInput('secrets/brain-token is empty');
    const derived = tokenDigest(raw);
    if (digest !== undefined && digest !== derived) {
      throw invalidInput('secrets/brain-token does not match the configured BRAIN_TOKEN_SHA256');
    }
    digest = derived;
    preserved.push(TOKEN_RELATIVE);
  }
  if (digest === undefined) {
    const token = newToken();
    digest = tokenDigest(token);
    await writeFile(tokenPath, `${token}\n`, { mode: SECRET_MODE });
    await applyOwnership(tokenPath, uid, gid);
    created.push(TOKEN_RELATIVE);
  }

  if (envDigests.length === 0) {
    const separator = existingEnv === undefined || existingEnv.length === 0 || existingEnv.endsWith('\n')
      ? ''
      : '\n';
    await writeFile(envPath, `${existingEnv ?? ''}${separator}${TOKEN_ENV_KEY}=${digest}\n`, {
      mode: SECRET_MODE
    });
    await applyOwnership(envPath, uid, gid);
    created.push(ENV_RELATIVE);
  } else {
    preserved.push(ENV_RELATIVE);
  }

  await chmod(join(root, 'secrets'), 0o700);

  return { created, preserved, vault_path: vaultPath, config_path: configPath, env_path: envPath };
}
