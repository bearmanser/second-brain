import { rm } from 'node:fs/promises';
import { BrainError, isBrainError } from '../../contracts/errors.js';
import { acquireMaintenanceLock } from './apply.js';
import {
  assertManifest,
  hashFileAt,
  readBytesAt,
  readJournal,
  replaceFileAtomic,
  sha256,
  vaultAbsolutePath,
  writeJournal,
  writeNewFileNoClobber,
  type MigrationManifest
} from './plan.js';

export interface RollbackVaultMigrationOptions {
  maintenance: boolean;
  clock?: { now(): Date };
}

export interface RollbackVaultMigrationResult {
  status: 'rolled_back' | 'noop';
  manifest_sha256: string;
  restored_sources: number;
  removed_current: number;
  restored_rewrites: number;
  divergences: string[];
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

function wrapIo(message: string, error: unknown): BrainError {
  return isBrainError(error) ? error : recoveryRequired(message, error);
}

export async function rollbackVaultMigration(
  input: unknown,
  options: RollbackVaultMigrationOptions
): Promise<RollbackVaultMigrationResult> {
  const manifest: MigrationManifest = assertManifest(input);
  if (options.maintenance !== true) {
    throw invalidInput('rolling back a migration requires exclusive maintenance mode');
  }
  const now = (options.clock ?? { now: () => new Date() }).now().toISOString();
  const journal = await readJournal(manifest.state_root, manifest.manifest_sha256);
  if (journal === undefined) throw conflict('there is no migration journal to roll back');
  if (journal.state === 'rolled_back') {
    return {
      status: 'noop',
      manifest_sha256: manifest.manifest_sha256,
      restored_sources: 0,
      removed_current: 0,
      restored_rewrites: 0,
      divergences: []
    };
  }
  if (journal.state !== 'complete') {
    throw conflict('only a completed migration can be rolled back');
  }

  const divergences: string[] = [];
  for (const move of manifest.moves) {
    const actual = await hashFileAt(vaultAbsolutePath(manifest.vault_root, move.current_path));
    if (actual !== move.current_sha256) {
      divergences.push(`current note ${move.current_path} received a new write`);
    }
  }
  for (const rewrite of manifest.rewrites) {
    const actual = await hashFileAt(vaultAbsolutePath(manifest.vault_root, rewrite.path));
    if (actual !== rewrite.new_sha256) {
      divergences.push(`rewritten file ${rewrite.path} received a new write`);
    }
  }
  for (const copy of manifest.history_copies) {
    const actual = await hashFileAt(vaultAbsolutePath(manifest.vault_root, copy.source_path));
    if (actual !== undefined && actual !== copy.source_sha256) {
      divergences.push(`legacy path ${copy.source_path} received a new write`);
    }
  }
  if (divergences.length > 0) {
    throw conflict(`the migrated vault has diverged: ${divergences.join('; ')}`);
  }

  await acquireMaintenanceLock(manifest.state_root, manifest.manifest_sha256, now);
  let removedCurrent = 0;
  for (const move of manifest.moves) {
    const absolute = vaultAbsolutePath(manifest.vault_root, move.current_path);
    const actual = await hashFileAt(absolute);
    if (actual === move.current_sha256) {
      await rm(absolute, { force: true });
      removedCurrent += 1;
    }
  }
  let restoredRewrites = 0;
  for (const rewrite of manifest.rewrites) {
    const absolute = vaultAbsolutePath(manifest.vault_root, rewrite.path);
    const actual = await hashFileAt(absolute);
    if (actual === rewrite.new_sha256) {
      await replaceFileAtomic(absolute, rewrite.preimage_raw);
      restoredRewrites += 1;
    }
  }
  let restoredSources = 0;
  for (const copy of manifest.history_copies) {
    const absolute = vaultAbsolutePath(manifest.vault_root, copy.source_path);
    const present = await hashFileAt(absolute);
    if (present === copy.source_sha256) continue;
    if (present !== undefined) {
      throw conflict(`cannot restore ${copy.source_path}; a different file now occupies it`);
    }
    let bytes: Buffer;
    try {
      bytes = await readBytesAt(manifest.state_root, copy.destination_path);
    } catch (error) {
      throw wrapIo(`history for ${copy.source_path} cannot be read for rollback`, error);
    }
    if (sha256(bytes) !== copy.source_sha256) {
      throw recoveryRequired(`history for ${copy.source_path} failed its rollback verification`);
    }
    await writeNewFileNoClobber(absolute, bytes);
    restoredSources += 1;
  }

  journal.state = 'rolled_back';
  journal.updated_at = now;
  await writeJournal(manifest.state_root, journal);
  return {
    status: 'rolled_back',
    manifest_sha256: manifest.manifest_sha256,
    restored_sources: restoredSources,
    removed_current: removedCurrent,
    restored_rewrites: restoredRewrites,
    divergences: []
  };
}
