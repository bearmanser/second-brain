import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrainError, isBrainError } from '../../contracts/errors.js';
import {
  MIGRATION_PHASES,
  assertManifest,
  availableBytes,
  fingerprintSource,
  hashFileAt,
  journalDirectory,
  manifestDigest,
  markPhase,
  newJournal,
  readBytesAt,
  readJournal,
  removeFileIfMatches,
  replaceFileAtomic,
  stateAbsolutePath,
  sha256,
  vaultAbsolutePath,
  verifyMigrationBackupReceipt,
  writeJournal,
  writeNewFileNoClobber,
  type MigrationFaults,
  type MigrationJournal,
  type MigrationManifest,
  type MigrationPhase
} from './plan.js';
import { openRevisionStore } from '../../storage/revision-store.js';
import { verifyVaultMigration } from './verify.js';

export interface ApplyVaultMigrationOptions {
  maintenance: boolean;
  backupReceipt: unknown;
  faults?: MigrationFaults;
  clock?: { now(): Date };
}

export interface ApplyVaultMigrationResult {
  status: 'applied' | 'resumed' | 'noop';
  manifest_sha256: string;
  phases: MigrationPhase[];
  counts: {
    moves: number;
    history_copies: number;
    rewrites: number;
    source_files_removed: number;
  };
}

function invalidInput(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message, cause });
}

function conflict(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'CONFLICT', message, cause });
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

function hasErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function wrapIo(message: string, error: unknown): BrainError {
  return isBrainError(error) ? error : recoveryRequired(message, error);
}

function sameFingerprint(
  left: MigrationManifest['source_fingerprint'],
  right: MigrationManifest['source_fingerprint']
): boolean {
  return (
    left.sha256 === right.sha256 &&
    JSON.stringify(left.vault) === JSON.stringify(right.vault) &&
    JSON.stringify(left.state) === JSON.stringify(right.state)
  );
}

export async function acquireMaintenanceLock(
  state: string,
  migrationId: string,
  now: string
): Promise<void> {
  const directory = journalDirectory(state, migrationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'maintenance.lock');
  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({ migration_id: migrationId, pid: process.pid, started_at: now })}\n`,
      { flag: 'wx', mode: 0o600 }
    );
    return;
  } catch (error) {
    if (!hasErrno(error, 'EEXIST')) throw wrapIo('the maintenance lock cannot be created', error);
  }
  const raw = await readFile(lockPath, 'utf8').catch(() => '');
  let sameMigration = false;
  try {
    const parsed = JSON.parse(raw) as { migration_id?: unknown };
    sameMigration = parsed.migration_id === migrationId;
  } catch {
    sameMigration = false;
  }
  if (sameMigration) return;
  throw conflict('another migration holds exclusive maintenance mode');
}

async function verifyRecordedState(
  manifest: MigrationManifest,
  current: MigrationManifest['source_fingerprint']
): Promise<void> {
  const currentByPath = new Map(current.state.map((file) => [file.path, file.sha256]));
  for (const file of manifest.source_fingerprint.state) {
    if (currentByPath.get(file.path) !== file.sha256) {
      throw conflict(`durable state ${file.path} changed since the plan was recorded`);
    }
  }
}

async function assertFreeSpace(manifest: MigrationManifest): Promise<void> {
  const sizes = new Map(manifest.source_fingerprint.vault.map((file) => [file.path, file.bytes]));
  let stateBytes = 0;
  for (const copy of manifest.history_copies) {
    stateBytes += sizes.get(copy.source_path) ?? 0;
  }
  let vaultBytes = 0;
  for (const move of manifest.moves) {
    vaultBytes += Buffer.byteLength(move.current_raw, 'utf8');
  }
  for (const rewrite of manifest.rewrites) {
    vaultBytes += Buffer.byteLength(rewrite.new_raw, 'utf8');
  }
  const stateAvailable = await availableBytes(manifest.state_root);
  if (stateAvailable < stateBytes * 2) {
    throw recoveryRequired('insufficient free space for durable history copies');
  }
  const vaultAvailable = await availableBytes(manifest.vault_root);
  if (vaultAvailable < vaultBytes * 2) {
    throw recoveryRequired('insufficient free space for the migrated vault');
  }
}

async function verifyJournalArtifacts(
  manifest: MigrationManifest,
  journal: MigrationJournal,
  phase: MigrationPhase
): Promise<void> {
  const record = journal.phases[phase];
  if (record.status !== 'complete') return;
  if (phase === 'verify' || phase === 'complete') return;
  const root = phase === 'history' ? manifest.state_root : manifest.vault_root;
  for (const artifact of record.artifacts) {
    const absolute = vaultAbsolutePath(root, artifact.path);
    if (phase === 'remove_sources') {
      const present = await hashFileAt(absolute);
      if (present !== undefined) {
        throw recoveryRequired(`source file ${artifact.path} reappeared during the migration`);
      }
      continue;
    }
    const actual = await hashFileAt(absolute);
    if (actual !== artifact.sha256) {
      throw recoveryRequired(`migration artifact ${artifact.path} does not match its recorded hash`);
    }
  }
}

async function runHistoryPhase(
  manifest: MigrationManifest,
  now: string
): Promise<{ path: string; sha256: string }[]> {
  const artifacts: { path: string; sha256: string }[] = [];
  const store = await openRevisionStore(manifest.state_root);
  try {
    for (const copy of manifest.history_copies) {
      const bytes = await readBytesAt(manifest.vault_root, copy.source_path);
      const raw = bytes.toString('utf8');
      if (!Buffer.from(raw, 'utf8').equals(bytes)) {
        throw invalidInput(`source revision ${copy.source_path} is not valid UTF-8`);
      }
      if (sha256(bytes) !== copy.source_sha256) {
        throw conflict(`source revision ${copy.source_path} changed before it was copied`);
      }
      const stored = await store.persistRevision(copy.logical_id, copy.revision_id, raw);
      const written = await hashFileAt(vaultAbsolutePath(manifest.state_root, copy.destination_path));
      if (stored.hash !== copy.source_sha256 || written !== copy.source_sha256) {
        throw recoveryRequired(`history copy ${copy.destination_path} failed its verification`);
      }
      artifacts.push({ path: copy.destination_path, sha256: copy.source_sha256 });
    }
  } finally {
    store.close();
  }
  void now;
  return artifacts;
}

async function runMaterializePhase(manifest: MigrationManifest): Promise<{ path: string; sha256: string }[]> {
  const artifacts: { path: string; sha256: string }[] = [];
  for (const move of manifest.moves) {
    const absolute = vaultAbsolutePath(manifest.vault_root, move.current_path);
    const existing = await hashFileAt(absolute);
    if (existing !== undefined && existing !== move.current_sha256) {
      throw conflict(`target ${move.current_path} is occupied by different bytes`);
    }
    await writeNewFileNoClobber(absolute, move.current_raw);
    const written = await hashFileAt(absolute);
    if (written !== move.current_sha256) {
      throw recoveryRequired(`migrated note ${move.current_path} failed its verification`);
    }
    artifacts.push({ path: move.current_path, sha256: move.current_sha256 });
  }
  return artifacts;
}

async function runRemoveSourcesPhase(
  manifest: MigrationManifest
): Promise<{ path: string; sha256: string }[]> {
  const artifacts: { path: string; sha256: string }[] = [];
  const seen = new Set<string>();
  for (const copy of manifest.history_copies) {
    if (seen.has(copy.source_path)) continue;
    seen.add(copy.source_path);
    const destination = stateAbsolutePath(manifest.state_root, copy.destination_path);
    const durable = await hashFileAt(destination);
    if (durable !== copy.source_sha256) {
      throw recoveryRequired(`history for ${copy.source_path} is not durable; refusing to remove it`);
    }
    const absolute = vaultAbsolutePath(manifest.vault_root, copy.source_path);
    const outcome = await removeFileIfMatches(absolute, copy.source_sha256);
    if (outcome === 'changed') {
      throw conflict(`source file ${copy.source_path} changed before it could be removed`);
    }
    artifacts.push({ path: copy.source_path, sha256: copy.source_sha256 });
  }
  return artifacts;
}

async function runRewritesPhase(manifest: MigrationManifest): Promise<{ path: string; sha256: string }[]> {
  const artifacts: { path: string; sha256: string }[] = [];
  for (const rewrite of manifest.rewrites) {
    const absolute = vaultAbsolutePath(manifest.vault_root, rewrite.path);
    const current = await hashFileAt(absolute);
    if (current === rewrite.new_sha256) {
      artifacts.push({ path: rewrite.path, sha256: rewrite.new_sha256 });
      continue;
    }
    if (current !== rewrite.expected_sha256) {
      throw conflict(`file ${rewrite.path} changed before its links could be rewritten`);
    }
    await replaceFileAtomic(absolute, rewrite.new_raw);
    const written = await hashFileAt(absolute);
    if (written !== rewrite.new_sha256) {
      throw recoveryRequired(`rewritten file ${rewrite.path} failed its verification`);
    }
    artifacts.push({ path: rewrite.path, sha256: rewrite.new_sha256 });
  }
  return artifacts;
}

async function assertMigrated(manifest: MigrationManifest): Promise<void> {
  const report = await verifyVaultMigration(manifest);
  if (!report.ok) {
    throw recoveryRequired(
      `migration verification failed: ${report.hash_failures.length} hash failures, ` +
        `${report.dangling_links.length} new dangling links`
    );
  }
}

async function runMigration(
  input: unknown,
  options: ApplyVaultMigrationOptions,
  mode: 'apply' | 'resume'
): Promise<ApplyVaultMigrationResult> {
  const manifest = assertManifest(input);
  const now = (options.clock ?? { now: () => new Date() }).now().toISOString();
  if (options.maintenance !== true) {
    throw invalidInput('applying a migration requires exclusive maintenance mode');
  }
  if (manifest.moves.length === 0 && manifest.blockers.length > 0) {
    throw conflict('the migration has no resolvable notes and unresolved blockers');
  }
  if (manifestDigest(manifest) !== manifest.manifest_sha256) {
    throw conflict('the migration manifest failed its integrity check');
  }
  const phases: MigrationPhase[] = [];
  let journal = await readJournal(manifest.state_root, manifest.manifest_sha256);
  if (journal !== undefined && journal.state === 'complete') {
    for (const phase of MIGRATION_PHASES) {
      if (phase === 'complete') continue;
      await verifyJournalArtifacts(manifest, journal, phase);
    }
    await assertMigrated(manifest);
    return {
      status: 'noop',
      manifest_sha256: manifest.manifest_sha256,
      phases: [],
      counts: {
        moves: manifest.moves.length,
        history_copies: manifest.history_copies.length,
        rewrites: manifest.rewrites.length,
        source_files_removed: 0
      }
    };
  }
  if (mode === 'resume' && journal === undefined) {
    throw conflict('there is no migration journal to resume');
  }
  if (mode === 'resume' && journal !== undefined && journal.state === 'rolled_back') {
    throw conflict('the migration was rolled back and cannot be resumed');
  }

  const fingerprint = await fingerprintSource({
    vault: manifest.vault_root,
    state: manifest.state_root,
    outputDirectory: journalDirectory(manifest.state_root, manifest.manifest_sha256)
  });
  if (journal === undefined) {
    if (!sameFingerprint(manifest.source_fingerprint, fingerprint)) {
      throw conflict('the source vault changed since the manifest was recorded');
    }
    await verifyRecordedState(manifest, fingerprint);
    verifyMigrationBackupReceipt(options.backupReceipt, fingerprint);
  } else {
    await verifyRecordedState(manifest, fingerprint);
  }

  await acquireMaintenanceLock(manifest.state_root, manifest.manifest_sha256, now);
  let active: MigrationJournal = journal ?? newJournal(manifest, now);
  if (journal === undefined) {
    await writeJournal(manifest.state_root, active);
  }

  const faults = options.faults ?? {};
  const requirePhase = async (phase: MigrationPhase, run: () => Promise<{ path: string; sha256: string }[]>): Promise<void> => {
    const record = active.phases[phase];
    if (record.status === 'complete') {
      await verifyJournalArtifacts(manifest, active, phase);
      return;
    }
    await assertFreeSpace(manifest);
    const artifacts = await run();
    active = await markPhase(manifest.state_root, active, phase, artifacts, now, faults);
    phases.push(phase);
  };

  await requirePhase('history', async () => runHistoryPhase(manifest, now));
  await requirePhase('materialize', async () => runMaterializePhase(manifest));
  await requirePhase('remove_sources', async () => runRemoveSourcesPhase(manifest));
  await requirePhase('rewrites', async () => runRewritesPhase(manifest));
  if (active.phases.verify.status !== 'complete') {
    await assertMigrated(manifest);
    active = await markPhase(manifest.state_root, active, 'verify', [], now, faults);
    phases.push('verify');
  }
  if (active.state !== 'complete') {
    active.state = 'complete';
    active.updated_at = now;
    await writeJournal(manifest.state_root, active);
    await faults.afterPhase?.('complete');
    phases.push('complete');
  }
  return {
    status: mode === 'resume' ? 'resumed' : 'applied',
    manifest_sha256: manifest.manifest_sha256,
    phases,
    counts: {
      moves: manifest.moves.length,
      history_copies: manifest.history_copies.length,
      rewrites: manifest.rewrites.length,
      source_files_removed: manifest.history_copies.length
    }
  };
}

export function applyVaultMigration(
  manifest: unknown,
  options: ApplyVaultMigrationOptions
): Promise<ApplyVaultMigrationResult> {
  return runMigration(manifest, options, 'apply');
}

export function resumeVaultMigration(
  manifest: unknown,
  options: ApplyVaultMigrationOptions
): Promise<ApplyVaultMigrationResult> {
  return runMigration(manifest, options, 'resume');
}

export async function releaseMigrationLock(state: string, migrationId: string): Promise<void> {
  await rm(join(journalDirectory(state, migrationId), 'maintenance.lock'), { force: true });
}
