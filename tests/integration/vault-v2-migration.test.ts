import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import fixtureJson from '../fixtures/vault-v2/manifest-cases.json' with { type: 'json' };
import { inventoryTree } from '../../src/operations/vault-v2/inventory.js';
import {
  applyVaultMigration,
  resumeVaultMigration
} from '../../src/operations/vault-v2/apply.js';
import { planVaultMigration, buildMigrationBackupReceipt } from '../../src/operations/vault-v2/plan.js';
import { rollbackVaultMigration } from '../../src/operations/vault-v2/rollback.js';
import { verifyVaultMigration } from '../../src/operations/vault-v2/verify.js';
import { parseDocument } from '../../src/notes/document-codec.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

interface ManifestFileFixture {
  path: string;
  bytes: number;
  sha256: string;
  base64: string;
}

const fixture = fixtureJson as unknown as { files: ManifestFileFixture[] };
const PROJECT_NAMES = { freellmapi: 'FreeLLM API' };
const FIXED_CLOCK = { now: () => new Date('2026-09-24T00:00:00.000Z') };
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function materialize(vault: string): Promise<void> {
  for (const entry of fixture.files) {
    const bytes = Buffer.from(entry.base64, 'base64');
    const destination = join(vault, entry.path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, bytes);
  }
}

async function sandboxPlan() {
  const s = await vaultSandbox();
  await materialize(s.vault);
  const plan = await planVaultMigration({
    vault: s.vault,
    state: s.state,
    projectNames: PROJECT_NAMES,
    clock: FIXED_CLOCK
  });
  return { s, plan, receipt: buildMigrationBackupReceipt(plan.source_fingerprint) };
}

function options(receipt: unknown) {
  return { maintenance: true, backupReceipt: receipt, clock: FIXED_CLOCK };
}

test('applies the frozen fixture losslessly and verifies heads, ids, hashes, and links', async () => {
  const { s, plan, receipt } = await sandboxPlan();
  try {
    const result = await applyVaultMigration(plan, options(receipt));
    expect(result.status).toBe('applied');

    const report = await verifyVaultMigration(plan);
    expect(report.ok).toBe(true);
    expect(report.hash_failures).toEqual([]);
    expect(report.dangling_links).toEqual([]);
    expect(report.uuid_paths).toEqual([]);
    expect(report.duplicate_heads).toEqual([]);
    expect(report.counts.current_files).toBe(plan.moves.length);

    for (const copy of plan.history_copies) {
      const bytes = await readFile(join(s.state, copy.destination_path));
      expect(bytes.byteLength).toBe(
        fixture.files.find((file) => file.path === copy.source_path)?.bytes
      );
      const original = Buffer.from(
        fixture.files.find((file) => file.path === copy.source_path)?.base64 ?? '',
        'base64'
      );
      expect(bytes).toEqual(original);
    }

    const heads = new Map<string, number>();
    for (const move of plan.moves) {
      const raw = await readFile(join(s.vault, move.current_path), 'utf8');
      const document = parseDocument(raw, move.current_path);
      expect(document.id).toBe(move.logical_id);
      heads.set(move.logical_id, (heads.get(move.logical_id) ?? 0) + 1);
      for (const segment of move.current_path.split('/')) {
        const stem = segment.endsWith('.md') ? segment.slice(0, -3) : segment;
        expect(UUID_SEGMENT.test(stem)).toBe(false);
      }
    }
    for (const count of heads.values()) expect(count).toBe(1);

    for (const copy of plan.history_copies) {
      await expect(readFile(join(s.vault, copy.source_path))).rejects.toThrow();
    }

    const again = await applyVaultMigration(plan, options(receipt));
    expect(again.status).toBe('noop');
  } finally {
    await s.dispose();
  }
});

test('a fault after each persisted migration stage is resumable', async () => {
  const phases = ['history', 'materialize', 'remove_sources', 'rewrites', 'verify', 'complete'] as const;
  for (const phase of phases) {
    const { s, plan, receipt } = await sandboxPlan();
    try {
      let fired = false;
      await expect(
        applyVaultMigration(plan, {
          ...options(receipt),
          faults: {
            afterPhase: (observed) => {
              if (observed === phase && !fired) {
                fired = true;
                throw new Error(`injected fault after ${observed}`);
              }
            }
          }
        })
      ).rejects.toThrow();
      expect(fired).toBe(true);
      const resumed = await resumeVaultMigration(plan, options(receipt));
      expect(['resumed', 'noop']).toContain(resumed.status);
      const report = await verifyVaultMigration(plan);
      expect(report.ok).toBe(true);
      const repeated = await applyVaultMigration(plan, options(receipt));
      expect(repeated.status).toBe('noop');
    } finally {
      await s.dispose();
    }
  }
});

test('resume refuses corrupted durable history', async () => {
  const { s, plan, receipt } = await sandboxPlan();
  try {
    let fired = false;
    await expect(
      applyVaultMigration(plan, {
        ...options(receipt),
        faults: {
          afterPhase: (phase) => {
            if (phase === 'history' && !fired) {
              fired = true;
              throw new Error('stop after history');
            }
          }
        }
      })
    ).rejects.toThrow();
    await writeFile(join(s.state, plan.history_copies[0].destination_path), 'corrupted');
    await expect(resumeVaultMigration(plan, options(receipt))).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED'
    });
  } finally {
    await s.dispose();
  }
});

test('apply refuses when a proposed target is occupied', async () => {
  const { s, plan, receipt } = await sandboxPlan();
  try {
    const target = join(s.vault, plan.moves[0].current_path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, '# occupied\n');
    await expect(applyVaultMigration(plan, options(receipt))).rejects.toMatchObject({
      code: 'CONFLICT'
    });
  } finally {
    await s.dispose();
  }
});

test('conflicting heads are reported and left untouched rather than guessed', async () => {
  const { s, plan, receipt } = await sandboxPlan();
  try {
    const fork = plan.blockers.find((entry) => entry.kind === 'fork');
    expect(fork?.id).toBe('0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d');
    await applyVaultMigration(plan, options(receipt));
    const report = await verifyVaultMigration(plan);
    expect(report.ok).toBe(true);
    expect(report.duplicate_heads).toEqual([]);
    expect(plan.moves.some((move) => move.logical_id === fork?.id)).toBe(false);
    for (const legacy of fork?.paths ?? []) {
      await readFile(join(s.vault, legacy));
    }
  } finally {
    await s.dispose();
  }
});

test('apply refuses when the source vault changed after planning', async () => {
  const { s, plan, receipt } = await sandboxPlan();
  try {
    await writeFile(join(s.vault, plan.moves[0].head_source_path), '# changed\n');
    await expect(applyVaultMigration(plan, options(receipt))).rejects.toMatchObject({
      code: 'CONFLICT'
    });
  } finally {
    await s.dispose();
  }
});

test('apply refuses a manifest that has only blocked notes', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const plan = await planVaultMigration({
      vault: s.vault,
      state: s.state,
      projectNames: {},
      clock: FIXED_CLOCK
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.blockers.length).toBeGreaterThan(0);
    await expect(
      applyVaultMigration(plan, options(buildMigrationBackupReceipt(plan.source_fingerprint)))
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await s.dispose();
  }
});

test('rollback refuses after a human edit and otherwise restores the source vault', async () => {
  const { s, plan, receipt } = await sandboxPlan();
  try {
    const before = await inventoryTree(s.vault);
    await applyVaultMigration(plan, options(receipt));
    const editedPath = join(s.vault, plan.moves[0].current_path);
    const edited = await readFile(editedPath, 'utf8');
    await writeFile(editedPath, `${edited}\nHuman addition.\n`);
    await expect(
      rollbackVaultMigration(plan, { maintenance: true, clock: FIXED_CLOCK })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await s.dispose();
  }
});

test('rollback restores every original source file and removes generated notes', async () => {
  const { s, plan, receipt } = await sandboxPlan();
  try {
    const before = await inventoryTree(s.vault);
    await applyVaultMigration(plan, options(receipt));
    expect(await inventoryTree(s.vault)).not.toEqual(before);
    const rollback = await rollbackVaultMigration(plan, {
      maintenance: true,
      clock: FIXED_CLOCK
    });
    expect(rollback.status).toBe('rolled_back');
    expect(await inventoryTree(s.vault)).toEqual(before);
    for (const copy of plan.history_copies) {
      await readFile(join(s.state, copy.destination_path));
    }
    const noop = await rollbackVaultMigration(plan, { maintenance: true, clock: FIXED_CLOCK });
    expect(noop.status).toBe('noop');
  } finally {
    await s.dispose();
  }
});
