import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, readFile, rename, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { BrainError, isBrainError } from '../../contracts/errors.js';
import { DEFAULT_TYPE_FOR_KIND, type CurrentDocument } from '../../notes/document.js';
import { renderDocument, renderNoteBody } from '../../notes/document-codec.js';
import { decodeRevision } from '../../notes/codec.js';
import { resolveHead } from '../../notes/catalogue.js';
import { extractLinks, isExternalTarget, type LinkReference } from '../../notes/links.js';
import { resolveLink, type LinkCatalogue } from '../../notes/link-resolver.js';
import { allocateNotePath, allocateProjectRoot, collisionKey } from '../../notes/paths.js';
import { KIND_FOLDERS } from '../../notes/registry.js';
import { hasBrainMarker, readBoundedBytes } from '../../storage/vault.js';
import { revisionLocation } from '../../storage/revision-store.js';
import { buildManifest, validateManifest, type BackupManifest, type ManifestFile } from '../backup.js';
import type { Lifecycle, NoteKind, StoredRevision } from '../../core/types.js';
import type { InventoryRow } from './inventory.js';
import { inventoryTree } from './inventory.js';

export const MIGRATION_MANIFEST_VERSION = 1;
export const MIGRATION_JOURNAL_VERSION = 1;
export const MIGRATION_DIRECTORY = 'migrations';
export const MAX_MIGRATION_FILE_BYTES = 64 * 1024 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCKED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'id',
  'brain_schema_version',
  'type',
  'status',
  'project',
  'aliases',
  'tags',
  'created',
  'updated'
]);
const DISPOSABLE_STATE_PREFIXES = ['index/', 'models/', 'evaluations/', `${MIGRATION_DIRECTORY}/`];

export interface SourceFileFingerprint {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SourceFingerprint {
  vault_root: string;
  state_root: string;
  vault: SourceFileFingerprint[];
  state: SourceFileFingerprint[];
  sha256: string;
}

export type MigrationBlockerKind =
  | 'fork'
  | 'duplicate_revision_id'
  | 'duplicate_logical_id'
  | 'malformed'
  | 'unknown_schema'
  | 'unmappable_project'
  | 'unsafe_target'
  | 'occupied_target';

export interface MigrationBlocker {
  kind: MigrationBlockerKind;
  reason: string;
  path?: string;
  id?: string;
  revision_id?: string;
  scope?: string;
  paths?: string[];
}

export interface MigrationHistoryCopy {
  logical_id: string;
  revision_id: string;
  source_path: string;
  source_sha256: string;
  destination_path: string;
  legacy_status: Lifecycle;
  approved: boolean;
}

export interface MigrationMove {
  logical_id: string;
  scope: string;
  title: string;
  kind: NoteKind;
  status: Lifecycle;
  project_root?: string;
  head_revision_id: string;
  head_source_path: string;
  head_source_sha256: string;
  parents: { revision_id: string; raw_hash: string }[];
  legacy_source_paths: string[];
  current_path: string;
  current_raw: string;
  current_sha256: string;
  history_destinations: { revision_id: string; destination_path: string }[];
  approval_preserved: boolean;
}

export interface MigrationRewrite {
  path: string;
  expected_sha256: string;
  preimage_raw: string;
  new_raw: string;
  new_sha256: string;
  edits: number;
  targets: { from: string; to: string }[];
}

export interface MigrationManifest {
  version: number;
  created_at: string;
  vault_root: string;
  state_root: string;
  project_names: Record<string, string>;
  source_fingerprint: SourceFingerprint;
  moves: MigrationMove[];
  history_copies: MigrationHistoryCopy[];
  rewrites: MigrationRewrite[];
  blockers: MigrationBlocker[];
  preserved_files: SourceFileFingerprint[];
  baseline_dangling_links: { path: string; target: string }[];
  manifest_sha256: string;
}

export type MigrationPhase = 'history' | 'materialize' | 'remove_sources' | 'rewrites' | 'verify' | 'complete';

export const MIGRATION_PHASES: readonly MigrationPhase[] = [
  'history',
  'materialize',
  'remove_sources',
  'rewrites',
  'verify',
  'complete'
];

export interface MigrationPhaseRecord {
  status: 'pending' | 'complete';
  updated_at: string;
  artifacts: { path: string; sha256: string }[];
}

export interface MigrationJournal {
  version: number;
  migration_id: string;
  manifest_sha256: string;
  state: 'running' | 'complete' | 'rolled_back';
  created_at: string;
  updated_at: string;
  phases: Record<MigrationPhase, MigrationPhaseRecord>;
}

export interface MigrationFaults {
  afterPhase?(phase: MigrationPhase): void | Promise<void>;
}

export interface PlanVaultMigrationInput {
  vault: string;
  state: string;
  projectNames: Record<string, string>;
  outputDirectory?: string;
  clock?: { now(): Date };
}

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function conflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function notFound(message: string): BrainError {
  return new BrainError({ code: 'NOT_FOUND', message });
}

function hasErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
  );
}

function wrapIo(message: string, error: unknown): BrainError {
  return isBrainError(error) ? error : recoveryRequired(message, error);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function manifestDigest(manifest: MigrationManifest): string {
  const { manifest_sha256: _ignored, created_at: _created, ...rest } = manifest;
  return sha256(canonicalJson(rest));
}

function isInsideOrEqual(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

export function vaultAbsolutePath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw invalidInput('a vault-relative path is required');
  }
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !isInsideOrEqual(base, target)) {
    throw invalidInput(`path escapes the vault root: ${relativePath}`);
  }
  return target;
}

export function stateAbsolutePath(state: string, relativePath: string): string {
  return vaultAbsolutePath(state, relativePath);
}

export async function readBytesAt(root: string, relativePath: string, maxBytes = MAX_MIGRATION_FILE_BYTES): Promise<Buffer> {
  const absolute = vaultAbsolutePath(root, relativePath);
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) throw notFound(`file ${relativePath} does not exist`);
    throw recoveryRequired(`file ${relativePath} cannot be opened`, error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw recoveryRequired(`file ${relativePath} is not a regular file`);
    if (info.size > maxBytes) throw invalidInput(`file ${relativePath} exceeds the migration size limit`);
    const bounded = await readBoundedBytes(handle, maxBytes);
    if (bounded.kind === 'overflow') {
      throw invalidInput(`file ${relativePath} exceeds the migration size limit`);
    }
    return bounded.buffer;
  } finally {
    await handle.close();
  }
}

export async function hashFileAt(absolute: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(absolute);
    return sha256(buffer);
  } catch {
    return undefined;
  }
}

export async function ensureParentDirectory(absolute: string): Promise<void> {
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
}

export async function writeNewFileNoClobber(absolute: string, bytes: Buffer | string): Promise<void> {
  await ensureParentDirectory(absolute);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, 'wx', 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    return;
  } catch (error) {
    if (!hasErrno(error, 'EEXIST')) throw wrapIo(`file ${absolute} cannot be created`, error);
  } finally {
    if (handle !== undefined) await handle.close();
  }
  const existing = await readFile(absolute).catch(() => undefined);
  if (existing === undefined || !Buffer.from(existing).equals(buffer)) {
    throw conflict(`target ${absolute} is occupied by different bytes`);
  }
}

export async function replaceFileAtomic(absolute: string, bytes: Buffer | string): Promise<void> {
  await ensureParentDirectory(absolute);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  const temp = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.${sha256(String(Math.random()))}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
  } catch (error) {
    throw wrapIo(`temporary file for ${absolute} cannot be written`, error);
  } finally {
    if (handle !== undefined) await handle.close();
  }
  try {
    await rename(temp, absolute);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw wrapIo(`file ${absolute} cannot be replaced`, error);
  }
}

export async function removeFileIfMatches(absolute: string, expectedSha256: string): Promise<'removed' | 'missing' | 'changed'> {
  const current = await hashFileAt(absolute);
  if (current === undefined) return 'missing';
  if (current !== expectedSha256) return 'changed';
  await rm(absolute);
  return 'removed';
}

export async function availableBytes(path: string): Promise<number> {
  try {
    const stats = await statfs(path);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch (error) {
    throw recoveryRequired(`free space at ${path} cannot be determined`, error);
  }
}

function toFingerprint(row: InventoryRow): SourceFileFingerprint {
  return { path: row.path, bytes: row.bytes, sha256: row.sha256 };
}

function isExcludedStatePath(stateRoot: string, relativePath: string, excluded: ReadonlySet<string>): boolean {
  const absolute = resolve(stateRoot, relativePath);
  for (const entry of excluded) {
    if (isInsideOrEqual(entry, absolute)) return true;
  }
  for (const prefix of DISPOSABLE_STATE_PREFIXES) {
    if (relativePath.startsWith(prefix)) return true;
  }
  if (relativePath.endsWith('-wal') || relativePath.endsWith('-shm')) return true;
  if (relativePath.endsWith('.lock')) return true;
  return false;
}

export async function fingerprintSource(input: {
  vault: string;
  state: string;
  outputDirectory?: string;
}): Promise<SourceFingerprint> {
  const vaultRoot = resolve(input.vault);
  const stateRoot = resolve(input.state);
  for (const root of [vaultRoot, stateRoot]) {
    const info = await lstat(root).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
      throw recoveryRequired(`root ${root} is not a safe directory`);
    }
  }
  if (isInsideOrEqual(vaultRoot, stateRoot) || isInsideOrEqual(stateRoot, vaultRoot)) {
    throw invalidInput('the vault and state roots must not overlap');
  }
  const vaultRows = await inventoryTree(vaultRoot);
  const stateRows = await inventoryTree(stateRoot);
  const excluded = new Set<string>([resolve(stateRoot, MIGRATION_DIRECTORY)]);
  if (input.outputDirectory !== undefined && input.outputDirectory.length > 0) {
    excluded.add(resolve(input.outputDirectory));
  }
  const stateFiles = stateRows
    .filter((row) => !isExcludedStatePath(stateRoot, row.path, excluded))
    .map(toFingerprint);
  const vault = vaultRows.map(toFingerprint);
  const sha = sha256(canonicalJson({ vault, state: stateFiles }));
  return { vault_root: vaultRoot, state_root: stateRoot, vault, state: stateFiles, sha256: sha };
}

export async function readVaultTextFiles(root: string, rows: readonly SourceFileFingerprint[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const row of rows) {
    if (!row.path.toLowerCase().endsWith('.md')) continue;
    let buffer: Buffer;
    try {
      buffer = await readBytesAt(root, row.path);
    } catch {
      continue;
    }
    const raw = buffer.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(buffer)) continue;
    texts.set(row.path, raw);
  }
  return texts;
}

export function migrationOutputDirectory(state: string): string {
  return join(resolve(state), MIGRATION_DIRECTORY);
}

export function journalDirectory(state: string, migrationId: string): string {
  return join(migrationOutputDirectory(state), migrationId);
}

export function journalPath(state: string, migrationId: string): string {
  return join(journalDirectory(state, migrationId), 'journal.json');
}

export function newJournal(manifest: MigrationManifest, now: string): MigrationJournal {
  const phases = {} as Record<MigrationPhase, MigrationPhaseRecord>;
  for (const phase of MIGRATION_PHASES) {
    phases[phase] = { status: 'pending', updated_at: now, artifacts: [] };
  }
  return {
    version: MIGRATION_JOURNAL_VERSION,
    migration_id: manifest.manifest_sha256,
    manifest_sha256: manifest.manifest_sha256,
    state: 'running',
    created_at: now,
    updated_at: now,
    phases
  };
}

export async function readJournal(state: string, migrationId: string): Promise<MigrationJournal | undefined> {
  let raw: string;
  try {
    raw = await readFile(journalPath(state, migrationId), 'utf8');
  } catch (error) {
    if (hasErrno(error, 'ENOENT')) return undefined;
    throw recoveryRequired('the migration journal cannot be read', error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw recoveryRequired('the migration journal is not valid JSON', error);
  }
  return assertJournal(parsed);
}

export function assertJournal(value: unknown): MigrationJournal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw recoveryRequired('the migration journal is malformed');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== MIGRATION_JOURNAL_VERSION) {
    throw recoveryRequired('the migration journal has an unsupported version');
  }
  if (typeof record.migration_id !== 'string' || typeof record.manifest_sha256 !== 'string') {
    throw recoveryRequired('the migration journal is missing its identifiers');
  }
  if (record.state !== 'running' && record.state !== 'complete' && record.state !== 'rolled_back') {
    throw recoveryRequired('the migration journal has an unknown state');
  }
  if (record.phases === null || typeof record.phases !== 'object') {
    throw recoveryRequired('the migration journal has no phase records');
  }
  const phases = record.phases as Record<string, unknown>;
  const normalized = {} as Record<MigrationPhase, MigrationPhaseRecord>;
  for (const phase of MIGRATION_PHASES) {
    const entry = phases[phase];
    if (entry === null || typeof entry !== 'object') {
      throw recoveryRequired(`the migration journal is missing the ${phase} phase`);
    }
    const phaseRecord = entry as Record<string, unknown>;
    if (phaseRecord.status !== 'pending' && phaseRecord.status !== 'complete') {
      throw recoveryRequired(`the migration journal has an invalid ${phase} phase status`);
    }
    if (!Array.isArray(phaseRecord.artifacts)) {
      throw recoveryRequired(`the migration journal has invalid ${phase} artifacts`);
    }
    normalized[phase] = {
      status: phaseRecord.status,
      updated_at: typeof phaseRecord.updated_at === 'string' ? phaseRecord.updated_at : '',
      artifacts: phaseRecord.artifacts.map((artifact) => {
        const item = artifact as { path?: unknown; sha256?: unknown };
        if (typeof item?.path !== 'string' || typeof item?.sha256 !== 'string') {
          throw recoveryRequired(`the migration journal has a malformed ${phase} artifact`);
        }
        return { path: item.path, sha256: item.sha256 };
      })
    };
  }
  return {
    version: MIGRATION_JOURNAL_VERSION,
    migration_id: record.migration_id,
    manifest_sha256: record.manifest_sha256,
    state: record.state,
    created_at: typeof record.created_at === 'string' ? record.created_at : '',
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : '',
    phases: normalized
  };
}

export async function writeJournal(state: string, journal: MigrationJournal): Promise<void> {
  const directory = journalDirectory(state, journal.migration_id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await replaceFileAtomic(join(directory, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
}

export async function markPhase(
  state: string,
  journal: MigrationJournal,
  phase: MigrationPhase,
  artifacts: { path: string; sha256: string }[],
  now: string,
  faults: MigrationFaults
): Promise<MigrationJournal> {
  journal.phases[phase] = { status: 'complete', updated_at: now, artifacts };
  journal.updated_at = now;
  await writeJournal(state, journal);
  await faults.afterPhase?.(phase);
  return journal;
}

export function buildMigrationBackupReceipt(fingerprint: SourceFingerprint): BackupManifest {
  const files: ManifestFile[] = [
    ...fingerprint.vault.map((file) => ({
      path: `vault/${file.path}`,
      size: file.bytes,
      sha256: file.sha256
    })),
    ...fingerprint.state.map((file) => ({
      path: `state/${file.path}`,
      size: file.bytes,
      sha256: file.sha256
    }))
  ];
  return buildManifest(files, {
    application: 'second-brain',
    schema: 1,
    images: {},
    created_at: new Date(0).toISOString()
  });
}

export function verifyMigrationBackupReceipt(receipt: unknown, fingerprint: SourceFingerprint): void {
  const validated = validateManifest(receipt);
  const expected = new Map(
    buildMigrationBackupReceipt(fingerprint).files.map((file) => [file.path, file.sha256])
  );
  if (validated.files.length === 0) {
    throw invalidInput('the migration backup receipt is empty');
  }
  for (const file of validated.files) {
    const wanted = expected.get(file.path);
    if (wanted === undefined) {
      throw conflict(`the migration backup receipt names an unexpected file: ${file.path}`);
    }
    if (wanted !== file.sha256) {
      throw conflict(`the migration backup receipt does not match the source for ${file.path}`);
    }
  }
  if (validated.files.length !== expected.size) {
    throw conflict('the migration backup receipt is missing source files');
  }
}

interface ParsedManagedFile {
  path: string;
  sha256: string;
  revision: StoredRevision;
}

function blocker(kind: MigrationBlockerKind, reason: string, extra: Partial<MigrationBlocker> = {}): MigrationBlocker {
  return { kind, reason, ...extra };
}

function projectProperty(projectRoot: string): string {
  const leaf = projectRoot.slice(projectRoot.lastIndexOf('/') + 1);
  return `[[${projectRoot}/${leaf}]]`;
}

function cleanProperties(revision: StoredRevision): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(revision.extra_frontmatter)) {
    if (BLOCKED_FRONTMATTER_KEYS.has(key)) continue;
    properties[key] = value;
  }
  return properties;
}

export function buildCurrentDocument(
  revision: StoredRevision,
  currentPath: string,
  projectRoot: string | undefined
): CurrentDocument {
  const kind = revision.note.content.kind;
  const extras = revision.extra_markdown.trim().length > 0 ? { human: [revision.extra_markdown] } : {};
  return {
    id: revision.id,
    path: currentPath,
    title: revision.note.title,
    type: DEFAULT_TYPE_FOR_KIND[kind],
    status: revision.status,
    ...(projectRoot === undefined ? {} : { project: projectProperty(projectRoot) }),
    aliases: [],
    tags: [...revision.note.tags],
    created: revision.created_at,
    updated: revision.modified_at,
    properties: cleanProperties(revision),
    body: renderNoteBody(revision.note, extras)
  };
}

function stripNoteExtension(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path;
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function relativeLinkPath(fromPath: string, toPath: string): string {
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const fromParts = fromDir.length === 0 ? [] : fromDir.split('/');
  const toParts = toPath.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const up = fromParts.length - common;
  const segments = [...Array<string>(up).fill('..'), ...toParts.slice(common)];
  const joined = segments.join('/');
  return joined.startsWith('.') ? joined : `./${joined}`;
}

function boundaryIndex(inner: string): number {
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '#' || character === '|') return index;
  }
  return inner.length;
}

export function replaceReferenceTarget(span: string, reference: LinkReference, newTarget: string): string {
  if (reference.syntax === 'wikilink') {
    const open = span.indexOf('[[');
    if (open === -1) return span;
    const innerStart = open + 2;
    const innerEnd = span.endsWith(']]') ? span.length - 2 : span.length;
    const inner = span.slice(innerStart, innerEnd);
    const boundary = boundaryIndex(inner);
    return span.slice(0, innerStart) + newTarget + inner.slice(boundary) + span.slice(innerEnd);
  }
  const marker = span.indexOf('](');
  if (marker === -1) return span;
  const start = marker + 2;
  const end = span.indexOf(')', start);
  if (end === -1) return span;
  const url = newTarget + (reference.fragment === undefined ? '' : `#${reference.fragment}`);
  return span.slice(0, start) + url + span.slice(end);
}

function referenceTargetText(reference: LinkReference, resolvedPath: string, postPath: string): string {
  if (reference.syntax === 'wikilink') {
    if (reference.target.startsWith('.')) {
      return stripNoteExtension(relativeLinkPath(postPath, resolvedPath));
    }
    if (reference.target.startsWith('/')) return `/${resolvedPath}`;
    return stripNoteExtension(resolvedPath);
  }
  if (reference.target.startsWith('/')) return `/${encodePath(resolvedPath)}`;
  return encodePath(relativeLinkPath(postPath, resolvedPath));
}

interface RewriteOutcome {
  raw: string;
  edits: number;
  status: 'ok' | 'ambiguous';
  targets: { from: string; to: string }[];
}

export function rewriteFileLinks(input: {
  raw: string;
  sourcePath: string;
  postPath: string;
  catalogue: LinkCatalogue;
  oldToNew: ReadonlyMap<string, string>;
}): RewriteOutcome {
  const replacements: { start: number; end: number; text: string }[] = [];
  const targets: { from: string; to: string }[] = [];
  let ambiguous = false;
  for (const reference of extractLinks(input.raw)) {
    if (isExternalTarget(reference.target)) continue;
    const before = resolveLink(reference, input.sourcePath, input.catalogue);
    if (before.state === 'ambiguous') {
      ambiguous = true;
      continue;
    }
    if (before.state !== 'resolved') continue;
    const mapped = input.oldToNew.get(before.path) ?? before.path;
    const sourceMoved = input.postPath !== input.sourcePath;
    const relativeSyntax =
      reference.syntax === 'wikilink'
        ? reference.target.startsWith('.')
        : !reference.target.startsWith('/');
    const relocate = mapped !== before.path || (sourceMoved && relativeSyntax);
    if (!relocate) continue;
    const span = input.raw.slice(reference.start, reference.end);
    const text = replaceReferenceTarget(span, reference, referenceTargetText(reference, mapped, input.postPath));
    if (text !== span) {
      replacements.push({ start: reference.start, end: reference.end, text });
      targets.push({ from: before.path, to: mapped });
    }
  }
  if (replacements.length === 0) {
    return { raw: input.raw, edits: 0, status: ambiguous ? 'ambiguous' : 'ok', targets: [] };
  }
  const ordered = [...replacements].sort((left, right) => right.start - left.start || right.end - left.end);
  let output = input.raw;
  for (const replacement of ordered) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  return {
    raw: output,
    edits: replacements.length,
    status: ambiguous ? 'ambiguous' : 'ok',
    targets
  };
}

export function collectDanglingLinks(
  files: ReadonlyArray<{ path: string; raw: string }>,
  catalogue: LinkCatalogue
): { path: string; target: string }[] {
  const found: { path: string; target: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('.md')) continue;
    for (const reference of extractLinks(file.raw)) {
      if (isExternalTarget(reference.target)) continue;
      const outcome = resolveLink(reference, file.path, catalogue);
      if (outcome.state === 'resolved') continue;
      const key = `${file.path}\u0000${outcome.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ path: file.path, target: outcome.target });
    }
  }
  return found;
}

function editableMigrationFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.canvas') || lower.endsWith('.base');
}

function historyDestination(stateRoot: string, id: string, revisionId: string): string {
  return relative(stateRoot, revisionLocation(stateRoot, id, revisionId)).split(sep).join('/');
}

export function newIndexCatalogue(
  parsed: readonly ParsedManagedFile[],
  headPaths: ReadonlyMap<string, string>,
  otherPaths: readonly string[]
): LinkCatalogue {
  const catalogue = new Map<string, string | undefined>();
  const heads = new Set(headPaths.values());
  for (const item of parsed) {
    catalogue.set(item.path, heads.has(item.path) ? item.revision.id : undefined);
  }
  for (const path of otherPaths) {
    if (!catalogue.has(path)) catalogue.set(path, undefined);
  }
  return catalogue;
}

export async function planVaultMigration(input: PlanVaultMigrationInput): Promise<MigrationManifest> {
  if (input === null || typeof input !== 'object') throw invalidInput('a migration plan requires an input object');
  if (typeof input.vault !== 'string' || input.vault.length === 0) throw invalidInput('a vault root is required');
  if (typeof input.state !== 'string' || input.state.length === 0) throw invalidInput('a state root is required');
  const projectNames = input.projectNames ?? {};
  const now = (input.clock ?? { now: () => new Date() }).now().toISOString();
  const vaultRoot = resolve(input.vault);
  const stateRoot = resolve(input.state);
  const fingerprint = await fingerprintSource({
    vault: vaultRoot,
    state: stateRoot,
    ...(input.outputDirectory === undefined ? {} : { outputDirectory: input.outputDirectory })
  });
  const texts = await readVaultTextFiles(vaultRoot, fingerprint.vault);

  const blockers: MigrationBlocker[] = [];
  const parsed: ParsedManagedFile[] = [];
  const blockedPaths = new Set<string>();
  const managedRows = fingerprint.vault.filter(
    (row) => row.path.toLowerCase().endsWith('.md') && hasBrainMarker(texts.get(row.path) ?? '')
  );
  for (const row of managedRows) {
    const raw = texts.get(row.path);
    if (raw === undefined) {
      blockers.push(blocker('malformed', 'managed note is not valid UTF-8', { path: row.path }));
      blockedPaths.add(row.path);
      continue;
    }
    try {
      const revision = decodeRevision(raw);
      if (!UUID_PATTERN.test(revision.id) || !UUID_PATTERN.test(revision.revision_id)) {
        throw invalidInput('managed note identifiers are not UUIDs');
      }
      parsed.push({ path: row.path, sha256: row.sha256, revision });
    } catch (error) {
      const code = isBrainError(error) ? error.code : 'INVALID_INPUT';
      const kind: MigrationBlockerKind = code === 'UNSUPPORTED_SCHEMA' ? 'unknown_schema' : 'malformed';
      blockers.push(blocker(kind, code === 'UNSUPPORTED_SCHEMA' ? 'unsupported schema version' : 'malformed managed note', { path: row.path }));
      blockedPaths.add(row.path);
    }
  }

  const revisionCounts = new Map<string, number>();
  for (const item of parsed) {
    revisionCounts.set(item.revision.revision_id, (revisionCounts.get(item.revision.revision_id) ?? 0) + 1);
  }

  const groups = new Map<string, ParsedManagedFile[]>();
  for (const item of parsed) {
    const group = groups.get(item.revision.id) ?? [];
    group.push(item);
    groups.set(item.revision.id, group);
  }

  for (const [id, group] of groups) {
    for (const item of group) {
      if ((revisionCounts.get(item.revision.revision_id) ?? 0) > 1) {
        blockers.push(
          blocker('duplicate_revision_id', 'revision identity is duplicated', {
            id,
            revision_id: item.revision.revision_id,
            path: item.path
          })
        );
        blockedPaths.add(item.path);
      }
    }
  }

  const headPaths = new Map<string, string>();
  const candidates: { id: string; group: ParsedManagedFile[]; head: ParsedManagedFile }[] = [];
  for (const [id, group] of [...groups.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    const resolution = resolveHead(
      group.map((item) => ({ revision: item.revision, raw_hash: item.sha256, relative_path: item.path }))
    );
    const duplicate = group.some((item) => (revisionCounts.get(item.revision.revision_id) ?? 0) > 1);
    if (resolution.state !== 'ready' || duplicate) {
      const reasons = resolution.state === 'conflict' ? resolution.reasons : ['duplicate_revision_id'];
      blockers.push(
        blocker('fork', `note ${id} has no unique valid head (${reasons.join(', ')})`, {
          id,
          paths: group.map((item) => item.path)
        })
      );
      for (const item of group) blockedPaths.add(item.path);
      continue;
    }
    const head = group.find(
      (item) => item.revision.revision_id === resolution.head.revision.revision_id
    );
    if (head === undefined) {
      blockers.push(blocker('fork', `note ${id} has no matching head file`, { id }));
      for (const item of group) blockedPaths.add(item.path);
      continue;
    }
    headPaths.set(id, head.path);
    candidates.push({ id, group, head });
  }

  const scopes = [...new Set(candidates.map((candidate) => candidate.head.revision.scope))].sort();
  const projectRoots = new Map<string, string>();
  const occupiedRoots: string[] = [];
  for (const scope of scopes) {
    const display = projectNames[scope];
    if (display === undefined) continue;
    try {
      const root = allocateProjectRoot(display, occupiedRoots);
      projectRoots.set(scope, root);
      occupiedRoots.push(root);
    } catch {
      blockers.push(blocker('unmappable_project', `project display name for ${scope} is unusable`, { scope }));
    }
  }

  const migratable: { id: string; group: ParsedManagedFile[]; head: ParsedManagedFile }[] = [];
  for (const candidate of candidates) {
    const scope = candidate.head.revision.scope;
    if (!projectRoots.has(scope)) {
      blockers.push(
        blocker('unmappable_project', `no project display name is configured for scope ${scope}`, {
          id: candidate.id,
          scope
        })
      );
      for (const item of candidate.group) blockedPaths.add(item.path);
      continue;
    }
    migratable.push(candidate);
  }

  const legacyPaths = new Set(migratable.flatMap((candidate) => candidate.group.map((item) => item.path)));
  const occupied = new Set(fingerprint.vault.filter((row) => !legacyPaths.has(row.path)).map((row) => collisionKey(row.path)));
  const moves: MigrationMove[] = [];
  const historyCopies: MigrationHistoryCopy[] = [];
  const oldToNew = new Map<string, string>();
  const allocated: { candidate: (typeof migratable)[number]; currentPath: string }[] = [];
  for (const candidate of [...migratable].sort((left, right) => (left.id < right.id ? -1 : 1))) {
    const head = candidate.head.revision;
    const root = projectRoots.get(head.scope) as string;
    const directory = `${root}/${KIND_FOLDERS[head.note.content.kind]}`;
    let currentPath: string;
    try {
      currentPath = allocateNotePath({ directory, title: head.note.title, occupied: [...occupied] });
    } catch (error) {
      blockers.push(
        blocker('unsafe_target', `a readable path could not be allocated for ${candidate.id}`, {
          id: candidate.id,
          scope: head.scope
        })
      );
      continue;
    }
    occupied.add(collisionKey(currentPath));
    allocated.push({ candidate, currentPath });
    for (const item of candidate.group) oldToNew.set(item.path, currentPath);
  }

  const managedPathSet = new Set(managedRows.map((row) => row.path));
  const otherPaths = fingerprint.vault.filter((row) => !managedPathSet.has(row.path)).map((row) => row.path);
  const catalogue = newIndexCatalogue(parsed, headPaths, otherPaths);
  const rewritten = new Map<string, string>();

  for (const { candidate, currentPath } of allocated) {
    const head = candidate.head.revision;
    const document = buildCurrentDocument(head, currentPath, projectRoots.get(head.scope));
    const outcome = rewriteFileLinks({
      raw: renderDocument(document),
      sourcePath: candidate.head.path,
      postPath: currentPath,
      catalogue,
      oldToNew
    });
    rewritten.set(candidate.id, outcome.raw);
  }

  for (const { candidate, currentPath } of allocated) {
    const head = candidate.head.revision;
    const raw = rewritten.get(candidate.id) as string;
    moves.push({
      logical_id: candidate.id,
      scope: head.scope,
      title: head.note.title,
      kind: head.note.content.kind,
      status: head.status,
      ...(projectRoots.get(head.scope) === undefined ? {} : { project_root: projectRoots.get(head.scope) as string }),
      head_revision_id: candidate.head.revision.revision_id,
      head_source_path: candidate.head.path,
      head_source_sha256: candidate.head.sha256,
      parents: head.parents.map((parent) => ({ ...parent })),
      legacy_source_paths: candidate.group.map((item) => item.path).sort(),
      current_path: currentPath,
      current_raw: raw,
      current_sha256: sha256(raw),
      history_destinations: [],
      approval_preserved: head.approval !== undefined
    });
    for (const item of candidate.group) {
      const destination = historyDestination(stateRoot, item.revision.id, item.revision.revision_id);
      historyCopies.push({
        logical_id: item.revision.id,
        revision_id: item.revision.revision_id,
        source_path: item.path,
        source_sha256: item.sha256,
        destination_path: destination,
        legacy_status: item.revision.status,
        approved: item.revision.approval !== undefined
      });
    }
    const move = moves[moves.length - 1];
    move.history_destinations = candidate.group
      .map((item) => ({
        revision_id: item.revision.revision_id,
        destination_path: historyDestination(stateRoot, item.revision.id, item.revision.revision_id)
      }))
      .sort((left, right) => (left.revision_id < right.revision_id ? -1 : 1));
  }

  const rewrites: MigrationRewrite[] = [];
  for (const row of fingerprint.vault) {
    if (legacyPaths.has(row.path)) continue;
    if (blockedPaths.has(row.path)) continue;
    if (!editableMigrationFile(row.path)) continue;
    const raw = texts.get(row.path);
    if (raw === undefined) continue;
    const outcome = rewriteFileLinks({
      raw,
      sourcePath: row.path,
      postPath: row.path,
      catalogue,
      oldToNew
    });
    if (outcome.edits === 0) continue;
    rewrites.push({
      path: row.path,
      expected_sha256: row.sha256,
      preimage_raw: raw,
      new_raw: outcome.raw,
      new_sha256: sha256(outcome.raw),
      edits: outcome.edits,
      targets: outcome.targets
    });
  }

  const baselineFiles = fingerprint.vault
    .filter((row) => texts.has(row.path))
    .map((row) => ({ path: row.path, raw: texts.get(row.path) as string }));
  const baselineDangling = collectDanglingLinks(baselineFiles, catalogue);
  const preservedFiles = fingerprint.vault.filter((row) => !legacyPaths.has(row.path));

  const manifest: MigrationManifest = {
    version: MIGRATION_MANIFEST_VERSION,
    created_at: now,
    vault_root: vaultRoot,
    state_root: stateRoot,
    project_names: { ...projectNames },
    source_fingerprint: fingerprint,
    moves,
    history_copies: historyCopies.sort((left, right) =>
      left.logical_id < right.logical_id ? -1 : left.logical_id > right.logical_id ? 1 : left.revision_id < right.revision_id ? -1 : 1
    ),
    rewrites: rewrites.sort((left, right) => (left.path < right.path ? -1 : 1)),
    blockers,
    preserved_files: preservedFiles,
    baseline_dangling_links: baselineDangling,
    manifest_sha256: ''
  };
  manifest.manifest_sha256 = manifestDigest(manifest);
  return manifest;
}

export function assertManifest(value: unknown): MigrationManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidInput('a migration manifest is required');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== MIGRATION_MANIFEST_VERSION) {
    throw invalidInput('the migration manifest has an unsupported version');
  }
  if (typeof record.vault_root !== 'string' || typeof record.state_root !== 'string') {
    throw invalidInput('the migration manifest is missing its roots');
  }
  if (!Array.isArray(record.moves) || !Array.isArray(record.history_copies)) {
    throw invalidInput('the migration manifest is malformed');
  }
  if (!Array.isArray(record.rewrites) || !Array.isArray(record.blockers)) {
    throw invalidInput('the migration manifest is malformed');
  }
  if (record.source_fingerprint === null || typeof record.source_fingerprint !== 'object') {
    throw invalidInput('the migration manifest has no source fingerprint');
  }
  const manifest = value as MigrationManifest;
  const expected = manifestDigest(manifest);
  if (typeof manifest.manifest_sha256 !== 'string' || manifest.manifest_sha256 !== expected) {
    throw conflict('the migration manifest failed its integrity check');
  }
  for (const move of manifest.moves) {
    if (typeof move.current_sha256 !== 'string' || !SHA256_PATTERN.test(move.current_sha256)) {
      throw invalidInput('a migration move is missing its content hash');
    }
    if (sha256(move.current_raw) !== move.current_sha256) {
      throw conflict(`migration move ${move.logical_id} failed its content check`);
    }
  }
  return manifest;
}

export type { ParsedManagedFile };
