import { spawn } from 'node:child_process';
import { link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import fixtureJson from '../fixtures/vault-v2/manifest-cases.json' with { type: 'json' };
import { inventoryTree } from '../../src/operations/vault-v2/inventory.js';
import { applyVaultMigration, resumeVaultMigration } from '../../src/operations/vault-v2/apply.js';
import { planVaultMigration, buildMigrationBackupReceipt } from '../../src/operations/vault-v2/plan.js';
import { rollbackVaultMigration } from '../../src/operations/vault-v2/rollback.js';
import { verifyVaultMigration } from '../../src/operations/vault-v2/verify.js';
import { parseDocument } from '../../src/notes/document-codec.js';
import { runCli } from '../../src/cli.js';
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
const PREFERENCE_ID = '7d4e5f60-8192-4da3-8e1f-2a3b4c5d6e7f';
const PREFERENCE_PATH =
  'Projects/freellmapi/Preferences/7d4e5f60-8192-4da3-8e1f-2a3b4c5d6e7f/Prefer local notes r8e5f6071-92a3-4eb4-9f2a-3b4c5d6e7f80.md';

async function materialize(vault: string): Promise<void> {
  for (const entry of fixture.files) {
    const bytes = Buffer.from(entry.base64, 'base64');
    const destination = join(vault, entry.path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, bytes);
  }
}

interface Backup {
  root: string;
  receipt: unknown;
}

async function makeBackup(vault: string, state: string, plan: Awaited<ReturnType<typeof planVaultMigration>>): Promise<Backup> {
  const root = join(dirname(vault), 'backup-media');
  for (const file of plan.source_fingerprint.vault) {
    const destination = join(root, 'vault', file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(vault, file.path)));
  }
  for (const file of plan.source_fingerprint.state) {
    const destination = join(root, 'state', file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(state, file.path)));
  }
  return { root, receipt: buildMigrationBackupReceipt(plan.source_fingerprint) };
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
  const backup = await makeBackup(s.vault, s.state, plan);
  return { s, plan, backup };
}

function options(backup: Backup, overrides: Record<string, unknown> = {}) {
  return {
    maintenance: true,
    backupReceipt: backup.receipt,
    backupRoot: backup.root,
    partial: true,
    clock: FIXED_CLOCK,
    ...overrides
  };
}

test('applies the frozen fixture losslessly and verifies heads, ids, hashes, and links', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    const result = await applyVaultMigration(plan, options(backup));
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
      expect(document.properties.project).toBeUndefined();
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

    const again = await applyVaultMigration(plan, options(backup));
    expect(again.status).toBe('noop');
  } finally {
    await s.dispose();
  }
});

test('a fault after each persisted migration stage is resumable', async () => {
  const phases = ['history', 'materialize', 'remove_sources', 'rewrites', 'verify', 'complete'] as const;
  for (const phase of phases) {
    const { s, plan, backup } = await sandboxPlan();
    try {
      let fired = false;
      await expect(
        applyVaultMigration(plan, {
          ...options(backup),
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
      const resumed = await resumeVaultMigration(plan, options(backup));
      expect(['resumed', 'noop']).toContain(resumed.status);
      const report = await verifyVaultMigration(plan);
      expect(report.ok).toBe(true);
      const repeated = await applyVaultMigration(plan, options(backup));
      expect(repeated.status).toBe('noop');
    } finally {
      await s.dispose();
    }
  }
});

test('resume refuses corrupted durable history', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    let fired = false;
    await expect(
      applyVaultMigration(plan, {
        ...options(backup),
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
    await expect(resumeVaultMigration(plan, options(backup))).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED'
    });
  } finally {
    await s.dispose();
  }
});

test('apply refuses when a proposed target is occupied', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    const target = join(s.vault, plan.moves[0].current_path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '# occupied\n');
    await expect(applyVaultMigration(plan, options(backup))).rejects.toMatchObject({
      code: 'CONFLICT'
    });
  } finally {
    await s.dispose();
  }
});

test('apply refuses changed inputs', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    await writeFile(join(s.vault, plan.moves[0].head_source_path), '# changed\n');
    await expect(applyVaultMigration(plan, options(backup))).rejects.toMatchObject({
      code: 'CONFLICT'
    });
  } finally {
    await s.dispose();
  }
});

test('apply refuses blockers by default and enumerates them for opt-in partial migration', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    const fork = plan.blockers.find((entry) => entry.kind === 'fork');
    expect(fork?.id).toBe('0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d');

    let refusal = '';
    try {
      await applyVaultMigration(plan, options(backup, { partial: false }));
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONFLICT' });
      refusal = (error as Error).message;
    }
    expect(refusal).not.toBe('');
    for (const entry of plan.blockers) {
      expect(refusal).toContain(entry.reason);
      for (const path of entry.paths ?? (entry.path ? [entry.path] : [])) expect(refusal).toContain(path);
    }

    const result = await applyVaultMigration(plan, options(backup));
    expect(result.status).toBe('applied');
    expect(result.blocked.some((entry) => entry.kind === 'fork' && entry.id === fork?.id)).toBe(true);

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

test('CLI partial apply prints every blocked path and reason', async () => {
  const { s, plan, backup } = await sandboxPlan();
  const manifest = join(dirname(s.vault), 'manifest.json');
  const receipt = join(dirname(s.vault), 'receipt.json');
  const chunks: string[] = [];
  const original = process.stdout.write;
  try {
    await writeFile(manifest, JSON.stringify(plan));
    await writeFile(receipt, JSON.stringify(backup.receipt));
    const config = join(dirname(s.vault), 'config.yaml');
    await writeFile(config, `endpoint: http://localhost:3000\nbackend_endpoint: http://localhost:3001\nport: 3000\nmounts:\n  vault: ${s.vault}\n  state: ${s.state}\nscopes:\n  - id: personal\n    backend_project: Personal\n    relative_root: Personal\n    repository_aliases: []\nallowed_hosts: [localhost]\n`);
    process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    expect(await runCli(['vault-v2', 'apply', '--manifest', manifest, '--backup-receipt', receipt, '--backup-root', backup.root, '--maintenance', '--partial'], { BRAIN_CONFIG: config })).toBe(0);
    const output = chunks.join('');
    for (const entry of plan.blockers) {
      expect(output).toContain(entry.reason);
      for (const path of entry.paths ?? (entry.path ? [entry.path] : [])) expect(output).toContain(path);
    }
  } finally {
    process.stdout.write = original;
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
      applyVaultMigration(plan, {
        maintenance: true,
        backupReceipt: buildMigrationBackupReceipt(plan.source_fingerprint),
        backupRoot: join(dirname(s.vault), 'backup-media'),
        partial: true,
        clock: FIXED_CLOCK
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  } finally {
    await s.dispose();
  }
});

test('a fabricated or media-less backup receipt is rejected before apply', async () => {
  const { s, plan } = await sandboxPlan();
  try {
    const emptyRoot = join(dirname(s.vault), 'empty-backup');
    await mkdir(emptyRoot, { recursive: true });
    await expect(
      applyVaultMigration(plan, {
        maintenance: true,
        backupReceipt: buildMigrationBackupReceipt(plan.source_fingerprint),
        backupRoot: emptyRoot,
        partial: true,
        clock: FIXED_CLOCK
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    const backup = await makeBackup(s.vault, s.state, plan);
    const tampered = JSON.parse(JSON.stringify(backup.receipt)) as {
      files: { path: string; size: number; sha256: string }[];
    };
    tampered.files[0].sha256 = 'a'.repeat(64);
    await expect(
      applyVaultMigration(plan, {
        maintenance: true,
        backupReceipt: tampered,
        backupRoot: backup.root,
        partial: true,
        clock: FIXED_CLOCK
      })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    await expect(
      applyVaultMigration(plan, {
        maintenance: true,
        backupReceipt: backup.receipt,
        partial: true,
        clock: FIXED_CLOCK
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally {
    await s.dispose();
  }
});

test('backup media cannot resolve through a symlink to the live vault', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    const linked = join(dirname(s.vault), 'linked-backup');
    await mkdir(linked);
    await symlink(s.vault, join(linked, 'vault'));
    await symlink(s.state, join(linked, 'state'));
    await expect(applyVaultMigration(plan, options({ ...backup, root: linked }))).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const changed = join(backup.root, 'vault', plan.source_fingerprint.vault[0].path);
    await writeFile(changed, 'changed backup bytes');
    await expect(applyVaultMigration(plan, options(backup))).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(join(s.vault, plan.source_fingerprint.vault[0].path))).not.toEqual(Buffer.from('changed backup bytes'));
  } finally {
    await s.dispose();
  }
});

test('backup media hardlinked to live bytes is not independent', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    const file = plan.source_fingerprint.vault[0].path;
    const destination = join(backup.root, 'vault', file);
    await rm(destination);
    await link(join(s.vault, file), destination);
    await expect(applyVaultMigration(plan, options(backup))).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  } finally {
    await s.dispose();
  }
});

test('lock conflict is checked before reading stale journal or verifying backup', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    await writeFile(join(s.state, 'gateway.lock'), `${JSON.stringify({ pid: process.pid, start_time: await processStartTime(process.pid) })}\n`);
    await expect(applyVaultMigration(plan, options(backup, { backupRoot: undefined }))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(readFile(join(s.state, 'migrations', plan.manifest_sha256, 'journal.json'))).rejects.toThrow();
  } finally {
    await s.dispose();
  }
});

test('a stale lock cannot be reclaimed while another contender owns takeover', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    await writeFile(join(s.state, 'gateway.lock'), '{"pid":99999999}\n');
    await mkdir(join(s.state, 'gateway.lock.recovery'));
    await expect(applyVaultMigration(plan, options(backup))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(s.state, 'gateway.lock'), 'utf8')).toContain('99999999');
  } finally {
    await s.dispose();
  }
});

test('simultaneous stale-lock contenders produce exactly one owner', async () => {
  const s = await vaultSandbox();
  try {
    await writeFile(join(s.state, 'gateway.lock'), '{"pid":99999999}\n');
    const ready = join(dirname(s.vault), 'ready');
    const go = join(dirname(s.vault), 'go');
    const script = `import { appendFileSync, existsSync } from 'node:fs'; import { InstanceLock } from './src/core/mutation.ts'; const [root,ready,go] = process.argv.slice(1); appendFileSync(ready,'r'); while(!existsSync(go)) await new Promise(r=>setTimeout(r,2)); try { const lock=InstanceLock.acquire(root); console.log('owner'); await new Promise(r=>setTimeout(r,80)); lock.release(); } catch { console.log('conflict'); }`;
    const worker = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, s.state, ready, go], { cwd: process.cwd() });
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
    });
    const results = Array.from({ length: 4 }, () => worker());
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await readFile(ready, 'utf8').catch(() => '')).length === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await readFile(ready, 'utf8')).length).toBe(4);
    await writeFile(go, 'go');
    const outcomes = await Promise.all(results);
    expect(outcomes.filter((outcome) => outcome === 'owner')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'conflict')).toHaveLength(3);
  } finally {
    await s.dispose();
  }
});

async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 1).trim().split(/\s+/u);
    return fields[19];
  } catch {
    return undefined;
  }
}

test('exclusive maintenance mode rejects a live lock holder', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    const start = await processStartTime(process.pid);
    const owner = start === undefined ? { pid: 1 } : { pid: process.pid, start_time: start };
    await writeFile(join(s.state, 'gateway.lock'), `${JSON.stringify(owner)}\n`);
    await expect(applyVaultMigration(plan, options(backup))).rejects.toMatchObject({
      code: 'CONFLICT'
    });
  } finally {
    await s.dispose();
  }
});

test('output exclusions recorded in the manifest keep a state-side manifest out of the fingerprint', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const custom = join(s.state, 'custom-output');
    await mkdir(custom, { recursive: true });
    const plan = await planVaultMigration({
      vault: s.vault,
      state: s.state,
      projectNames: PROJECT_NAMES,
      outputDirectory: custom,
      clock: FIXED_CLOCK
    });
    expect(plan.output_exclusions).toContain(custom);
    await writeFile(join(custom, 'manifest.json'), `${JSON.stringify(plan)}\n`);
    const backup = await makeBackup(s.vault, s.state, plan);
    const result = await applyVaultMigration(plan, options(backup));
    expect(result.status).toBe('applied');
  } finally {
    await s.dispose();
  }
});

test('an unreadable revision blocks its logical note instead of migrating a partial head', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const sibling =
      'Projects/freellmapi/Preferences/7d4e5f60-8192-4da3-8e1f-2a3b4c5d6e7f/broken r11111111-1111-4111-8111-111111111111.md';
    await writeFile(
      join(s.vault, sibling),
      '---\nbrain_id: 7d4e5f60-8192-4da3-8e1f-2a3b4c5d6e7f\nbrain_schema_version: 1\ntype: preference\n---\n\nmissing required fields\n'
    );
    const plan = await planVaultMigration({
      vault: s.vault,
      state: s.state,
      projectNames: PROJECT_NAMES,
      clock: FIXED_CLOCK
    });
    expect(plan.moves.some((move) => move.logical_id === PREFERENCE_ID)).toBe(false);
    const blocked = plan.blockers.find((entry) => entry.id === PREFERENCE_ID);
    expect(blocked).toBeDefined();
    expect(blocked?.paths).toContain(PREFERENCE_PATH);
    expect(blocked?.paths).toContain(sibling);
  } finally {
    await s.dispose();
  }
});

test('invalid UTF-8 managed sibling blocks the entire logical note', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const sibling = 'Projects/freellmapi/Preferences/7d4e5f60-8192-4da3-8e1f-2a3b4c5d6e7f/invalid r11111111-1111-4111-8111-111111111111.md';
    await writeFile(join(s.vault, sibling), Buffer.concat([
      Buffer.from('---\nbrain_id: 7d4e5f60-8192-4da3-8e1f-2a3b4c5d6e7f\nbrain_schema_version: 1\n---\n'),
      Buffer.from([0xff])
    ]));
    const plan = await planVaultMigration({ vault: s.vault, state: s.state, projectNames: PROJECT_NAMES });
    expect(plan.moves.some((entry) => entry.logical_id === PREFERENCE_ID)).toBe(false);
    expect(plan.blockers.find((entry) => entry.id === PREFERENCE_ID)?.paths).toEqual(expect.arrayContaining([PREFERENCE_PATH, sibling]));
  } finally {
    await s.dispose();
  }
});

test('unapproved archived and superseded revisions become candidates', async () => {
  for (const status of ['archived', 'superseded']) {
    const s = await vaultSandbox();
    try {
      await materialize(s.vault);
      const raw = await readFile(join(s.vault, PREFERENCE_PATH), 'utf8');
      await writeFile(join(s.vault, PREFERENCE_PATH), raw.replace(/brain_status: \w+/, `brain_status: ${status}`).replace(/^brain_(?:approved_by|approval_[^:\n]+):[^\n]*\n/gm, ''));
      const plan = await planVaultMigration({ vault: s.vault, state: s.state, projectNames: PROJECT_NAMES });
      expect(plan.moves.find((entry) => entry.logical_id === PREFERENCE_ID)?.status).toBe('candidate');
    } finally {
      await s.dispose();
    }
  }
});

test('an invalid approval payload is materialized as an unreviewed candidate', async () => {
  const s = await vaultSandbox();
  try {
    await materialize(s.vault);
    const raw = await readFile(join(s.vault, PREFERENCE_PATH), 'utf8');
    const tampered = raw.replace(
      /brain_approval_payload_hash: [a-f0-9]{64}/,
      `brain_approval_payload_hash: ${'a1b2c3d4'.repeat(8)}`
    );
    expect(tampered).not.toBe(raw);
    await writeFile(join(s.vault, PREFERENCE_PATH), tampered);
    const plan = await planVaultMigration({
      vault: s.vault,
      state: s.state,
      projectNames: PROJECT_NAMES,
      clock: FIXED_CLOCK
    });
    const move = plan.moves.find((entry) => entry.logical_id === PREFERENCE_ID);
    expect(move?.status).toBe('candidate');
    expect(move?.approval_preserved).toBe(true);
    expect(move?.approval_valid).toBe(false);
  } finally {
    await s.dispose();
  }
});

test('rollback refuses after a human edit and otherwise restores the source vault', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    await applyVaultMigration(plan, options(backup));
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

test('rollback refuses new unrelated files without removing migrated notes', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    await applyVaultMigration(plan, options(backup));
    await writeFile(join(s.vault, 'Knowledge/New human note.md'), '# New\n');
    await expect(
      rollbackVaultMigration(plan, { maintenance: true, clock: FIXED_CLOCK })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const move of plan.moves) {
      await readFile(join(s.vault, move.current_path));
    }
  } finally {
    await s.dispose();
  }
});

test('rollback preflights lost history before removing any migrated note', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    await applyVaultMigration(plan, options(backup));
    await writeFile(join(s.state, plan.history_copies[0].destination_path), 'corrupted');
    await expect(
      rollbackVaultMigration(plan, { maintenance: true, clock: FIXED_CLOCK })
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    for (const move of plan.moves) {
      await readFile(join(s.vault, move.current_path));
    }
  } finally {
    await s.dispose();
  }
});

test('restarted rollback rechecks history and every already restored source', async () => {
  for (const damage of ['history', 'restored']) {
    const { s, plan, backup } = await sandboxPlan();
    try {
      await applyVaultMigration(plan, options(backup));
      const copy = plan.history_copies[0];
      const source = join(s.vault, copy.source_path);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, await readFile(join(s.state, copy.destination_path)));
      const journalPath = join(s.state, 'migrations', plan.manifest_sha256, 'journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.rollback = { status: 'running', updated_at: FIXED_CLOCK.now().toISOString(), restored_sources: [copy.source_path], restored_rewrites: [], removed_current: [] };
      await writeFile(journalPath, JSON.stringify(journal));
      await writeFile(damage === 'history' ? join(s.state, copy.destination_path) : source, 'corrupted');
      await expect(rollbackVaultMigration(plan, { maintenance: true })).rejects.toMatchObject({ code: damage === 'history' ? 'RECOVERY_REQUIRED' : 'CONFLICT' });
      for (const move of plan.moves) await readFile(join(s.vault, move.current_path));
    } finally {
      await s.dispose();
    }
  }
});

test('restarted rollback refuses changed or removed preserved files before mutating', async () => {
  for (const damage of ['changed', 'removed']) {
    const { s, plan, backup } = await sandboxPlan();
    try {
      await applyVaultMigration(plan, options(backup));
      const journalPath = join(s.state, 'migrations', plan.manifest_sha256, 'journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      journal.rollback = { status: 'running', updated_at: FIXED_CLOCK.now().toISOString(), restored_sources: [], restored_rewrites: [], removed_current: [] };
      await writeFile(journalPath, JSON.stringify(journal));
      const preserved = join(s.vault, plan.preserved_files[0].path);
      if (damage === 'changed') await writeFile(preserved, 'edited');
      else await rm(preserved);
      await expect(rollbackVaultMigration(plan, { maintenance: true })).rejects.toMatchObject({ code: 'CONFLICT' });
      for (const move of plan.moves) await readFile(join(s.vault, move.current_path));
    } finally {
      await s.dispose();
    }
  }
});

test('restarted rollback accepts a verified journaled restoration and completes', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    const before = await inventoryTree(s.vault);
    await applyVaultMigration(plan, options(backup));
    const first = plan.history_copies[0];
    const path = join(s.vault, first.source_path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await readFile(join(s.state, first.destination_path)));
    const journalPath = join(s.state, 'migrations', plan.manifest_sha256, 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.rollback = { status: 'running', updated_at: FIXED_CLOCK.now().toISOString(), restored_sources: [first.source_path], restored_rewrites: [], removed_current: [] };
    await writeFile(journalPath, JSON.stringify(journal));
    expect((await rollbackVaultMigration(plan, { maintenance: true })).status).toBe('rolled_back');
    expect(await inventoryTree(s.vault)).toEqual(before);
  } finally {
    await s.dispose();
  }
});

test('rollback restores every original source file and removes generated notes', async () => {
  const { s, plan, backup } = await sandboxPlan();
  try {
    const before = await inventoryTree(s.vault);
    await applyVaultMigration(plan, options(backup));
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
