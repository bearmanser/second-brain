import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { InstanceLock } from '../core/mutation.js';
import type { Clock } from '../core/types.js';
import { APPLICATION_VERSION, SCHEMA_VERSION } from '../mcp/tools.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../notes/current-catalogue.js';
import { indexReconciledDocuments } from '../notes/reconcile.js';
import type { SearchIndex } from '../storage/search-index.js';
import { openSearchIndex } from '../storage/search-index.js';
import { FileVault, scanVaultFilePaths } from '../storage/vault.js';

export const LOCAL_BACKUP_FORMAT_VERSION = 1;
export const LOCAL_INDEX_SCHEMA_VERSION = 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const JOURNAL_PATHS = ['state/journal.db', 'state/documents.sqlite', 'state/operations.sqlite'];
const REQUIRED_JOURNAL_TABLES = [
  'schema_migrations',
  'operations',
  'operation_approvals',
  'projects_v2',
  'feedback_records',
  'retrieval_labels'
] as const;

export type LocalBackupScope = 'full' | 'vault-only';

export type LocalBackupCategory =
  | 'vault'
  | 'state'
  | 'revision_snapshots'
  | 'journal'
  | 'migration_manifests'
  | 'config'
  | 'version_manifest'
  | 'model_artifacts'
  | 'search_index'
  | 'secrets';

export type LocalBackupRoot = 'vault' | 'state' | 'config' | 'secrets';

export interface RecoveryInputPresence {
  vault: boolean;
  history: boolean;
  journal: boolean;
  index: boolean;
}

export interface RecoveryClassification {
  current_content_recoverable: boolean;
  history_recoverable: boolean;
  idempotency_recoverable: boolean;
  index_rebuildable: boolean;
}

export interface LocalBackupFile {
  root: LocalBackupRoot;
  path: string;
  category: LocalBackupCategory;
  size: number;
  sha256: string;
}

export interface LocalBackupDigest {
  files: number;
  sha256: string;
}

export interface LocalBackupRoots {
  vault: string;
  state: string;
  config?: string;
  secrets?: string;
}

export interface LocalBackupManifest {
  format_version: number;
  created_at: string;
  application: string;
  schema: number;
  scope: LocalBackupScope;
  roots: LocalBackupRoots;
  sensitive: boolean;
  categories: LocalBackupCategory[];
  sensitive_categories: LocalBackupCategory[];
  reproducible_categories: LocalBackupCategory[];
  digests: Partial<Record<LocalBackupCategory, LocalBackupDigest>>;
  files: LocalBackupFile[];
}

export interface LocalBackupVerification {
  ok: boolean;
  integrity_ok: boolean;
  durable_complete: boolean;
  format_version: number;
  scope: LocalBackupScope;
  classification: RecoveryClassification;
  sensitive: boolean;
  present_categories: LocalBackupCategory[];
  complete_categories: LocalBackupCategory[];
  incomplete_categories: LocalBackupCategory[];
  missing_files: string[];
  checksum_failures: string[];
  counts: { files: number };
}

export interface TakeLocalBackupOptions {
  vault: string;
  state: string;
  destination: string;
  scope?: LocalBackupScope;
  includeSearchIndex?: boolean;
  includeModelArtifacts?: boolean;
  config?: string;
  secrets?: readonly string[];
  allowWriters?: boolean;
  clock?: Clock;
}

export interface TakeLocalBackupResult {
  manifest: LocalBackupManifest;
  manifest_path: string;
  files: number;
  sensitive: boolean;
}

export interface RestoreLocalBackupOptions {
  backupRoot: string;
  vault: string;
  state: string;
  clock?: Clock;
}

export interface RestoreLocalBackupResult {
  classification: RecoveryClassification;
  history_recovered: boolean;
  receipts_recovered: boolean;
  restored_files: number;
  warnings: string[];
}

export interface ImportLocalVaultOptions {
  backupRoot: string;
  vault: string;
  clock?: Clock;
}

export interface ImportLocalVaultResult {
  classification: RecoveryClassification;
  imported_files: number;
  warnings: string[];
}

export interface RebuildFaults {
  validate?(): void | Promise<void>;
  publish?(): void | Promise<void>;
}

export interface RebuildLocalIndexOptions {
  vault: string;
  state: string;
  clock?: Clock;
  closePrevious?: () => void | Promise<void>;
  faults?: RebuildFaults;
}

export interface LocalIndexCounts {
  documents: number;
  chunks: number;
}

export interface LocalIndexMetadata {
  schema: number;
  fingerprint: string;
  documents: number;
  chunks: number;
  created_at: string;
}

export type RebuildLocalIndexResult =
  | {
      status: 'rebuilt';
      index_path: string;
      metadata_path: string;
      counts: LocalIndexCounts;
      fingerprint: string;
    }
  | {
      status: 'degraded';
      reason: string;
      previous_index: string | null;
      counts: LocalIndexCounts;
    };

export type DurableJournalState =
  | 'present'
  | 'missing'
  | 'damaged'
  | 'migration_required'
  | 'backfill_required';

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function sha256(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function errorMessage(error: unknown): string {
  if (isBrainError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function hasErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

export function classifyRecoveryInput(input: RecoveryInputPresence): RecoveryClassification {
  const vault = input.vault === true;
  const history = vault && input.history === true;
  const idempotency = history && input.journal === true;
  return {
    current_content_recoverable: vault,
    history_recoverable: history,
    idempotency_recoverable: idempotency,
    index_rebuildable: vault
  };
}

function pendingApprovalBackfill(database: Database.Database): number {
  const approvals = new Set(
    (
      database.prepare('SELECT operation_id FROM operation_approvals').all() as {
        operation_id: string;
      }[]
    ).map((row) => row.operation_id)
  );
  const rows = database
    .prepare('SELECT operation_id, plan_json FROM operations WHERE plan_json IS NOT NULL')
    .all() as { operation_id: string; plan_json: string }[];
  let pending = 0;
  for (const row of rows) {
    if (approvals.has(row.operation_id)) continue;
    let plan: unknown;
    try {
      plan = JSON.parse(row.plan_json);
    } catch {
      continue;
    }
    if (plan === null || typeof plan !== 'object') continue;
    const revision = (plan as { revision?: unknown }).revision;
    if (revision === null || typeof revision !== 'object') continue;
    const approval = (revision as { approval?: unknown }).approval;
    if (approval !== null && typeof approval === 'object') pending += 1;
  }
  return pending;
}

export function inspectDurableJournal(state: string): DurableJournalState {
  const path = join(resolve(state), 'journal.db');
  if (!existsSync(path)) return 'missing';
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    if (database.pragma('quick_check', { simple: true }) !== 'ok') return 'damaged';
    const tables = new Set(
      (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name)
    );
    for (const table of REQUIRED_JOURNAL_TABLES) {
      if (!tables.has(table)) return 'migration_required';
    }
    const applied = database
      .prepare('SELECT COUNT(*) AS count FROM schema_migrations')
      .get() as { count: number };
    if (applied.count === 0) return 'migration_required';
    database.prepare('SELECT COUNT(*) AS count FROM operations').get();
    database.prepare('SELECT COUNT(*) AS count FROM projects_v2').get();
    return pendingApprovalBackfill(database) > 0 ? 'backfill_required' : 'present';
  } catch {
    return 'damaged';
  } finally {
    database?.close();
  }
}

async function assertSafeRoot(root: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    throw recoveryRequired(`${label} ${root} cannot be inspected`, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw recoveryRequired(`${label} ${root} is not a safe directory`);
  }
}

async function assertEmptyOrAbsent(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return;
    throw recoveryRequired(`${label} ${path} cannot be inspected`, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw invalidInput(`${label} ${path} must be an absent or empty directory`);
  }
  const entries = await readdir(path);
  if (entries.length > 0) {
    throw invalidInput(`${label} ${path} must be an empty directory`);
  }
}

interface WalkedFile {
  path: string;
  size: number;
  sha256: string;
}

async function walkFiles(root: string): Promise<WalkedFile[]> {
  const base = resolve(root);
  if (!existsSync(base)) return [];
  await assertSafeRoot(base, 'backup store');
  const files: WalkedFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw recoveryRequired(`backup store contains a symbolic link: ${absolute}`);
      if (info.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!info.isFile()) continue;
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

async function copyTree(source: string, destination: string): Promise<void> {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return;
    throw recoveryRequired(`source store ${source} cannot be inspected`, error);
  }
  if (info.isSymbolicLink()) {
    throw recoveryRequired(`source store ${source} is a symbolic link`);
  }
  if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    return;
  }
  if (!info.isDirectory()) throw recoveryRequired(`source store ${source} is not a directory`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const child = join(source, entry.name);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink()) {
      throw recoveryRequired(`source store contains a symbolic link: ${child}`);
    }
    await copyTree(child, join(destination, entry.name));
  }
}

export async function snapshotSqliteDatabase(source: string, destination: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return false;
    throw recoveryRequired(`sqlite database ${source} cannot be inspected`, error);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw recoveryRequired(`sqlite database ${source} is not a regular file`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rm(destination, { force: true });
  let database: Database.Database;
  try {
    database = new Database(source);
  } catch (error) {
    throw recoveryRequired(`sqlite database ${source} cannot be opened`, error);
  }
  try {
    await database.backup(destination);
  } catch (error) {
    throw recoveryRequired(`sqlite database ${source} cannot be snapshotted`, error);
  } finally {
    database.close();
  }
  return true;
}

function categoryFor(rel: string): LocalBackupCategory {
  if (rel.startsWith('vault/')) return 'vault';
  if (rel.startsWith('state/history/')) return 'revision_snapshots';
  if (JOURNAL_PATHS.includes(rel)) return 'journal';
  if (rel.startsWith('state/migrations/')) return 'migration_manifests';
  if (rel.startsWith('state/index/')) return 'search_index';
  if (rel.startsWith('state/models/')) return 'model_artifacts';
  if (rel.startsWith('state/')) return 'state';
  if (rel.startsWith('secrets/')) return 'secrets';
  if (rel === 'config/version.json') return 'version_manifest';
  if (rel.startsWith('config/')) return 'config';
  return 'state';
}

function rootFor(rel: string): LocalBackupRoot {
  if (rel.startsWith('vault/')) return 'vault';
  if (rel.startsWith('state/')) return 'state';
  if (rel.startsWith('secrets/')) return 'secrets';
  return 'config';
}

function filePathFor(rel: string): string {
  const separator = rel.indexOf('/');
  return separator < 0 ? rel : rel.slice(separator + 1);
}

function digestFor(files: readonly LocalBackupFile[]): LocalBackupDigest {
  const rows = files
    .map((file) => [file.root, file.path, file.sha256])
    .sort((left, right) => (left[1]! < right[1]! ? -1 : left[1]! > right[1]! ? 1 : 0));
  return { files: files.length, sha256: sha256(JSON.stringify(rows)) };
}

async function buildManifest(
  destination: string,
  input: {
    roots: LocalBackupRoots;
    scope: LocalBackupScope;
    sensitive: boolean;
    sensitive_categories: LocalBackupCategory[];
    reproducible_categories: LocalBackupCategory[];
    created_at: string;
  }
): Promise<LocalBackupManifest> {
  const walked = await walkFiles(destination);
  const files: LocalBackupFile[] = walked
    .filter((file) => file.path !== 'local-manifest.json')
    .map((file) => ({
      root: rootFor(file.path),
      path: filePathFor(file.path),
      category: categoryFor(file.path),
      size: file.size,
      sha256: file.sha256
    }));
  const digests: Partial<Record<LocalBackupCategory, LocalBackupDigest>> = {};
  const present: LocalBackupCategory[] = [];
  for (const category of new Set(files.map((file) => file.category))) {
    digests[category] = digestFor(files.filter((file) => file.category === category));
    present.push(category);
  }
  return {
    format_version: LOCAL_BACKUP_FORMAT_VERSION,
    created_at: input.created_at,
    application: APPLICATION_VERSION,
    schema: SCHEMA_VERSION,
    scope: input.scope,
    roots: input.roots,
    sensitive: input.sensitive,
    categories: present,
    sensitive_categories: [...input.sensitive_categories],
    reproducible_categories: [...input.reproducible_categories],
    digests,
    files
  };
}

export async function takeLocalBackup(
  options: TakeLocalBackupOptions
): Promise<TakeLocalBackupResult> {
  const vaultRoot = resolve(options.vault);
  const stateRoot = resolve(options.state);
  const destination = resolve(options.destination);
  const scope = options.scope ?? 'full';
  const clock = options.clock ?? { now: () => new Date() };
  const sensitive = scope === 'full' && (options.secrets?.length ?? 0) > 0;
  await assertSafeRoot(vaultRoot, 'vault root');
  await assertSafeRoot(stateRoot, 'state root');
  await assertEmptyOrAbsent(destination, 'backup destination');
  let lock: InstanceLock | undefined;
  if (options.allowWriters !== true) {
    lock = InstanceLock.acquire(stateRoot);
  }
  try {
    await mkdir(destination, { recursive: true, mode: 0o700 });

    await copyTree(vaultRoot, join(destination, 'vault'));

    if (scope === 'full') {
      await copyTree(join(stateRoot, 'history'), join(destination, 'state', 'history'));
      for (const name of ['journal.db', 'documents.sqlite', 'operations.sqlite']) {
        await snapshotSqliteDatabase(join(stateRoot, name), join(destination, 'state', name));
      }
      await copyTree(join(stateRoot, 'migrations'), join(destination, 'state', 'migrations'));
      if (options.includeSearchIndex === true) {
        await copyTree(join(stateRoot, 'index'), join(destination, 'state', 'index'));
      }
      if (options.includeModelArtifacts === true) {
        await copyTree(join(stateRoot, 'models'), join(destination, 'state', 'models'));
      }
      if (options.config !== undefined) {
        await copyTree(resolve(options.config), join(destination, 'config'));
      }
    }

    const versionPath = join(destination, 'config', 'version.json');
    await mkdir(dirname(versionPath), { recursive: true, mode: 0o700 });
    await writeFile(
      versionPath,
      `${JSON.stringify(
        {
          application: APPLICATION_VERSION,
          schema: SCHEMA_VERSION,
          format_version: LOCAL_BACKUP_FORMAT_VERSION,
          created_at: clock.now().toISOString()
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    if (scope === 'full' && sensitive) {
      for (const secret of options.secrets ?? []) {
        const absolute = resolve(secret);
        const info = await lstat(absolute);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw invalidInput(`secret ${absolute} must be a regular file`);
        }
        await copyTree(absolute, join(destination, 'secrets', absolute.split(sep).pop() as string));
      }
    }

    const manifest = await buildManifest(destination, {
      roots: {
        vault: join(destination, 'vault'),
        state: join(destination, 'state'),
        config: join(destination, 'config'),
        ...(sensitive ? { secrets: join(destination, 'secrets') } : {})
      },
      scope,
      sensitive,
      sensitive_categories: sensitive ? ['secrets'] : [],
      reproducible_categories: ['search_index', 'model_artifacts'],
      created_at: clock.now().toISOString()
    });
    const manifestPath = join(destination, 'local-manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { manifest, manifest_path: manifestPath, files: manifest.files.length, sensitive };
  } finally {
    lock?.release();
  }
}

export async function readLocalBackupManifest(path: string): Promise<LocalBackupManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw invalidInput(`local backup manifest cannot be read: ${path}`, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidInput(`local backup manifest is not valid JSON: ${path}`, error);
  }
  return assertLocalBackupManifest(parsed);
}

export function assertLocalBackupManifest(value: unknown): LocalBackupManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidInput('local backup manifest is not an object');
  }
  const manifest = value as LocalBackupManifest;
  if (manifest.format_version !== LOCAL_BACKUP_FORMAT_VERSION) {
    throw invalidInput(`unsupported local backup format version ${String(manifest.format_version)}`);
  }
  if (manifest.scope !== 'full' && manifest.scope !== 'vault-only') {
    throw invalidInput('local backup manifest has an unknown scope');
  }
  if (manifest.roots === null || typeof manifest.roots !== 'object' || typeof manifest.roots.vault !== 'string') {
    throw invalidInput('local backup manifest has no vault root');
  }
  if (typeof manifest.roots.state !== 'string') {
    throw invalidInput('local backup manifest has no state root');
  }
  if (!Array.isArray(manifest.files)) {
    throw invalidInput('local backup manifest has no file entries');
  }
  for (const [index, file] of manifest.files.entries()) {
    if (file === null || typeof file !== 'object') {
      throw invalidInput(`local backup manifest files[${index}] is not an object`);
    }
    if (file.root !== 'vault' && file.root !== 'state' && file.root !== 'config' && file.root !== 'secrets') {
      throw invalidInput(`local backup manifest files[${index}].root is not a known store`);
    }
    assertRelativeBackupEntry(file.path, `local backup manifest files[${index}].path`);
    if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
      throw invalidInput(`local backup manifest files[${index}].sha256 is not a sha256 digest`);
    }
  }
  return manifest;
}

function assertRelativeBackupEntry(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidInput(`${label} must be a non-empty relative path`);
  }
  if (value.includes('\0') || value.includes('\\')) {
    throw invalidInput(`${label} must not contain a null byte or backslash`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw invalidInput(`${label} must be relative to its store root`);
  }
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw invalidInput(`${label} must not contain empty or traversal segments`);
    }
  }
  return value;
}

function rootDirectory(
  file: LocalBackupFile,
  roots: Partial<LocalBackupRoots> | undefined,
  manifest: LocalBackupManifest
): string | undefined {
  const override = roots?.[file.root];
  if (override !== undefined) return override;
  return manifest.roots[file.root];
}

export async function verifyLocalBackup(
  manifestInput: LocalBackupManifest,
  roots?: Partial<LocalBackupRoots>
): Promise<LocalBackupVerification> {
  const manifest = assertLocalBackupManifest(manifestInput);
  const verified: LocalBackupFile[] = [];
  const missing: string[] = [];
  const failures: string[] = [];
  for (const file of manifest.files) {
    const base = rootDirectory(file, roots, manifest);
    if (base === undefined) {
      missing.push(file.path);
      continue;
    }
    const absolute = resolve(base, ...file.path.split('/'));
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (hasErrno(error, 'ENOENT')) {
        missing.push(file.path);
        continue;
      }
      throw recoveryRequired(`local backup entry ${file.path} cannot be inspected`, error);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      failures.push(file.path);
      continue;
    }
    const buffer = await readFile(absolute);
    if (buffer.byteLength !== file.size || sha256(buffer) !== file.sha256) {
      failures.push(file.path);
      continue;
    }
    verified.push(file);
  }

  const present: LocalBackupCategory[] = [];
  const complete: LocalBackupCategory[] = [];
  const incomplete: LocalBackupCategory[] = [];
  const digests = manifest.digests ?? {};
  const manifestCategories = new Set(manifest.files.map((file) => file.category));
  for (const category of manifestCategories) {
    const categoryFiles = verified.filter((file) => file.category === category);
    if (categoryFiles.length > 0) present.push(category);
    const expected = digests[category];
    const actual = digestFor(categoryFiles);
    if (
      expected !== undefined &&
      categoryFiles.length === expected.files &&
      actual.sha256 === expected.sha256
    ) {
      complete.push(category);
    } else {
      incomplete.push(category);
    }
  }

  let journalComplete = complete.includes('journal');
  if (journalComplete) {
    const stateRoot = roots?.state ?? manifest.roots.state;
    let database: Database.Database | undefined;
    try {
      database = new Database(join(stateRoot, 'journal.db'), { readonly: true });
      database.prepare('SELECT COUNT(*) AS count FROM projects_v2').get();
      database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get();
    } catch {
      journalComplete = false;
      const index = complete.indexOf('journal');
      if (index >= 0) complete.splice(index, 1);
      if (!incomplete.includes('journal')) incomplete.push('journal');
    } finally {
      database?.close();
    }
  }
  const vaultComplete = complete.includes('vault');
  const classification = classifyRecoveryInput({
    vault: vaultComplete,
    history: complete.includes('revision_snapshots'),
    journal: journalComplete,
    index: complete.includes('search_index')
  });
  const integrityOk = missing.length === 0 && failures.length === 0 && vaultComplete;
  const durableComplete =
    manifest.scope === 'vault-only'
      ? true
      : complete.includes('revision_snapshots') && complete.includes('journal');
  return {
    ok: integrityOk && durableComplete,
    integrity_ok: integrityOk,
    durable_complete: durableComplete,
    format_version: manifest.format_version,
    scope: manifest.scope,
    classification,
    sensitive: manifest.sensitive,
    present_categories: present,
    complete_categories: complete,
    incomplete_categories: incomplete,
    missing_files: missing,
    checksum_failures: failures,
    counts: { files: verified.length }
  };
}

function classificationFor(present: {
  history: boolean;
  journal: boolean;
  index: boolean;
}): RecoveryClassification {
  return classifyRecoveryInput({
    vault: true,
    history: present.history,
    journal: present.journal,
    index: present.index
  });
}

export async function restoreLocalBackup(
  options: RestoreLocalBackupOptions
): Promise<RestoreLocalBackupResult> {
  const backupRoot = resolve(options.backupRoot);
  const manifest = await readLocalBackupManifest(join(backupRoot, 'local-manifest.json'));
  if (manifest.scope !== 'full') {
    throw invalidInput('a vault-only backup requires importLocalVault, not a full restore');
  }
  const vaultTarget = resolve(options.vault);
  const stateTarget = resolve(options.state);
  await assertEmptyOrAbsent(vaultTarget, 'restore vault');
  await assertEmptyOrAbsent(stateTarget, 'restore state');
  const mediaRoots = {
    vault: join(backupRoot, 'vault'),
    state: join(backupRoot, 'state'),
    config: join(backupRoot, 'config'),
    secrets: join(backupRoot, 'secrets')
  };
  const verification = await verifyLocalBackup(manifest, mediaRoots);
  if (!verification.ok) {
    throw recoveryRequired(
      `the local backup failed verification: integrity ${verification.integrity_ok}, ` +
        `durable completeness ${verification.durable_complete}; ` +
        `${verification.missing_files.length} missing, ` +
        `${verification.checksum_failures.length} checksum failures`
    );
  }
  await mkdir(vaultTarget, { recursive: true, mode: 0o700 });
  await mkdir(stateTarget, { recursive: true, mode: 0o700 });
  await copyTree(mediaRoots.vault, vaultTarget);
  await copyTree(mediaRoots.state, stateTarget);
  const historyRecovered =
    verification.classification.history_recoverable && verification.complete_categories.includes('revision_snapshots');
  const receiptsRecovered = verification.classification.idempotency_recoverable;
  const warnings: string[] = [];
  if (!historyRecovered) warnings.push('historical snapshots are incomplete in this backup');
  if (!receiptsRecovered) warnings.push('operation receipts are incomplete in this backup');
  return {
    classification: classificationFor({
      history: historyRecovered,
      journal: receiptsRecovered,
      index: verification.complete_categories.includes('search_index')
    }),
    history_recovered: historyRecovered,
    receipts_recovered: receiptsRecovered,
    restored_files: verification.counts.files,
    warnings
  };
}

export async function importLocalVault(
  options: ImportLocalVaultOptions
): Promise<ImportLocalVaultResult> {
  const backupRoot = resolve(options.backupRoot);
  const manifest = await readLocalBackupManifest(join(backupRoot, 'local-manifest.json'));
  const vaultTarget = resolve(options.vault);
  await assertEmptyOrAbsent(vaultTarget, 'import vault');
  const vaultFiles = manifest.files.filter((file) => file.category === 'vault');
  if (vaultFiles.length === 0) throw invalidInput('this backup has no vault content to import');
  const vaultMedia = join(backupRoot, 'vault');
  for (const file of vaultFiles) {
    const absolute = resolve(vaultMedia, ...file.path.split('/'));
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      throw recoveryRequired(`vault entry ${file.path} is missing from the backup`, error);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw recoveryRequired(`vault entry ${file.path} is not a regular file`);
    }
    const buffer = await readFile(absolute);
    if (buffer.byteLength !== file.size || sha256(buffer) !== file.sha256) {
      throw recoveryRequired(`vault entry ${file.path} failed verification`);
    }
  }
  await mkdir(vaultTarget, { recursive: true, mode: 0o700 });
  await copyTree(vaultMedia, vaultTarget);
  return {
    classification: classifyRecoveryInput({ vault: true, history: false, journal: false, index: false }),
    imported_files: vaultFiles.length,
    warnings: [
      'vault-only import: historical snapshots are absent',
      'vault-only import: operation receipts are absent',
      'rebuild the search index or restore durable state separately'
    ]
  };
}

async function vaultHasManagedNotes(vault: string): Promise<boolean> {
  if (!existsSync(resolve(vault))) return false;
  const inventory = await scanVaultFilePaths(resolve(vault));
  return inventory.paths.some((path) => path.toLowerCase().endsWith('.md'));
}

function stagingPath(indexPath: string): string {
  return `${indexPath}.staging-${randomUUID()}`;
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function indexCounts(databasePath: string): Promise<LocalIndexCounts> {
  const database = new Database(databasePath, { readonly: true });
  try {
    const documents = database.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number };
    const chunks = database.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number };
    return { documents: documents.count, chunks: chunks.count };
  } finally {
    database.close();
  }
}

function indexFingerprint(identities: readonly { path: string; id: string | null; etag: string }[]): string {
  const rows = identities
    .map((entry) => [entry.path, entry.etag])
    .sort((left, right) => (left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0));
  return sha256(JSON.stringify(rows));
}

async function validateStagedIndex(
  vault: FileVault,
  index: SearchIndex,
  expectedDocuments: number
): Promise<{ identities: ReturnType<SearchIndex['identities']>; counts: LocalIndexCounts }> {
  const identities = index.identities();
  if (identities.length !== expectedDocuments) {
    throw recoveryRequired(
      `the staged index holds ${identities.length} documents but the vault has ${expectedDocuments}`
    );
  }
  const seen = new Set<string>();
  for (const entry of identities) {
    if (seen.has(entry.path)) throw recoveryRequired(`the staged index duplicates ${entry.path}`);
    seen.add(entry.path);
    const read = await vault.readMarkdown(entry.path);
    if (read.raw_hash !== entry.etag) {
      throw recoveryRequired(`the staged index diverges from the vault at ${entry.path}`);
    }
  }
  return { identities, counts: { documents: identities.length, chunks: 0 } };
}

export async function rebuildLocalIndex(
  options: RebuildLocalIndexOptions
): Promise<RebuildLocalIndexResult> {
  const state = resolve(options.state);
  const vault = resolve(options.vault);
  const clock = options.clock ?? { now: () => new Date() };
  const indexPath = join(state, 'index', 'search.sqlite');
  const metadataPath = join(state, 'index', 'search.meta.json');
  const liveExists = existsSync(indexPath);
  const empty: LocalIndexCounts = { documents: 0, chunks: 0 };
  const degraded = (reason: string): RebuildLocalIndexResult => ({
    status: 'degraded',
    reason,
    previous_index: liveExists ? indexPath : null,
    counts: empty
  });
  const durable = inspectDurableJournal(state);
  if (durable === 'damaged') {
    return degraded('the durable operation journal is unreadable; an index rebuild does not repair durable state');
  }
  if (durable === 'migration_required') {
    return degraded(
      'the durable operation journal schema is behind this release; run recover-state to migrate it explicitly instead of rebuilding the index'
    );
  }
  if (durable === 'backfill_required') {
    return degraded(
      'the durable operation journal needs approval-provenance recovery; run recover-state instead; an index rebuild does not repair durable state'
    );
  }
  if (durable === 'missing' && (await vaultHasManagedNotes(vault))) {
    return degraded(
      'the durable operation journal is missing; restore it from a backup instead of rebuilding the index'
    );
  }
  await mkdir(join(state, 'index'), { recursive: true, mode: 0o700 });
  const staging = stagingPath(indexPath);
  const vaultPort = new FileVault(vault, []);
  const catalogue = CurrentCatalogue.open({});
  let metadata: LocalIndexMetadata;
  try {
    const report = await reconcileCurrentVault({ vault: vaultPort, catalogue });
    if (!report.complete) throw recoveryRequired('the vault inventory was incomplete during the rebuild');
    const expectedDocuments = report.added.length;
    if (expectedDocuments === 0 && (await vaultHasManagedNotes(vault))) {
      throw recoveryRequired('the rebuild scanned no documents while managed notes exist');
    }
    const index = openSearchIndex(staging);
    let validatedDocuments = 0;
    let fingerprint = '';
    let counts: LocalIndexCounts = { documents: 0, chunks: 0 };
    try {
      indexReconciledDocuments({ catalogue, index, report });
      const validated = await validateStagedIndex(vaultPort, index, expectedDocuments);
      fingerprint = indexFingerprint(validated.identities);
      counts = await indexCounts(staging);
      validatedDocuments = validated.identities.length;
      await options.faults?.validate?.();
    } finally {
      index.close();
    }
    const reopened = openSearchIndex(staging);
    try {
      if (reopened.identities().length !== validatedDocuments) {
        throw recoveryRequired('the staged index changed after it was validated');
      }
    } finally {
      reopened.close();
    }
    metadata = {
      schema: LOCAL_INDEX_SCHEMA_VERSION,
      fingerprint,
      documents: counts.documents,
      chunks: counts.chunks,
      created_at: clock.now().toISOString()
    };
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    return degraded(errorMessage(error));
  }
  const previousPath = liveExists ? `${indexPath}.previous-${randomUUID()}` : undefined;
  let previousMoved = false;
  try {
    await options.faults?.publish?.();
    await options.closePrevious?.();
    if (previousPath !== undefined) {
      await rename(indexPath, previousPath);
      previousMoved = true;
    }
    await rename(staging, indexPath);
    await writeFileAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    if (previousMoved && previousPath !== undefined) {
      await rm(indexPath, { force: true }).catch(() => undefined);
      await rename(previousPath, indexPath).catch(() => undefined);
    }
    return degraded(errorMessage(error));
  }
  if (previousPath !== undefined) await rm(previousPath, { force: true }).catch(() => undefined);
  return {
    status: 'rebuilt',
    index_path: indexPath,
    metadata_path: metadataPath,
    counts: metadata,
    fingerprint: metadata.fingerprint
  };
}
