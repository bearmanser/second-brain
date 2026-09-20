import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORK_ROOT = '/tmp/opencode';
const COPY_ITEMS = [
  'Dockerfile',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'compose.yaml',
  '.env.example',
  'src',
  'scripts',
  'config'
] as const;
const SUITE_TIMEOUT = 2_400_000;
const NOTE_TITLE = 'Operations integration lesson';

let workDir = '';
let project = '';
let brainPort = 0;
let vaultPath = '';
let backupDir = '';
let nodeImage = '';
let memoryImage = '';
let token = '';
let client: Client | undefined;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    NODE_IMAGE: nodeImage,
    BASIC_MEMORY_IMAGE: memoryImage,
    VAULT_PATH: vaultPath,
    BRAIN_PORT: String(brainPort),
    ...extra
  };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}
): { status: number | null; stdout: string; stderr: string } {
  const spawnOptions: SpawnSyncOptions = {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    cwd: options.cwd ?? workDir,
    env: options.env ?? env()
  };
  const result = spawnSync(command, args, spawnOptions);
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}\n${stdout}\n${stderr}`);
  }
  return { status: result.status, stdout, stderr };
}

function composeArgs(extra: string[]): string[] {
  return ['compose', '-p', project, '-f', 'compose.yaml', ...extra];
}

function compose(extra: string[], allowFailure = false): { status: number | null; stdout: string } {
  return run('docker', composeArgs(extra), { allowFailure });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not allocate a free port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const result = run(
      'docker',
      composeArgs(['exec', '-T', 'brain', 'node', 'dist/cli.js', 'health']),
      { allowFailure: true }
    );
    if (result.status === 0) return;
    last = `${result.stdout}${result.stderr}`;
    await sleep(5_000);
  }
  throw new Error(`the gateway never reported healthy: ${last}`);
}

async function connect(): Promise<Client> {
  const connected = new Client({ name: 'second-brain-operations', version: '1.0.0' });
  await connected.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${brainPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  return connected;
}

function manifestOf(root: string): {
  format_version: number;
  stores: string[];
  volumes: Record<string, string>;
  files: { path: string }[];
  sensitive: boolean;
} {
  const parsed: unknown = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  return parsed as {
    format_version: number;
    stores: string[];
    volumes: Record<string, string>;
    files: { path: string }[];
    sensitive: boolean;
  };
}

beforeAll(async () => {
  run('docker', ['version', '--format', '{{.Server.Version}}'], { cwd: REPO_ROOT });

  for (const line of readFileSync(join(REPO_ROOT, 'config/images.env'), 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key === 'NODE_IMAGE') nodeImage = rest.join('=');
    if (key === 'BASIC_MEMORY_IMAGE') memoryImage = rest.join('=');
  }
  expect(nodeImage).toContain('@sha256:');
  expect(memoryImage).toContain('@sha256:');

  workDir = mkdtempSync(join(WORK_ROOT, 'brain-ops-'));
  project = `brainops${process.pid}`;
  brainPort = await freePort();
  vaultPath = join(workDir, 'ops-vault');
  backupDir = join(workDir, 'cold-backup');
  for (const item of COPY_ITEMS) {
    cpSync(join(REPO_ROOT, item), join(workDir, item), { recursive: true });
  }

  run('bash', ['scripts/setup.sh'], { cwd: workDir, env: env({ VAULT_PATH: vaultPath }) });
  compose(['up', '-d', '--build']);
  await waitForHealth(900_000);

  token = readFileSync(join(workDir, 'secrets/brain-token'), 'utf8').trim();
  client = await connect();
  const captured = await client.callTool({
    name: 'brain_capture',
    arguments: {
      idempotency_key: randomUUID(),
      scope: 'freellmapi',
      note: {
        title: NOTE_TITLE,
        tags: ['operations'],
        content: {
          kind: 'lesson',
          situation: 'A disposable stack is used to exercise backup, restore, and rebuild.',
          lesson: 'Cold backups must be restorable and index rebuilds must preserve the journal.',
          applicability: 'Operations integration verification'
        },
        evidence: [
          { kind: 'observation', ref: 'ops-e2e', description: 'disposable Compose project' }
        ],
        related_ids: []
      }
    }
  });
  const structured = (captured as { structuredContent?: { materialized?: boolean } }).structuredContent;
  expect(structured?.materialized).toBe(true);

  run('bash', ['scripts/backup.sh', backupDir, '--yes'], {
    cwd: workDir,
    env: env({ VAULT_PATH: vaultPath })
  });
}, SUITE_TIMEOUT);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    undefined;
  }
  try {
    run('docker', composeArgs(['down', '-v', '--remove-orphans']), { allowFailure: true });
  } catch {
    undefined;
  }
  for (const candidate of [project, `${project}restore`, `${project}fake`]) {
    run('docker', ['compose', '-p', candidate, 'down', '-v', '--remove-orphans'], {
      allowFailure: true
    });
    for (const name of ['brain-state', 'memory-state', 'model-cache']) {
      run('docker', ['volume', 'rm', '-f', `${candidate}_${name}`], { allowFailure: true });
    }
    run('docker', ['image', 'rm', '-f', `${candidate}-brain`], { allowFailure: true });
  }
  if (workDir.length > 0) rmSync(workDir, { recursive: true, force: true });
}, SUITE_TIMEOUT);

describe('disposable Compose operations', () => {
  test('backup.sh archives the vault and volumes with a stable Compose-key mapping', async () => {
    const manifest = manifestOf(backupDir);
    expect(manifest.format_version).toBe(1);
    expect(manifest.stores).toEqual(
      expect.arrayContaining(['vault', 'brain-state', 'memory-state'])
    );
    expect(manifest.stores).not.toContain('model-cache');
    expect(manifest.volumes['brain-state']).toBe(`${project}_brain-state`);
    expect(manifest.volumes['memory-state']).toBe(`${project}_memory-state`);
    expect(manifest.volumes['model-cache']).toBeUndefined();
    expect(manifest.sensitive).toBe(false);
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toContain('vault.tar');
    expect(paths).toContain('volumes/brain-state.tar');
    expect(paths).not.toContain('volumes/model-cache.tar');
    expect(paths).not.toContain('secrets.tar');
    expect(existsSync(join(backupDir, 'checksums.sha256'))).toBe(true);

    await waitForHealth(300_000);
  }, 600_000);

  test('restore.sh --check validates and extracts volumes by logical key', () => {
    const restored = join(workDir, 'restored');
    const checked = run('bash', ['scripts/restore.sh', backupDir, restored, '--check'], {
      cwd: workDir
    });
    expect(checked.stdout).toMatch(/ok/i);

    const extracted = run('bash', ['scripts/restore.sh', backupDir, restored, '--acknowledge'], {
      cwd: workDir
    });
    expect(extracted.status).toBe(0);
    expect(existsSync(join(restored, 'volumes', 'brain-state', 'journal.db'))).toBe(true);
    expect(existsSync(join(restored, 'vault'))).toBe(true);
  }, 300_000);

  test('restore.sh --start boots the restored stack under a separate project and port', async () => {
    const restored = join(workDir, 'restored-start');
    const port = await freePort();
    const started = run(
      'bash',
      [
        'scripts/restore.sh',
        backupDir,
        restored,
        '--acknowledge',
        '--start',
        '--project',
        `${project}restore`,
        '--port',
        String(port)
      ],
      { cwd: workDir }
    );
    expect(started.status).toBe(0);
    expect(`${started.stdout}${started.stderr}`).toMatch(/healthy on port/);
  }, 900_000);

  test('rebuild.sh pauses, reindexes, rebuilds the catalogue, and preserves the journal', async () => {
    const rebuilt = run('bash', ['scripts/rebuild.sh', '--acknowledge', '--search'], {
      cwd: workDir,
      env: env({ VAULT_PATH: vaultPath, BRAIN_REBUILD_ACKNOWLEDGE: 'yes' })
    });
    expect(rebuilt.status).toBe(0);
    expect(`${rebuilt.stdout}${rebuilt.stderr}`).toMatch(/rebuilding the gateway catalogue/);
    expect(`${rebuilt.stdout}${rebuilt.stderr}`).toMatch(/capturing the pre-rebuild journal and feedback state/);
    expect(`${rebuilt.stdout}${rebuilt.stderr}`).toMatch(/rows are byte-for-byte unchanged/);
    expect(`${rebuilt.stdout}${rebuilt.stderr}`).toMatch(/NOT full operational recovery/);
    await waitForHealth(300_000);
  }, 900_000);

  test('rebuild.sh refuses without acknowledgment, refuses a missing journal, and completes an acknowledged loss', async () => {
    const noAck = run('bash', ['scripts/rebuild.sh', '--search'], {
      cwd: workDir,
      env: env({ VAULT_PATH: vaultPath }),
      allowFailure: true
    });
    expect(noAck.status).not.toBe(0);
    expect(`${noAck.stdout}${noAck.stderr}`).toMatch(/acknowledg/i);

    const fakeProject = `${project}fake`;
    run('docker', [
      'volume',
      'create',
      '--label',
      `com.docker.compose.project=${fakeProject}`,
      '--label',
      'com.docker.compose.volume=brain-state',
      `${fakeProject}_brain-state`
    ]);
    const missing = run(
      'bash',
      ['scripts/rebuild.sh', '--project', fakeProject, '--acknowledge', '--search'],
      { cwd: workDir, env: env({ VAULT_PATH: vaultPath }), allowFailure: true }
    );
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).toMatch(/restore it from a backup/);

    compose(['stop', 'brain']);
    run('docker', [
      'run',
      '--rm',
      '--user',
      '0:0',
      '-v',
      `${project}_brain-state:/state`,
      nodeImage,
      'sh',
      '-c',
      'rm -f /state/journal.db /state/journal.db-wal /state/journal.db-shm'
    ]);
    const accepted = run(
      'bash',
      ['scripts/rebuild.sh', '--acknowledge', '--accept-operational-loss', '--search'],
      { cwd: workDir, env: env({ VAULT_PATH: vaultPath }), allowFailure: true }
    );
    expect(accepted.status, `${accepted.stdout}${accepted.stderr}`).toBe(0);
    expect(`${accepted.stdout}${accepted.stderr}`).toMatch(/operational loss was explicitly accepted/);
    expect(`${accepted.stdout}${accepted.stderr}`).toMatch(/freshly initialized operation journal/);
    expect(`${accepted.stdout}${accepted.stderr}`).toMatch(/not full operational recovery/);

    compose(['up', '-d', 'brain']);
    await waitForHealth(300_000);
  }, 900_000);

  test('backup.sh refuses to archive a vault containing a symbolic link', async () => {
    const symlink = join(vaultPath, 'outside-link');
    symlinkSync('/etc', symlink);
    try {
      const result = run(
        'bash',
        ['scripts/backup.sh', join(workDir, 'symlink-backup'), '--yes'],
        { cwd: workDir, env: env({ VAULT_PATH: vaultPath }), allowFailure: true }
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/symbolic link/);
      expect(`${result.stdout}${result.stderr}`).toContain('outside-link');
    } finally {
      rmSync(symlink, { force: true });
    }
    await waitForHealth(300_000);
  }, 300_000);

  test('a corrupt cold backup is rejected', () => {
    const corrupt = join(workDir, 'corrupt-backup');
    cpSync(backupDir, corrupt, { recursive: true });
    const manifest = manifestOf(corrupt);
    const vaultEntry = manifest.files.find((file) => file.path === 'vault.tar');
    expect(vaultEntry).toBeDefined();
    run('bash', ['-c', `printf 'tamper' >> "${join(corrupt, 'vault.tar')}"`], { cwd: workDir });
    const rejected = run(
      'bash',
      ['scripts/restore.sh', corrupt, join(workDir, 'corrupt-restore'), '--check'],
      { cwd: workDir, allowFailure: true }
    );
    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toMatch(/checksum|verifier/i);
  }, 300_000);
});
