import { readFile } from 'node:fs/promises';
import { parseDocument } from '../../notes/document-codec.js';
import { listVaultFilePaths } from '../../storage/vault.js';
import {
  assertManifest,
  collectDanglingLinks,
  hashFileAt,
  vaultAbsolutePath,
  type MigrationManifest
} from './plan.js';

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MigrationHashFailure {
  path: string;
  kind: 'current' | 'history' | 'rewrite' | 'identity' | 'malformed' | 'source_present';
  expected?: string;
  actual?: string;
}

export interface MigrationVerification {
  ok: boolean;
  counts: {
    moves: number;
    history_copies: number;
    rewrites: number;
    current_files: number;
    history_files: number;
    dangling_links: number;
    hash_failures: number;
  };
  hash_failures: MigrationHashFailure[];
  dangling_links: { path: string; target: string }[];
  uuid_paths: string[];
  duplicate_heads: string[];
}

async function readVaultRaw(vault: string, path: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(vaultAbsolutePath(vault, path));
    const raw = buffer.toString('utf8');
    return Buffer.from(raw, 'utf8').equals(buffer) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyVaultMigration(input: unknown): Promise<MigrationVerification> {
  const manifest: MigrationManifest = assertManifest(input);
  const hashFailures: MigrationHashFailure[] = [];
  const uuidPaths: string[] = [];
  let currentFiles = 0;
  for (const move of manifest.moves) {
    const absolute = vaultAbsolutePath(manifest.vault_root, move.current_path);
    const actual = await hashFileAt(absolute);
    if (actual !== move.current_sha256) {
      hashFailures.push({
        path: move.current_path,
        kind: 'current',
        expected: move.current_sha256,
        ...(actual === undefined ? {} : { actual })
      });
    } else {
      currentFiles += 1;
      const raw = await readVaultRaw(manifest.vault_root, move.current_path);
      if (raw === undefined) {
        hashFailures.push({ path: move.current_path, kind: 'malformed' });
      } else {
        try {
          if (parseDocument(raw, move.current_path).id !== move.logical_id) {
            hashFailures.push({ path: move.current_path, kind: 'identity' });
          }
        } catch {
          hashFailures.push({ path: move.current_path, kind: 'malformed' });
        }
      }
    }
    for (const segment of move.current_path.split('/')) {
      const stem = segment.toLowerCase().endsWith('.md') ? segment.slice(0, -3) : segment;
      if (UUID_SEGMENT.test(stem)) {
        if (!uuidPaths.includes(move.current_path)) uuidPaths.push(move.current_path);
        break;
      }
    }
    for (const legacyPath of move.legacy_source_paths) {
      const present = await hashFileAt(vaultAbsolutePath(manifest.vault_root, legacyPath));
      if (present !== undefined) {
        hashFailures.push({ path: legacyPath, kind: 'source_present', actual: present });
      }
    }
  }

  let historyFiles = 0;
  for (const copy of manifest.history_copies) {
    const actual = await hashFileAt(vaultAbsolutePath(manifest.state_root, copy.destination_path));
    if (actual !== copy.source_sha256) {
      hashFailures.push({
        path: copy.destination_path,
        kind: 'history',
        expected: copy.source_sha256,
        ...(actual === undefined ? {} : { actual })
      });
    } else {
      historyFiles += 1;
    }
  }

  for (const rewrite of manifest.rewrites) {
    const actual = await hashFileAt(vaultAbsolutePath(manifest.vault_root, rewrite.path));
    if (actual !== rewrite.new_sha256) {
      hashFailures.push({
        path: rewrite.path,
        kind: 'rewrite',
        expected: rewrite.new_sha256,
        ...(actual === undefined ? {} : { actual })
      });
    }
  }

  const vaultPaths = await listVaultFilePaths(manifest.vault_root);
  const catalogue = new Map<string, string | undefined>();
  for (const move of manifest.moves) {
    if (move.project_root === undefined) continue;
    const leaf = move.project_root.slice(move.project_root.lastIndexOf('/') + 1);
    catalogue.set(`${move.project_root}/${leaf}.md`, undefined);
  }
  const markdownFiles: { path: string; raw: string }[] = [];
  for (const path of vaultPaths) {
    if (path.toLowerCase().endsWith('.md')) {
      const raw = await readVaultRaw(manifest.vault_root, path);
      let id: string | undefined;
      if (raw !== undefined) {
        markdownFiles.push({ path, raw });
        try {
          id = parseDocument(raw, path).id;
        } catch {
          id = undefined;
        }
      }
      catalogue.set(path, id);
    } else {
      catalogue.set(path, undefined);
    }
  }

  const duplicateHeads: string[] = [];
  const idCounts = new Map<string, number>();
  for (const file of markdownFiles) {
    let id: string | undefined;
    try {
      id = parseDocument(file.raw, file.path).id;
    } catch {
      id = undefined;
    }
    if (id === undefined) continue;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) duplicateHeads.push(id);
  }

  const baseline = new Set(
    manifest.baseline_dangling_links.map((entry) => `${entry.path}\u0000${entry.target}`)
  );
  const dangling = collectDanglingLinks(markdownFiles, catalogue).filter(
    (entry) => !baseline.has(`${entry.path}\u0000${entry.target}`)
  );

  return {
    ok:
      hashFailures.length === 0 &&
      dangling.length === 0 &&
      uuidPaths.length === 0 &&
      duplicateHeads.length === 0,
    counts: {
      moves: manifest.moves.length,
      history_copies: manifest.history_copies.length,
      rewrites: manifest.rewrites.length,
      current_files: currentFiles,
      history_files: historyFiles,
      dangling_links: dangling.length,
      hash_failures: hashFailures.length
    },
    hash_failures: hashFailures,
    dangling_links: dangling,
    uuid_paths: uuidPaths,
    duplicate_heads: duplicateHeads
  };
}
