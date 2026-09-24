import { rm } from 'node:fs/promises';
import { BrainError, isBrainError } from '../../contracts/errors.js';
import { InstanceLock } from '../../core/mutation.js';
import { MAINTENANCE_LOCK_NAME } from './apply.js';
import { inventoryTree } from './inventory.js';
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
  type MigrationJournal,
  type MigrationManifest,
  type MigrationRollbackRecord
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

async function preflightHistory(manifest: MigrationManifest): Promise<void> {
  for (const copy of manifest.history_copies) {
    let bytes: Buffer;
    try {
      bytes = await readBytesAt(manifest.state_root, copy.destination_path);
    } catch (error) {
      throw wrapIo(`history for ${copy.source_path} cannot be read for rollback`, error);
    }
    if (sha256(bytes) !== copy.source_sha256) {
      throw recoveryRequired(`history for ${copy.source_path} failed its rollback verification`);
    }
  }
}

async function preflightDestinations(manifest: MigrationManifest): Promise<void> {
  for (const move of manifest.moves) {
    const actual = await hashFileAt(vaultAbsolutePath(manifest.vault_root, move.current_path));
    if (actual !== move.current_sha256) {
      throw conflict(`current note ${move.current_path} diverged before rollback`);
    }
  }
  for (const rewrite of manifest.rewrites) {
    const actual = await hashFileAt(vaultAbsolutePath(manifest.vault_root, rewrite.path));
    if (actual !== rewrite.new_sha256) {
      throw conflict(`rewritten file ${rewrite.path} diverged before rollback`);
    }
  }
}

async function assertNoNewWrites(
  manifest: MigrationManifest,
  journal: MigrationJournal
): Promise<void> {
  if (journal.post_migration_inventory === undefined) {
    throw recoveryRequired('the migration journal has no post-migration inventory to compare');
  }
  const recorded = new Map(journal.post_migration_inventory.map((row) => [row.path, row.sha256]));
  const current = await inventoryTree(manifest.vault_root);
  const divergences: string[] = [];
  const seen = new Set<string>();
  for (const row of current) {
    seen.add(row.path);
    const expected = recorded.get(row.path);
    if (expected === undefined) {
      divergences.push(`new file ${row.path}`);
    } else if (expected !== row.sha256) {
      divergences.push(`changed file ${row.path}`);
    }
  }
  for (const path of recorded.keys()) {
    if (!seen.has(path)) divergences.push(`removed file ${path}`);
  }
  if (divergences.length > 0) {
    throw conflict(`the migrated vault has diverged: ${divergences.sort().join('; ')}`);
  }
}

function newRollback(now: string): MigrationRollbackRecord {
  return {
    status: 'running',
    updated_at: now,
    restored_sources: [],
    restored_rewrites: [],
    removed_current: []
  };
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

  const lock = InstanceLock.acquire(manifest.state_root, MAINTENANCE_LOCK_NAME);
  try {
    let rollback = journal.rollback;
    if (rollback === undefined) {
      await preflightHistory(manifest);
      await preflightDestinations(manifest);
      await assertNoNewWrites(manifest, journal);
      rollback = newRollback(now);
      journal.rollback = rollback;
      journal.updated_at = now;
      await writeJournal(manifest.state_root, journal);
    }

    for (const copy of manifest.history_copies) {
      if (rollback.restored_sources.includes(copy.source_path)) continue;
      const absolute = vaultAbsolutePath(manifest.vault_root, copy.source_path);
      const present = await hashFileAt(absolute);
      if (present === copy.source_sha256) {
        rollback.restored_sources.push(copy.source_path);
        continue;
      }
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
      rollback.restored_sources.push(copy.source_path);
      rollback.updated_at = now;
      journal.updated_at = now;
      await writeJournal(manifest.state_root, journal);
    }

    for (const rewrite of manifest.rewrites) {
      if (rollback.restored_rewrites.includes(rewrite.path)) continue;
      const absolute = vaultAbsolutePath(manifest.vault_root, rewrite.path);
      const current = await hashFileAt(absolute);
      if (current === sha256(rewrite.preimage_raw)) {
        rollback.restored_rewrites.push(rewrite.path);
        continue;
      }
      if (current !== rewrite.new_sha256) {
        throw conflict(`rewritten file ${rewrite.path} received a new write`);
      }
      await replaceFileAtomic(absolute, rewrite.preimage_raw);
      rollback.restored_rewrites.push(rewrite.path);
      rollback.updated_at = now;
      journal.updated_at = now;
      await writeJournal(manifest.state_root, journal);
    }

    for (const move of manifest.moves) {
      if (rollback.removed_current.includes(move.current_path)) continue;
      const absolute = vaultAbsolutePath(manifest.vault_root, move.current_path);
      const current = await hashFileAt(absolute);
      if (current === undefined) {
        rollback.removed_current.push(move.current_path);
        continue;
      }
      if (current !== move.current_sha256) {
        throw conflict(`current note ${move.current_path} received a new write`);
      }
      await rm(absolute, { force: true });
      rollback.removed_current.push(move.current_path);
      rollback.updated_at = now;
      journal.updated_at = now;
      await writeJournal(manifest.state_root, journal);
    }

    rollback.status = 'complete';
    rollback.updated_at = now;
    journal.state = 'rolled_back';
    journal.updated_at = now;
    await writeJournal(manifest.state_root, journal);
    return {
      status: 'rolled_back',
      manifest_sha256: manifest.manifest_sha256,
      restored_sources: rollback.restored_sources.length,
      removed_current: rollback.removed_current.length,
      restored_rewrites: rollback.restored_rewrites.length,
      divergences: []
    };
  } finally {
    lock.release();
  }
}
