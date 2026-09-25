import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  'workers',
  'config'
] as const;
const NOTE_TITLE = 'Single container recall lesson';
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

let workDir = '';
let project = '';
let vaultPath = '';
let brainPort = 0;
let nodeImage = '';
let pythonImage = '';
let token = '';
let composeConfig = '';
let client: Client | undefined;

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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}
): string {
  const spawnOptions: SpawnSyncOptions = {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? env()
  };
  const result = spawnSync(command, args, spawnOptions);
  if (result.error !== undefined) throw result.error;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}\n${stdout}\n${stderr}`
    );
  }
  return stdout;
}

function compose(args: string[], cwd = REPO_ROOT): string {
  return run('docker', ['compose', '-p', project, '-f', 'compose.yaml', ...args], { cwd });
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
    const result = spawnSync(
      'docker',
      ['compose', '-p', project, '-f', 'compose.yaml', 'exec', '-T', 'brain', 'node', 'dist/cli.js', 'health'],
      { encoding: 'utf8', cwd: workDir, env: env() }
    );
    if (result.status === 0) return;
    last = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    await sleep(5_000);
  }
  throw new Error(`the single container never reported healthy: ${last}`);
}

function statusFrom(result: unknown): {
  health?: { gateway?: string; index?: string; worker?: string; rss_bytes?: number };
} {
  if (typeof result !== 'object' || result === null) return {};
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  return typeof structured === 'object' && structured !== null
    ? (structured as { health?: { gateway?: string; index?: string; worker?: string; rss_bytes?: number } })
    : {};
}

function itemsFrom(result: unknown): { title?: string }[] {
  if (typeof result !== 'object' || result === null) return [];
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== 'object' || structured === null) return [];
  const items = (structured as { items?: unknown }).items;
  return Array.isArray(items) ? (items as { title?: string }[]) : [];
}

beforeAll(async () => {
  run('docker', ['version', '--format', '{{.Server.Version}}']);
  nodeImage = imageReference('NODE_IMAGE');
  pythonImage = imageReference('PYTHON_IMAGE');
  expect(nodeImage).toContain('@sha256:');
  expect(pythonImage).toContain('@sha256:');
  project = `brainsingle${process.pid}`;
  brainPort = await freePort();
  vaultPath = join(WORK_ROOT, `brain-single-vault-${process.pid}`);
  composeConfig = run(
    'docker',
    ['compose', '-p', project, '-f', 'compose.yaml', 'config'],
    { env: env({ BRAIN_TOKEN_SHA256: 'f'.repeat(64) }) }
  );
}, SUITE_TIMEOUT);

afterAll(async () => {
  try {
    await client?.close();
  } catch {}
  if (workDir.length > 0 && LIVE) {
    try {
      compose(['down', '-v', '--remove-orphans'], workDir);
    } catch {}
  }
  spawnSync('docker', ['volume', 'rm', `${project}_brain-state`], { encoding: 'utf8' });
  spawnSync('docker', ['image', 'rm', `${project}-brain`], { encoding: 'utf8' });
  if (workDir.length > 0) rmSync(workDir, { recursive: true, force: true });
}, SUITE_TIMEOUT);

describe('production Compose exposes a single application container', () => {
  test('declares only the brain service with no backend or embedding dependency', () => {
    const composeYaml = readText('compose.yaml');
    expect(composeYaml).not.toMatch(/^\s{2}memory:\s*$/m);
    expect(composeYaml).not.toMatch(/BASIC_MEMORY|basic-memory/i);
    expect(composeYaml).not.toMatch(/BRAIN_BACKEND_URL|backend_endpoint/);
    expect(composeYaml).not.toMatch(/embedding|fastembed|semantic/i);
    expect(composeYaml).not.toContain('/app/data');
    expect(composeConfig).not.toContain('memory');
    expect(composeConfig).not.toContain('basic');
  });

  test('publishes only the loopback gateway endpoint', () => {
    expect(readText('compose.yaml')).toContain('127.0.0.1:${BRAIN_PORT:-7331}:7331');
    expect(composeConfig).toContain('host_ip: 127.0.0.1');
    expect(composeConfig).toContain('target: 7331');
    const published = composeConfig.match(/published:/g) ?? [];
    expect(published.length).toBe(1);
    expect(composeConfig).toContain(`published: "${brainPort}"`);
  });

  test('preserves the vault mount, configured env-file route, and state volume', () => {
    const composeYaml = readText('compose.yaml');
    expect(composeYaml).toContain('${VAULT_PATH:-./vault}:/vault');
    expect(composeYaml).not.toContain('/vault:ro');
    expect(composeYaml).toContain('./config/brain.yaml:/run/brain/brain.yaml:ro');
    expect(composeYaml).toContain('BRAIN_CONFIG: /run/brain/brain.yaml');
    expect(composeYaml).toContain('brain-state:/var/lib/second-brain');
    expect(composeConfig).toContain('brain-state');
    expect(composeConfig).toContain('target: /vault');
    const readOnly = composeConfig.match(/read_only: true/g) ?? [];
    expect(readOnly.length).toBe(1);
  });

  test('enforces runtime resource and concurrency bounds in Compose', () => {
    const composeYaml = readText('compose.yaml');
    expect(composeYaml).toMatch(/^\s+mem_limit:/m);
    expect(composeYaml).toMatch(/^\s+cpus:/m);
    expect(composeYaml).toContain('init: true');
    expect(composeConfig).toMatch(/mem_limit|memory:/);
    expect(composeConfig).toContain('init: true');
  });

  test('maps the deployment search settings with strict defaults', () => {
    const composeYaml = readText('compose.yaml');
    expect(composeYaml).toContain('BRAIN_SEARCH_MODE: ${BRAIN_SEARCH_MODE:-text}');
    expect(composeYaml).toContain('BRAIN_SEARCH_FALLBACK_ONLY: ${BRAIN_SEARCH_FALLBACK_ONLY:-false}');
    expect(composeYaml).toContain('BRAIN_LAYA_ENABLED: ${BRAIN_LAYA_ENABLED:-false}');
    expect(composeYaml).toContain(
      'BRAIN_LAYA_MODEL_DIR: ${BRAIN_LAYA_MODEL_DIR:-/var/lib/second-brain/models/laya/runtime}'
    );
    expect(composeYaml).toContain('BRAIN_LAYA_BATCH_SIZE: ${BRAIN_LAYA_BATCH_SIZE:-8}');
    expect(composeYaml).toContain('BRAIN_LAYA_QUEUE_BATCHES: ${BRAIN_LAYA_QUEUE_BATCHES:-4}');
    expect(composeYaml).toContain('BRAIN_LAYA_TIMEOUT_MS: ${BRAIN_LAYA_TIMEOUT_MS:-4000}');
    expect(composeYaml).toContain('BRAIN_LAYA_THREADS: ${BRAIN_LAYA_THREADS:-2}');
    expect(composeYaml).toContain('BRAIN_RECONCILE_INTERVAL_MS: ${BRAIN_RECONCILE_INTERVAL_MS:-30000}');
    expect(readText('.env.example')).not.toMatch(/^BASIC_MEMORY_IMAGE=/m);
    expect(readText('.env.example')).not.toMatch(/^BRAIN_TOKEN_SHA256=.+$/m);
  });

  test('builds one pinned Linux image with Node, Python 3.12, and hash-locked worker deps', () => {
    const dockerfile = readText('Dockerfile');
    expect(dockerfile).toContain('PYTHON_IMAGE');
    expect(dockerfile).toContain('pip install --no-cache-dir --no-deps --require-hashes --only-binary=:all:');
    expect(dockerfile).toContain('USER 1000:1000');
    expect(dockerfile).toMatch(/FROM .*PYTHON_IMAGE/);
    expect(dockerfile).not.toMatch(/basic-memory|BASIC_MEMORY/i);
    expect(readText('config/images.env')).toContain('PYTHON_IMAGE=');
    expect(readText('config/images.env')).not.toContain('BASIC_MEMORY_IMAGE=');
  });

  test.skipIf(!LIVE)('serves with the model disabled and returns lexical text fallback without artifacts', async () => {
    workDir = mkdtempSync(join(WORK_ROOT, 'brain-single-'));
    for (const item of COPY_ITEMS) {
      cpSync(join(REPO_ROOT, item), join(workDir, item), { recursive: true });
    }
    rmSync(join(workDir, 'config/brain.yaml'), { force: true });
    run('bash', ['scripts/setup.sh'], { cwd: workDir });
    compose(['up', '-d', '--build'], workDir);
    await waitForHealth(1_200_000);
    token = readFileSync(join(workDir, 'secrets/brain-token'), 'utf8').trim();
    client = new Client({ name: 'single-container-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${brainPort}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const ensured = await client.callTool({
      name: 'brain_project_ensure',
      arguments: {
        idempotency_key: randomUUID(),
        remote_url: 'https://github.com/example/freellmapi.git'
      }
    });
    expect((ensured as { isError?: boolean }).isError ?? false).toBe(false);
    const captured = await client.callTool({
      name: 'brain_capture',
      arguments: {
        idempotency_key: randomUUID(),
        scope: 'freellmapi',
        note: {
          title: NOTE_TITLE,
          tags: ['e2e'],
          content: {
            kind: 'lesson',
            situation: 'A single container is started without model artifacts.',
            lesson: 'Lexical retrieval must keep working with reranking disabled.',
            applicability: 'Deployment verification'
          },
          evidence: [{ kind: 'observation', ref: 'single-container-e2e', description: 'smoke test' }],
          related_ids: []
        }
      }
    });
    expect((captured as { isError?: boolean }).isError ?? false).toBe(false);
    expect((captured as { structuredContent?: unknown }).structuredContent).toBeDefined();
    const status = await client.callTool({ name: 'brain_status', arguments: {} });
    const health = statusFrom(status);
    expect(health.health?.gateway).toBe('ready');
    expect(health.health?.worker).toBe('disabled');
    expect(health.health?.index).toBe('ready');
    expect(typeof health.health?.rss_bytes).toBe('number');
    const recall = await client.callTool({
      name: 'brain_recall',
      arguments: { scope: 'freellmapi', query: 'lexical retrieval reranking disabled', include_candidates: true }
    });
    expect(itemsFrom(recall).some((item) => item.title === NOTE_TITLE)).toBe(true);
  }, SUITE_TIMEOUT);
});
