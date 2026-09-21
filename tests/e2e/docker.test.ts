import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const OVERRIDE_FILE = 'offline.override.yaml';
const OFFLINE_PROBE = 'offline-probe.mjs';
const NOTE_TITLE = 'E2E offline recall lesson';
const SUITE_TIMEOUT = 2_400_000;

let workDir = '';
let project = '';
let brainPort = 0;
let vaultPath = '';
let nodeImage = '';
let memoryImage = '';
let token = '';
let composeConfig = '';
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
): string {
  const spawnOptions: SpawnSyncOptions = {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    cwd: options.cwd ?? workDir,
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

function composeArgs(extra: string[]): string[] {
  return ['compose', '-p', project, '-f', 'compose.yaml', ...extra];
}

function compose(extra: string[]): string {
  return run('docker', composeArgs(extra));
}

function composeOffline(extra: string[]): string {
  return run('docker', ['compose', '-p', project, '-f', 'compose.yaml', '-f', OVERRIDE_FILE, ...extra]);
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
    const result = spawnSync(
      'docker',
      composeArgs(['exec', '-T', 'brain', 'node', 'dist/cli.js', 'health']),
      { encoding: 'utf8', cwd: workDir, env: env() }
    );
    if (result.status === 0) return;
    last = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    await sleep(5_000);
  }
  throw new Error(`the gateway never reported healthy: ${last}`);
}

async function connect(): Promise<Client> {
  const connected = new Client({ name: 'second-brain-e2e', version: '1.0.0' });
  await connected.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${brainPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  return connected;
}

function statusFrom(result: unknown): { health?: { gateway?: string; backend?: string } } {
  if (typeof result !== 'object' || result === null) return {};
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  return typeof structured === 'object' && structured !== null
    ? (structured as { health?: { gateway?: string; backend?: string } })
    : {};
}

function itemsFrom(result: unknown): { title?: string }[] {
  if (typeof result !== 'object' || result === null) return [];
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (typeof structured !== 'object' || structured === null) return [];
  const items = (structured as { items?: unknown }).items;
  return Array.isArray(items) ? (items as { title?: string }[]) : [];
}

function probeItems(value: unknown): { title?: string }[] {
  if (typeof value !== 'object' || value === null) return [];
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? (items as { title?: string }[]) : [];
}

beforeAll(async () => {
  run('docker', ['version', '--format', '{{.Server.Version}}'], { cwd: REPO_ROOT });

  const images = readFileSync(join(REPO_ROOT, 'config/images.env'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  for (const line of images) {
    const [key, ...rest] = line.split('=');
    if (key === 'NODE_IMAGE') nodeImage = rest.join('=');
    if (key === 'BASIC_MEMORY_IMAGE') memoryImage = rest.join('=');
  }
  expect(nodeImage).toContain('@sha256:');
  expect(memoryImage).toContain('@sha256:');

  workDir = mkdtempSync(join(WORK_ROOT, 'brain-e2e-'));
  project = `braine2e${process.pid}`;
  brainPort = await freePort();
  vaultPath = join(workDir, 'custom-vault');

  for (const item of COPY_ITEMS) {
    cpSync(join(REPO_ROOT, item), join(workDir, item), { recursive: true });
  }
  expect(readFileSync(join(workDir, 'compose.yaml'), 'utf8')).toBe(
    readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8')
  );
  expect(readFileSync(join(workDir, 'Dockerfile'), 'utf8')).toBe(
    readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8')
  );

  run('bash', ['scripts/setup.sh'], {
    cwd: workDir,
    env: env({ VAULT_PATH: vaultPath, BRAIN_UID: '1000', BRAIN_GID: '1000' })
  });

  expect(existsSync(join(workDir, '.env'))).toBe(true);
  expect(existsSync(join(workDir, 'config/brain.yaml'))).toBe(true);
  expect(existsSync(join(workDir, 'secrets/brain-token'))).toBe(true);
  expect(existsSync(join(workDir, 'secrets/cursor-key'))).toBe(true);
  run('docker', ['image', 'inspect', 'second-brain:local'], { cwd: workDir });

  composeConfig = compose(['config']);
  expect(composeConfig).not.toContain(':latest');

  compose(['up', '-d', '--build']);
  await waitForHealth(600_000);

  token = readFileSync(join(workDir, 'secrets/brain-token'), 'utf8').trim();
  client = await connect();
  const ensured = await client.callTool({
    name: 'brain_project_ensure',
    arguments: {
      idempotency_key: randomUUID(),
      remote_url: 'https://github.com/example/freellmapi.git'
    }
  });
  expect((ensured as { isError?: boolean }).isError ?? false).toBe(false);
  expect((ensured as { structuredContent?: { scope?: string; permissions?: unknown } }).structuredContent)
    .toMatchObject({
      scope: 'freellmapi',
      permissions: { can_read: true, can_write: true, can_review: true }
    });
}, SUITE_TIMEOUT);

afterAll(async () => {
  try {
    await client?.close();
  } catch {}
  try {
    if (existsSync(join(workDir, OVERRIDE_FILE))) {
      composeOffline(['down', '-v', '--remove-orphans']);
    } else {
      compose(['down', '-v', '--remove-orphans']);
    }
  } catch {}
  for (const candidate of [project, `${project}own`]) {
    for (const name of ['brain-state', 'memory-state', 'model-cache']) {
      spawnSync('docker', ['volume', 'rm', `${candidate}_${name}`], { encoding: 'utf8' });
    }
  }
  spawnSync('docker', ['image', 'rm', `${project}-brain`], { encoding: 'utf8' });
  if (workDir.length > 0) rmSync(workDir, { recursive: true, force: true });
}, SUITE_TIMEOUT);

describe('reproducible Docker deployment', () => {
  test('builds pinned images and publishes only the loopback gateway endpoint', async () => {
    expect(composeConfig).toContain('host_ip: 127.0.0.1');
    expect(composeConfig).toContain(`published: "${brainPort}"`);
    expect(composeConfig).toContain('target: 7331');
    expect(composeConfig).toContain(nodeImage);
    expect(composeConfig).toContain(memoryImage);

    const brainId = compose(['ps', '-q', 'brain']).trim();
    const memoryId = compose(['ps', '-q', 'memory']).trim();
    const brainPorts = run('docker', ['port', brainId]).trim();
    const memoryPorts = run('docker', ['port', memoryId]).trim();
    expect(brainPorts).toContain(`127.0.0.1:${brainPort}`);
    expect(memoryPorts).toBe('');

    const status = await client!.callTool({ name: 'brain_status', arguments: {} });
    const health = statusFrom(status);
    expect(health.health?.gateway).toBe('ready');
    expect(health.health?.backend).toBe('ready');
  }, 300_000);

  test('runs as uid 1000 and mounts the gateway vault read-only', () => {
    const brainUid = compose(['exec', '-T', 'brain', 'id', '-u']).trim();
    const memoryUid = compose(['exec', '-T', 'memory', 'id', '-u']).trim();
    expect(brainUid).toBe('1000');
    expect(memoryUid).toBe('1000');

    const write = spawnSync(
      'docker',
      composeArgs(['exec', '-T', 'brain', 'sh', '-c', 'touch /vault/e2e-forbidden']),
      { encoding: 'utf8', cwd: workDir, env: env() }
    );
    expect(write.status).not.toBe(0);
  }, 300_000);

  test('materializes a capture under the custom vault path', async () => {
    const captured = await client!.callTool({
      name: 'brain_capture',
      arguments: {
        idempotency_key: randomUUID(),
        scope: 'freellmapi',
        note: {
          title: NOTE_TITLE,
          tags: ['e2e'],
          content: {
            kind: 'lesson',
            situation: 'A compose deployment is started without Obsidian.',
            lesson: 'Offline recall keeps working after the embedding cache is warmed.',
            applicability: 'Deployment verification'
          },
          evidence: [
            { kind: 'observation', ref: 'compose-e2e', description: 'containerized smoke test' }
          ],
          related_ids: []
        }
      }
    });
    const structured = (captured as { structuredContent?: { materialized?: boolean; indexed?: boolean } })
      .structuredContent;
    expect(structured?.materialized).toBe(true);

    const relative = `Projects/freellmapi/Lessons`;
    let found = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !found) {
      found = existsSync(join(vaultPath, relative));
      if (!found) await sleep(1_000);
    }
    expect(found).toBe(true);
  }, 300_000);

  test('preserves captured state across a restart', async () => {
    compose(['restart', 'brain']);
    await waitForHealth(300_000);
    await client?.close();
    client = await connect();
    const recall = await client.callTool({
      name: 'brain_recall',
      arguments: { scope: 'freellmapi', query: 'offline recall embedding cache', include_candidates: true }
    });
    expect(itemsFrom(recall).some((item) => item.title === NOTE_TITLE)).toBe(true);
  }, 600_000);

  test('launches and serves with no Obsidian process present', async () => {
    const obsidian = spawnSync('pgrep', ['-x', 'obsidian'], { encoding: 'utf8' });
    expect(obsidian.status).not.toBe(0);
    const status = await client!.callTool({ name: 'brain_status', arguments: {} });
    expect(statusFrom(status).health?.gateway).toBe('ready');
  }, 300_000);

  test('refuses to modify an existing operator-owned volume', () => {
    const ownedProject = `${project}own`;
    const ownedVolume = `${ownedProject}_brain-state`;
    run('docker', ['volume', 'create', ownedVolume]);

    const result = spawnSync('bash', ['scripts/setup.sh'], {
      cwd: workDir,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: env({ COMPOSE_PROJECT_NAME: ownedProject })
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/existing volume .* is not writable/);

    const writable = spawnSync(
      'docker',
      ['run', '--rm', '--user', '1000:1000', '-v', `${ownedVolume}:/volume`, nodeImage, 'sh', '-c', 'test -w /volume'],
      { encoding: 'utf8' }
    );
    expect(writable.status).not.toBe(0);

    const marker = spawnSync(
      'docker',
      ['run', '--rm', '--user', '0:0', '-v', `${ownedVolume}:/volume`, nodeImage, 'sh', '-c', 'test -e /volume/.brain-initialized'],
      { encoding: 'utf8' }
    );
    expect(marker.status).not.toBe(0);

    spawnSync('docker', ['volume', 'rm', ownedVolume], { encoding: 'utf8' });
  }, 900_000);

  test('keeps hybrid search working from a warmed cache with no external network', async () => {
    const modelMarker = 'models--qdrant--bge-small-en-v1.5-onnx-q';
    let warmed = false;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !warmed) {
      const check = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${project}_model-cache:/cache`,
          nodeImage,
          'sh',
          '-c',
          `test -d /cache/${modelMarker}`
        ],
        { encoding: 'utf8' }
      );
      warmed = check.status === 0;
      if (!warmed) await sleep(10_000);
    }
    expect(warmed).toBe(true);

    compose(['down', '--remove-orphans']);
    writeFileSync(
      join(workDir, OVERRIDE_FILE),
      'networks:\n  default:\n    internal: true\n',
      'utf8'
    );
    composeOffline(['up', '-d']);
    await waitForHealth(600_000);
    expect(run('docker', ['network', 'inspect', `${project}_default`, '--format', '{{.Internal}}']).trim()).toBe('true');

    writeFileSync(
      join(workDir, OFFLINE_PROBE),
      [
        "import { Client } from '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';",
        "import { StreamableHTTPClientTransport } from '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';",
        "import { readFileSync } from 'node:fs';",
        "const token = readFileSync('/run/secrets/brain_token', 'utf8').trim();",
        "const client = new Client({ name: 'offline-probe', version: '1.0.0' });",
        "await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7331/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));",
        "const recall = await client.callTool({ name: 'brain_recall', arguments: { scope: 'freellmapi', query: 'offline recall embedding cache', include_candidates: true } });",
        "process.stdout.write(JSON.stringify(recall.structuredContent));",
        'await client.close();'
      ].join('\n'),
      'utf8'
    );
    const brainId = composeOffline(['ps', '-q', 'brain']).trim();
    run('docker', ['cp', join(workDir, OFFLINE_PROBE), `${brainId}:/tmp/${OFFLINE_PROBE}`], { cwd: workDir });
    const probe = composeOffline(['exec', '-T', 'brain', 'node', `/tmp/${OFFLINE_PROBE}`]);
    const items = probeItems(JSON.parse(probe.trim()) as unknown);
    expect(items.some((item) => item.title === NOTE_TITLE)).toBe(true);
  }, 900_000);
});
