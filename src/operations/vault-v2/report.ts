import type { MigrationBlocker, MigrationManifest } from './plan.js';

export interface VaultMigrationInspection {
  version: number;
  generated_at: string;
  vault_root: string;
  state_root: string;
  source_fingerprint_sha256: string;
  counts: {
    files: number;
    managed_notes: number;
    resolved_notes: number;
    blocked_notes: number;
    history_copies: number;
    rewrites: number;
  };
  moves: { logical_id: string; current_path: string; head_revision_id: string }[];
  blockers: MigrationBlocker[];
}

export function buildInspectionReport(manifest: MigrationManifest): VaultMigrationInspection {
  const blockedIds = new Set<string>();
  for (const entry of manifest.blockers) {
    if (entry.id !== undefined) blockedIds.add(entry.id);
  }
  const managedNotes = new Set<string>([
    ...manifest.moves.map((move) => move.logical_id),
    ...manifest.history_copies.map((copy) => copy.logical_id)
  ]);
  return {
    version: manifest.version,
    generated_at: manifest.created_at,
    vault_root: manifest.vault_root,
    state_root: manifest.state_root,
    source_fingerprint_sha256: manifest.source_fingerprint.sha256,
    counts: {
      files: manifest.source_fingerprint.vault.length + manifest.source_fingerprint.state.length,
      managed_notes: managedNotes.size,
      resolved_notes: manifest.moves.length,
      blocked_notes: blockedIds.size,
      history_copies: manifest.history_copies.length,
      rewrites: manifest.rewrites.length
    },
    moves: manifest.moves.map((move) => ({
      logical_id: move.logical_id,
      current_path: move.current_path,
      head_revision_id: move.head_revision_id
    })),
    blockers: manifest.blockers
  };
}

export function renderInspectionReport(report: VaultMigrationInspection): string {
  const lines = [
    `vault-v2 inspection`,
    `vault: ${report.vault_root}`,
    `state: ${report.state_root}`,
    `source fingerprint: ${report.source_fingerprint_sha256}`,
    `files: ${report.counts.files}; managed notes: ${report.counts.managed_notes}; ` +
      `resolved: ${report.counts.resolved_notes}; blocked: ${report.counts.blocked_notes}; ` +
      `history copies: ${report.counts.history_copies}; rewrites: ${report.counts.rewrites}`
  ];
  for (const move of report.moves) {
    lines.push(`  move ${move.logical_id} -> ${move.current_path}`);
  }
  for (const entry of report.blockers) {
    lines.push(`  blocker ${entry.kind}${entry.id === undefined ? '' : ` ${entry.id}`}: ${entry.reason}`);
  }
  return `${lines.join('\n')}\n`;
}
