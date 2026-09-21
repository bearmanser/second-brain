import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadConfig, loadCredentials } from '../../src/config/load.js';
import { bootstrap } from '../../src/operations/bootstrap.js';

test('a second setup run preserves the existing client token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  await bootstrap({ root, scope: 'freellmapi' });
  const first = await readFile(join(root, 'secrets/brain-token'), 'utf8');
  await bootstrap({ root, scope: 'freellmapi' });
  expect(await readFile(join(root, 'secrets/brain-token'), 'utf8')).toBe(first);
  await rm(root, { recursive: true, force: true });
});

test('bootstrap writes a loadable configuration and credential digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    const result = await bootstrap({ root, scope: 'freellmapi' });
    const config = loadConfig(result.config_path);
    expect(config.scopes.map((scope) => scope.id)).toEqual(['freellmapi', 'shared', 'profile']);
    expect(config.endpoint).toBe('http://127.0.0.1:7331/mcp');
    expect(config.backend_endpoint).toBe('http://memory:8000/mcp');
    expect(config.credentials_file).toBe('/run/secrets/brain_credentials');
    expect(config.cursor_secret_file).toBe('/run/secrets/brain_cursor');
    expect(config.allowed_hosts).toContain('127.0.0.1');

    const token = (await readFile(join(root, 'secrets/brain-token'), 'utf8')).trim();
    const digest = createHash('sha256').update(token, 'utf8').digest('hex');
    const credentials = loadCredentials(join(root, 'secrets/credentials.json'));
    const record = credentials.find((entry) => entry.token_sha256 === digest);
    expect(record?.principal.role).toBe('reviewer');
    expect(record?.principal.review_scopes).toContain('freellmapi');
    expect(record?.principal.read_scopes).toContain('shared');
    expect(record?.principal.read_scopes).not.toContain('profile');

    const cursor = await readFile(join(root, 'secrets/cursor-key'));
    expect(cursor.length).toBeGreaterThanOrEqual(32);
    expect(await readFile(join(root, 'secrets/cursor-key'))).not.toEqual(await readFile(join(root, 'secrets/brain-token')));

    const mode = (await stat(join(root, 'secrets/brain-token'))).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    expect(result.vault_path).toBe(join(root, 'vault'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh bootstrap reserves only shared and profile until a repository is ensured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    const result = await bootstrap({ root });
    const config = loadConfig(result.config_path);
    expect(config.scopes.map((scope) => scope.id)).toEqual(['shared', 'profile']);
    expect(config.scopes.map((scope) => scope.relative_root)).toEqual(['Shared', 'Profile']);

    const token = (await readFile(join(root, 'secrets/brain-token'), 'utf8')).trim();
    const digest = createHash('sha256').update(token, 'utf8').digest('hex');
    const credentials = loadCredentials(join(root, 'secrets/credentials.json'));
    const record = credentials.find((entry) => entry.token_sha256 === digest);
    expect(record?.principal).toMatchObject({
      role: 'reviewer',
      read_scopes: ['shared'],
      write_scopes: [],
      review_scopes: []
    });
    await expect(stat(join(root, 'vault', 'Projects', 'freellmapi'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap separates the optional owner credential from the reviewer token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await bootstrap({ root, scope: 'freellmapi', owner_credential: true });
    const reviewer = (await readFile(join(root, 'secrets/brain-token'), 'utf8')).trim();
    const owner = (await readFile(join(root, 'secrets/owner-token'), 'utf8')).trim();
    expect(owner).not.toBe(reviewer);
    const ownerDigest = createHash('sha256').update(owner, 'utf8').digest('hex');
    const credentials = loadCredentials(join(root, 'secrets/credentials.json'));
    const record = credentials.find((entry) => entry.token_sha256 === ownerDigest);
    expect(record?.principal.role).toBe('owner');
    expect(record?.principal.read_scopes).toContain('profile');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap fails with the precise path when an existing vault is a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    const vault = join(root, 'vault');
    await writeFile(vault, 'not a directory\n', 'utf8');
    await expect(bootstrap({ root, scope: 'freellmapi', vault_path: vault })).rejects.toThrow(vault);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap creates required scope paths inside an existing vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    const vault = join(root, 'vault');
    await mkdir(vault, { recursive: true });
    await bootstrap({ root, scope: 'freellmapi', vault_path: vault });
    for (const relative of ['Projects/freellmapi', 'Shared', 'Profile']) {
      const info = await stat(join(vault, relative));
      expect(info.isDirectory()).toBe(true);
    }
    await bootstrap({ root, scope: 'freellmapi', vault_path: vault });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap rejects an existing vault that lacks access for the runtime uid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    const vault = join(root, 'vault');
    await mkdir(vault, { recursive: true });
    await chmod(vault, 0o755);
    await expect(
      bootstrap({ root, scope: 'freellmapi', vault_path: vault, uid: 12345, gid: 12345 })
    ).rejects.toThrow(vault);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enabling owner_credential adds the owner record to existing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await bootstrap({ root, scope: 'freellmapi' });
    const before = loadCredentials(join(root, 'secrets/credentials.json'));
    expect(before.some((record) => record.principal.role === 'owner')).toBe(false);

    await bootstrap({ root, scope: 'freellmapi', owner_credential: true });
    const after = loadCredentials(join(root, 'secrets/credentials.json'));
    const ownerToken = (await readFile(join(root, 'secrets/owner-token'), 'utf8')).trim();
    const ownerDigest = createHash('sha256').update(ownerToken, 'utf8').digest('hex');
    expect(after.some((record) => record.token_sha256 === ownerDigest)).toBe(true);
    expect(after.length).toBe(before.length + 1);

    const firstOwner = await readFile(join(root, 'secrets/credentials.json'), 'utf8');
    await bootstrap({ root, scope: 'freellmapi', owner_credential: true });
    expect(await readFile(join(root, 'secrets/credentials.json'), 'utf8')).toBe(firstOwner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap fails precisely when the owner record has no token file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await bootstrap({ root, scope: 'freellmapi', owner_credential: true });
    await rm(join(root, 'secrets/owner-token'), { force: true });
    await expect(bootstrap({ root, scope: 'freellmapi', owner_credential: true })).rejects.toThrow(
      /owner-token/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const setupScriptPath = fileURLToPath(new URL('../../scripts/setup.sh', import.meta.url));

test('setup.sh rejects malformed pinned image references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'config'), { recursive: true });
    await copyFile(setupScriptPath, join(root, 'scripts/setup.sh'));

    const cases: [string, string][] = [
      ['unknown key', 'NODE_IMAGE=node@sha256:aaa\nFOO=bar'],
      ['missing digest', 'NODE_IMAGE=node:24-alpine\nBASIC_MEMORY_IMAGE=ghcr.io/x/y@sha256:bbb'],
      ['short digest', `NODE_IMAGE=node@sha256:${'a'.repeat(63)}\nBASIC_MEMORY_IMAGE=ghcr.io/x/y@sha256:${'b'.repeat(64)}`],
      ['non-hex digest', `NODE_IMAGE=node@sha256:${'z'.repeat(64)}\nBASIC_MEMORY_IMAGE=ghcr.io/x/y@sha256:${'b'.repeat(64)}`],
      ['latest reference', `NODE_IMAGE=node@sha256:${'a'.repeat(64)}:latest\nBASIC_MEMORY_IMAGE=ghcr.io/x/y@sha256:${'b'.repeat(64)}`],
      ['shell syntax', `NODE_IMAGE=node@sha256:${'a'.repeat(64)};x\nBASIC_MEMORY_IMAGE=ghcr.io/x/y@sha256:${'b'.repeat(64)}`]
    ];

    for (const [label, images] of cases) {
      await writeFile(join(root, 'config/images.env'), `${images}\n`, 'utf8');
      const result = spawnSync('bash', ['scripts/setup.sh'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, VAULT_PATH: join(root, 'vault') }
      });
      expect(result.status, label).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`, label).toMatch(/setup:/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
