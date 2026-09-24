import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import manifest from '../fixtures/vault-v2/manifest-cases.json' with { type: 'json' };
import { inventoryTree } from '../../src/operations/vault-v2/inventory.js';
import { planVaultMigration, rewriteFileLinks } from '../../src/operations/vault-v2/plan.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  base64: string;
}

const fixture = manifest as unknown as { files: ManifestFile[] };

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

test('planning is read only even when the source has blockers', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const before = await inventoryTree(s.vault);
    const plan = await planVaultMigration({ ...s, projectNames: {}, clock: FIXED_CLOCK });
    expect(await inventoryTree(s.vault)).toEqual(before);
    expect(plan.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.blockers.length).toBeGreaterThan(0);
    expect(plan.moves).toHaveLength(0);
  } finally {
    await s.dispose();
  }
});

test('planning the frozen fixture records resolved heads, copies, and fork blockers', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const plan = await planVaultMigration({
      vault: s.vault,
      state: s.state,
      projectNames: PROJECT_NAMES,
      clock: FIXED_CLOCK
    });
    expect(plan.blockers).toEqual([
      expect.objectContaining({ kind: 'fork', id: '0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d' })
    ]);
    const paths = plan.moves.map((move) => move.current_path).sort();
    expect(paths).toEqual([
      'Projects/FreeLLM API/Notes/Læring fra feilsøking.md',
      'Projects/FreeLLM API/Preferences/Prefer local notes.md'
    ]);
    for (const move of plan.moves) {
      for (const segment of move.current_path.split('/')) {
        const stem = segment.endsWith('.md') ? segment.slice(0, -3) : segment;
        expect(UUID_SEGMENT.test(stem)).toBe(false);
      }
    }
    expect(plan.history_copies.map((copy) => copy.revision_id).sort()).toEqual([
      '8e5f6071-92a3-4eb4-9f2a-3b4c5d6e7f80',
      'a0718293-b4c5-40d6-914c-5d6e7f8091a2'
    ]);
    const preference = plan.moves.find(
      (move) => move.logical_id === '7d4e5f60-8192-4da3-8e1f-2a3b4c5d6e7f'
    );
    expect(preference?.status).toBe('active');
    expect(preference?.approval_preserved).toBe(true);
    expect(plan.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await s.dispose();
  }
});

test('planning is deterministic for identical inputs and a fixed clock', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const first = await planVaultMigration({
      vault: s.vault,
      state: s.state,
      projectNames: PROJECT_NAMES,
      clock: FIXED_CLOCK
    });
    const second = await planVaultMigration({
      vault: s.vault,
      state: s.state,
      projectNames: PROJECT_NAMES,
      clock: FIXED_CLOCK
    });
    expect(second.manifest_sha256).toBe(first.manifest_sha256);
    expect(second.moves).toEqual(first.moves);
  } finally {
    await s.dispose();
  }
});

test('link rewriting resolves old paths and identifiers through the old-to-new map', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const catalogue = new Map<string, string | undefined>([
    ['Legacy/Old.md', id],
    ['Other.md', undefined]
  ]);
  const oldToNew = new Map([['Legacy/Old.md', 'Knowledge/New.md']]);
  const raw = '[[Legacy/Old#Limits|Old]]\n`[[Legacy/Old]]`\n[[' + id + ']]\n';
  const outcome = rewriteFileLinks({
    raw,
    sourcePath: 'Other.md',
    postPath: 'Other.md',
    catalogue,
    oldToNew
  });
  expect(outcome.raw).toBe(
    '[[Knowledge/New#Limits|Old]]\n`[[Legacy/Old]]`\n[[Knowledge/New]]\n'
  );
});

test('relative links are recomputed against the source note original location', () => {
  const catalogue = new Map<string, string | undefined>([['Attachments/diagram.png', undefined]]);
  const outcome = rewriteFileLinks({
    raw: '![diagram](../Attachments/diagram.png)\n',
    sourcePath: 'Knowledge/Note.md',
    postPath: 'Projects/P/Notes/Note.md',
    catalogue,
    oldToNew: new Map()
  });
  expect(outcome.raw).toBe('![diagram](../../../Attachments/diagram.png)\n');
});

test('planning preserves unrelated human notes and attachments byte for byte', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const humanPath = join(s.vault, 'Knowledge/Human note.md');
    const humanBefore = await readFile(humanPath);
    await planVaultMigration({ vault: s.vault, state: s.state, projectNames: PROJECT_NAMES, clock: FIXED_CLOCK });
    expect(await readFile(humanPath)).toEqual(humanBefore);
  } finally {
    await s.dispose();
  }
});
