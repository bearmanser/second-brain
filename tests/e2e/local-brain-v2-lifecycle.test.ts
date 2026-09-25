import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, expect, test } from 'vitest';
import fixtureJson from '../fixtures/vault-v2/manifest-cases.json' with { type: 'json' };
import { runCli } from '../../src/cli.js';
import { loadConfig } from '../../src/config/load.js';
import { createRuntime, type BrainRuntime } from '../../src/runtime.js';
import { buildMigrationBackupReceipt, type SourceFingerprint } from '../../src/operations/vault-v2/plan.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const SCOPE = 'freellmapi';
const PROJECT_DISPLAY = 'FreeLLM API';
const PROJECTS_FLAG = `${SCOPE}=${PROJECT_DISPLAY}`;
const PROJECT_ROOT = `Projects/${PROJECT_DISPLAY}`;
const FORK_ID = '0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const FORK_LEGACY_SOURCE = 'Projects/freellmapi/Lessons/0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d/Latency observations r5b2c3d4e-6f70-4b81-9c9d-0e1f2a3b4c5d.md';
const PREFERENCE_ID = '7d4e5f60-8192-4da3-8e1f-2a3b4c5d6e7f';
const EXPECTED_PREFERENCE_PATH = `${PROJECT_ROOT}/Preferences/Prefer local notes.md`;
const NORWEGIAN_ID = '9f607182-a3b4-4fc5-803b-4c5d6e7f8091';
const NORWEGIAN_SOURCE = `${PROJECT_ROOT}/Notes/Læring fra feilsøking.md`;
const NORWEGIAN_RENAMED = `${PROJECT_ROOT}/Notes/Læring fra feilsøking (renamed).md`;
const HUMAN_NOTE = 'Knowledge/Human note.md';
const SUITE_TIMEOUT = 600_000;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ManifestFileFixture {
  path: string;
  bytes: number;
  sha256: string;
  base64: string;
}

const fixture = fixtureJson as unknown as { files: ManifestFileFixture[] };

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');

const roots: string[] = [];
const runtimes: BrainRuntime[] = [];
const clients: Client[] = [];

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function materializeV1(vault: string): Promise<void> {
  for (const entry of fixture.files) {
    const destination = join(vault, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(entry.base64, 'base64'));
  }
}

async function writeConfig(path: string, vault: string, state: string, cursor: string): Promise<void> {
  const lines = [
    'endpoint: http://127.0.0.1:7331/mcp',
    'port: 7331',
    'mounts:',
    `  vault: ${vault}`,
    `  state: ${state}`,
    `cursor_secret_file: ${cursor}`,
    'allowed_hosts:',
    '  - 127.0.0.1',
    'allowed_origins: []',
    'scopes:',
    `  - id: ${SCOPE}`,
    '    backend_project: freellmapi',
    `    relative_root: ${PROJECT_ROOT}`,
    '    repository_aliases:',
    '      - freellmapi',
    'result_delivery: structured',
    'search_mode: text',
    'search_fallback_only: false',
    'laya:',
    '  enabled: false',
    '  python: python3',
    '  threads: 2',
    '  batch_size: 8',
    '  queue_batches: 4',
    '  timeout_ms: 4000',
    ''
  ];
  await writeFile(path, lines.join('\n'), 'utf8');
}

interface ManifestShape {
  manifest_sha256: string;
  moves: { logical_id: string; current_path: string }[];
  blockers: { kind: string; id?: string; reason: string }[];
  source_fingerprint: SourceFingerprint;
}

async function copyMigrationBackup(
  fingerprint: SourceFingerprint,
  vault: string,
  state: string,
  backupRoot: string
): Promise<void> {
  for (const file of fingerprint.vault) {
    const destination = join(backupRoot, 'vault', file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(vault, file.path), destination);
  }
  for (const file of fingerprint.state) {
    const destination = join(backupRoot, 'state', file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(state, file.path), destination);
  }
}

async function startBrain(configPath: string, token: string): Promise<BrainRuntime> {
  const loaded = loadConfig(configPath);
  const runtime = await createRuntime(
    { ...loaded, mounts: { ...loaded.mounts }, port: 0 },
    { token_digest: digest(token), logger: () => undefined }
  );
  runtimes.push(runtime);
  return runtime;
}

async function connect(runtime: BrainRuntime, token: string, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(runtime.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  clients.push(client);
  return client;
}

function structured(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) return {};
  const content = (result as { structuredContent?: unknown }).structuredContent;
  return typeof content === 'object' && content !== null
    ? (content as Record<string, unknown>)
    : {};
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function notePayload(title: string, marker: string): Record<string, unknown> {
  return {
    idempotency_key: randomUUID(),
    scope: SCOPE,
    note: {
      title,
      tags: ['lifecycle'],
      content: {
        kind: 'lesson',
        situation: `Lifecycle scenario for ${title}`,
        lesson: marker,
        applicability: 'Task 19 release verification'
      },
      evidence: [
        {
          kind: 'observation',
          ref: 'tests/e2e/local-brain-v2-lifecycle.test.ts',
          description: 'release lifecycle'
        }
      ],
      related_ids: []
    }
  };
}

interface CaptureReceipt {
  id: string;
  revision_id: string;
  etag: string;
  operation_id: string;
  idempotency_key: string;
  title: string;
  marker: string;
}

async function capture(client: Client, payload: Record<string, unknown>): Promise<CaptureReceipt> {
  const result = await client.callTool({ name: 'brain_capture', arguments: payload });
  expect(isError(result), JSON.stringify(result)).toBe(false);
  const body = structured(result);
  expect(typeof body.id).toBe('string');
  expect(typeof body.revision_id).toBe('string');
  expect(typeof body.etag).toBe('string');
  const note = payload.note as { title: string; content: { lesson: string } };
  return {
    id: body.id as string,
    revision_id: body.revision_id as string,
    etag: body.etag as string,
    operation_id: body.operation_id as string,
    idempotency_key: payload.idempotency_key as string,
    title: note.title,
    marker: note.content.lesson
  };
}

async function runSevenTools(client: Client, suffix: string): Promise<CaptureReceipt> {
  const ensured = await client.callTool({
    name: 'brain_project_ensure',
    arguments: {
      idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/orbit-notes.git'
    }
  });
  expect(isError(ensured), JSON.stringify(ensured)).toBe(false);
  expect(structured(ensured).project_id).toBe('orbit-notes');

  const receipt = await capture(client, notePayload(`Lifecycle note ${suffix}`, `Marker ${suffix} proves the local write path.`));

  const approved = await client.callTool({
    name: 'brain_review',
    arguments: {
      scope: SCOPE,
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id: receipt.id,
        expected_etag: receipt.etag,
        rationale: 'Lifecycle approval'
      }
    }
  });
  expect(isError(approved), JSON.stringify(approved)).toBe(false);

  const recalled = await client.callTool({
    name: 'brain_recall',
    arguments: { scope: SCOPE, query: receipt.marker, include_candidates: true }
  });
  expect(isError(recalled), JSON.stringify(recalled)).toBe(false);
  const items = structured(recalled).items as { id?: string }[] | undefined;
  expect(Array.isArray(items)).toBe(true);
  expect((items ?? []).some((item) => item.id === receipt.id)).toBe(true);

  const read = await client.callTool({ name: 'brain_read', arguments: { scope: SCOPE, id: receipt.id } });
  expect(isError(read), JSON.stringify(read)).toBe(false);
  expect(String(structured(read).markdown)).toContain(receipt.marker);

  const feedback = await client.callTool({
    name: 'brain_feedback',
    arguments: {
      idempotency_key: randomUUID(),
      scope: SCOPE,
      id: receipt.id,
      revision_id: receipt.revision_id,
      verdict: 'useful',
      reason: 'Lifecycle smoke feedback'
    }
  });
  expect(isError(feedback), JSON.stringify(feedback)).toBe(false);

  const status = await client.callTool({ name: 'brain_status', arguments: {} });
  expect(isError(status), JSON.stringify(status)).toBe(false);
  const health = structured(status).health as { gateway?: string; worker?: string } | undefined;
  expect(health?.gateway).toBe('ready');
  expect(health?.worker).toBe('disabled');

  return receipt;
}

async function toolNames(client: Client): Promise<string[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => tool.name).sort();
}

async function hashTree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const rel = relative(root, absolute).split(sep).join('/');
      const buffer = await readFile(absolute);
      hashes.set(rel, createHash('sha256').update(buffer).digest('hex'));
    }
  };
  await walk(root);
  return hashes;
}

function walkPaths(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  walk(root);
  return found;
}

test(
  'a disposable V1 vault migrates and survives the full local V2 lifecycle',
  async () => {
    const sandbox = await vaultSandbox();
    roots.push(dirname(sandbox.vault));
    const vault = sandbox.vault;
    const state = sandbox.state;
    const root = dirname(vault);
    const configPath = join(root, 'brain.yaml');
    const cursorPath = join(root, 'cursor.key');
    await writeFile(cursorPath, randomBytes(48));
    await writeConfig(configPath, vault, state, cursorPath);

    await materializeV1(vault);

    const inspectionPath = join(root, 'inspection.json');
    expect(
      await runCli(['vault-v2', 'inspect', '--report', inspectionPath, '--projects', PROJECTS_FLAG], {
        BRAIN_CONFIG: configPath
      })
    ).toBe(0);
    const inspection = JSON.parse(await readFile(inspectionPath, 'utf8')) as { moves?: unknown[] };
    expect(Array.isArray(inspection.moves)).toBe(true);

    const manifestPath = join(root, 'manifest.json');
    expect(
      await runCli(['vault-v2', 'plan', '--output', manifestPath, '--projects', PROJECTS_FLAG], {
        BRAIN_CONFIG: configPath
      })
    ).toBe(0);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ManifestShape;
    expect(manifest.moves.some((move) => move.logical_id === NORWEGIAN_ID)).toBe(true);
    expect(manifest.moves.some((move) => move.logical_id === PREFERENCE_ID)).toBe(true);
    const fork = manifest.blockers.find((entry) => entry.kind === 'fork' && entry.id === FORK_ID);
    expect(fork?.reason).toBeTruthy();

    const backupRoot = join(root, 'backup');
    await copyMigrationBackup(manifest.source_fingerprint, vault, state, backupRoot);
    const receiptPath = join(root, 'backup-receipt.json');
    await writeFile(receiptPath, JSON.stringify(buildMigrationBackupReceipt(manifest.source_fingerprint)), 'utf8');

    expect(
      await runCli(
        [
          'vault-v2',
          'apply',
          '--manifest',
          manifestPath,
          '--backup-receipt',
          receiptPath,
          '--backup-root',
          backupRoot,
          '--maintenance',
          '--partial'
        ],
        { BRAIN_CONFIG: configPath }
      )
    ).toBe(0);
    expect(
      await runCli(['vault-v2', 'verify', '--manifest', manifestPath], { BRAIN_CONFIG: configPath })
    ).toBe(0);

    expect(existsSync(join(vault, EXPECTED_PREFERENCE_PATH))).toBe(true);
    expect(existsSync(join(vault, NORWEGIAN_SOURCE))).toBe(true);
    expect((await readdir(join(state, 'history'))).length).toBeGreaterThan(0);
    for (const move of manifest.moves) {
      for (const segment of move.current_path.split('/')) {
        const stem = segment.endsWith('.md') ? segment.slice(0, -3) : segment;
        expect(UUID_SEGMENT.test(stem), `${move.current_path} still contains a UUID segment`).toBe(false);
      }
    }
    expect(walkPaths(vault).some((path) => path.includes('/0b8f1c2d-'))).toBe(true);
    expect(existsSync(join(vault, FORK_LEGACY_SOURCE))).toBe(true);
    const humanNote = await readFile(join(vault, HUMAN_NOTE), 'utf8');
    expect(humanNote).toContain('A note written by hand');
    expect(humanNote).toContain('../Attachments/diagram.png');
    expect(existsSync(join(vault, 'Attachments/diagram.png'))).toBe(true);
    expect(existsSync(join(vault, '.obsidian/app.json'))).toBe(true);
    const migratedPreference = await readFile(join(vault, EXPECTED_PREFERENCE_PATH), 'utf8');
    expect(migratedPreference).toContain(`id: ${PREFERENCE_ID}`);
    expect(migratedPreference).toContain('Prefer local notes to remote lookup.');
    expect(migratedPreference).toContain('status: active');

    expect(
      await runCli(['rebuild-catalogue', '--accept-operational-loss'], { BRAIN_CONFIG: configPath })
    ).toBe(0);
    expect(existsSync(join(state, 'journal.db'))).toBe(true);

    const tokenA = secret();
    const tokenB = secret();
    let runtime = await startBrain(configPath, tokenA);
    const clientA = await connect(runtime, tokenA, 'lifecycle-a');

    const expectedTools = [
      'brain_capture',
      'brain_feedback',
      'brain_project_ensure',
      'brain_read',
      'brain_recall',
      'brain_review',
      'brain_status'
    ];
    expect(await toolNames(clientA)).toEqual(expectedTools);

    const firstPass = await runSevenTools(clientA, 'first');

    await writeFile(
      join(vault, EXPECTED_PREFERENCE_PATH),
      `${migratedPreference}\n\n## Human observations\n\nA manual Obsidian edit that must survive.\n`,
      'utf8'
    );
    await writeFile(
      join(vault, NORWEGIAN_RENAMED),
      await readFile(join(vault, NORWEGIAN_SOURCE), 'utf8'),
      'utf8'
    );
    await rm(join(vault, NORWEGIAN_SOURCE));

    runtime.rotateTokenDigest(digest(tokenB));
    await expect(toolNames(clientA)).rejects.toThrow();

    const clientB = await connect(runtime, tokenB, 'lifecycle-b');
    expect(await toolNames(clientB)).toEqual(expectedTools);
    const secondPass = await runSevenTools(clientB, 'second');

    const statusRotated = await clientB.callTool({ name: 'brain_status', arguments: {} });
    expect(structured(statusRotated).health).toMatchObject({ worker: 'disabled', gateway: 'ready' });
    const recallRotated = await clientB.callTool({
      name: 'brain_recall',
      arguments: { scope: SCOPE, query: secondPass.marker, include_candidates: true }
    });
    expect(structured(recallRotated).mode).toBe('text');

    const beforeRebuild = await hashTree(vault);
    await runtime.close();

    expect(
      await runCli(['rebuild-index', '--vault', vault, '--state', state], { BRAIN_CONFIG: configPath })
    ).toBe(0);

    runtime = await startBrain(configPath, tokenB);
    const clientC = await connect(runtime, tokenB, 'lifecycle-c');
    expect(await toolNames(clientC)).toEqual(expectedTools);

    expect(await hashTree(vault)).toEqual(beforeRebuild);

    const readLesson = await clientC.callTool({ name: 'brain_read', arguments: { scope: SCOPE, id: PREFERENCE_ID } });
    expect(isError(readLesson), JSON.stringify(readLesson)).toBe(false);
    expect(String(structured(readLesson).markdown)).toContain('A manual Obsidian edit that must survive.');
    expect((structured(readLesson).source as { relative_path?: string }).relative_path).toBe(EXPECTED_PREFERENCE_PATH);

    const readNorwegian = await clientC.callTool({
      name: 'brain_read',
      arguments: { scope: SCOPE, id: NORWEGIAN_ID }
    });
    expect(isError(readNorwegian), JSON.stringify(readNorwegian)).toBe(false);
    expect((structured(readNorwegian).source as { relative_path?: string }).relative_path).toBe(NORWEGIAN_RENAMED);
    expect(String(structured(readNorwegian).markdown)).toContain('Do not remove this handwritten section.');

    const replay = await clientC.callTool({
      name: 'brain_capture',
      arguments: {
        idempotency_key: firstPass.idempotency_key,
        scope: SCOPE,
        note: {
          title: firstPass.title,
          tags: ['lifecycle'],
          content: {
            kind: 'lesson',
            situation: `Lifecycle scenario for ${firstPass.title}`,
            lesson: firstPass.marker,
            applicability: 'Task 19 release verification'
          },
          evidence: [
            {
              kind: 'observation',
              ref: 'tests/e2e/local-brain-v2-lifecycle.test.ts',
              description: 'release lifecycle'
            }
          ],
          related_ids: []
        }
      }
    });
    expect(isError(replay), JSON.stringify(replay)).toBe(false);
    expect(structured(replay).id).toBe(firstPass.id);
    expect(structured(replay).revision_id).toBe(firstPass.revision_id);
    expect(structured(replay).operation_id).toBe(firstPass.operation_id);

    expect(walkPaths(vault).filter((path) => path.includes(firstPass.title))).toHaveLength(1);
    expect(secondPass.id).not.toBe(firstPass.id);
    expect(secondPass.operation_id).not.toBe(firstPass.operation_id);
  },
  SUITE_TIMEOUT
);
