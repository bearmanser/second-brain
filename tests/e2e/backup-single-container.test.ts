import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  'workers',
  'config'
] as const;
const SUITE_TIMEOUT = 2_400_000;
const LIVE = process.env.BRAIN_E2E_LIVE !== '0';

const readText = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

const imageReference = (name: string): string => {
  for (const line of readText('config/images.env').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key === name) return rest.join('=');
  }
  throw new Error(`config/images.env has no ${name}`);
};

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

let workDir = '';
let project = '';
let vaultPath = '';
let backupDir = '';
let brainPort = 0;
let nodeImage = '';
let pythonImage = '';

function hostRuntimeIdentity(): NodeJS.ProcessEnv {
  if (process.env.BRAIN_UID !== undefined || process.env.BRAIN_GID !== undefined) return {};
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return {};
  const uid = process.getuid();
  if (uid === 0) return {};
  return { BRAIN_UID: String(uid), BRAIN_GID: String(process.getgid()) };
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    NODE_IMAGE: nodeImage,
    PYTHON_IMAGE: pythonImage,
    VAULT_PATH: vaultPath,
    BRAIN_PORT: String(brainPort),
    ...hostRuntimeIdentity(),
    ...extra
  };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  const result = runCapture(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

function runCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): { status: number | null; stdout: string; stderr: string } {
  const spawnOptions: SpawnSyncOptions = {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? env()
  };
  const result = spawnSync(command, args, spawnOptions);
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? '')
  };
}

function compose(args: string[]): string {
  return run('docker', ['compose', '-p', project, '-f', 'compose.yaml', ...args], { cwd: workDir });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const result = runCapture(
      'docker',
      ['compose', '-p', project, '-f', 'compose.yaml', 'exec', '-T', 'brain', 'node', 'dist/cli.js', 'health'],
      { cwd: workDir }
    );
    if (result.status === 0) return;
    last = `${result.stdout}${result.stderr}`;
    await sleep(5_000);
  }
  throw new Error(`the single container never reported healthy: ${last}`);
}

beforeAll(async () => {
  if (!LIVE) return;
  run('docker', ['version', '--format', '{{.Server.Version}}']);
  nodeImage = imageReference('NODE_IMAGE');
  pythonImage = imageReference('PYTHON_IMAGE');
  expect(nodeImage).toContain('@sha256:');
  expect(pythonImage).toContain('@sha256:');
  project = `brainbackup${process.pid}`;
  brainPort = await freePort();
  workDir = mkdtempSync(join(WORK_ROOT, 'brain-backup-'));
  vaultPath = join(workDir, 'vault');
  backupDir = join(workDir, 'cold-backup');
  for (const item of COPY_ITEMS) {
    cpSync(join(REPO_ROOT, item), join(workDir, item), { recursive: true });
  }
  rmSync(join(workDir, 'config', 'brain.yaml'), { force: true });
  run('bash', ['scripts/setup.sh'], { cwd: workDir });
  writeFileSync(
    join(vaultPath, 'backup-canary.md'),
    '# Backup canary\n\nThe cold backup must archive this note.\n',
    'utf8'
  );
  compose(['up', '-d', '--build']);
  await waitForHealth(1_200_000);
}, SUITE_TIMEOUT);

afterAll(async () => {
  if (!LIVE || workDir.length === 0) return;
  try {
    compose(['down', '-v', '--remove-orphans']);
  } catch {}
  spawnSync('docker', ['volume', 'rm', `${project}_brain-state`], { encoding: 'utf8' });
  spawnSync('docker', ['image', 'rm', `${project}-brain`], { encoding: 'utf8' });
  rmSync(workDir, { recursive: true, force: true });
}, SUITE_TIMEOUT);

describe.skipIf(!LIVE)(
  'scripts/backup.sh against the single-container Compose stack',
  () => {
    test('cold backup stops only the brain service, archives the single-container stores, and restarts it', async () => {
      const result = runCapture(
        'bash',
        ['scripts/backup.sh', backupDir, '--yes', '--project', project],
        { cwd: workDir }
      );
      const combined = `${result.stdout}${result.stderr}`;

      expect(combined, combined).not.toMatch(/no such service/i);
      expect(combined).toMatch(/stopping the brain service/);
      expect(combined).toMatch(/restarting the brain service via the exit trap/);
      expect(result.status, combined).toBe(0);

      const manifest = manifestOf(backupDir);
      expect(manifest.format_version).toBe(1);
      expect(manifest.stores).toEqual(expect.arrayContaining(['vault', 'brain-state']));
      expect(manifest.stores).not.toContain('memory-state');
      expect(manifest.stores).not.toContain('model-cache');
      expect(manifest.volumes['brain-state']).toBe(`${project}_brain-state`);
      expect(manifest.sensitive).toBe(false);
      const paths = manifest.files.map((file) => file.path);
      expect(paths).toContain('vault.tar');
      expect(paths).toContain('volumes/brain-state.tar');
      expect(paths).not.toContain('volumes/memory-state.tar');
      expect(paths).not.toContain('volumes/model-cache.tar');
      expect(paths).not.toContain('secrets.tar');
      expect(existsSync(join(backupDir, 'checksums.sha256'))).toBe(true);

      await waitForHealth(600_000);
    }, 1_800_000);
  }
);
