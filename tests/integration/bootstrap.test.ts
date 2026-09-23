import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { bootstrap } from '../../src/operations/bootstrap.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

test('a second setup run preserves the existing token, digest, and cursor secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await bootstrap({ root, scope: 'freellmapi' });
    const token = await readFile(join(root, 'secrets/brain-token'), 'utf8');
    const env = await readFile(join(root, '.env'), 'utf8');
    const cursor = await readFile(join(root, 'secrets/cursor-key'));
    await bootstrap({ root, scope: 'freellmapi' });
    expect(await readFile(join(root, 'secrets/brain-token'), 'utf8')).toBe(token);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(env);
    expect(await readFile(join(root, 'secrets/cursor-key'))).toEqual(cursor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap writes one token, one digest env assignment, and a loadable configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    const result = await bootstrap({ root, scope: 'freellmapi' });
    const config = loadConfig(result.config_path);
    expect(config.scopes.map((scope) => scope.id)).toEqual(['freellmapi', 'shared', 'profile']);
    expect(config.endpoint).toBe('http://127.0.0.1:7331/mcp');
    expect(config.cursor_secret_file).toBe('/run/secrets/brain_cursor');
    expect(config.allowed_hosts).toContain('127.0.0.1');
    expect(config).not.toHaveProperty('credentials_file');

    const token = (await readFile(join(root, 'secrets/brain-token'), 'utf8')).trim();
    const env = await readFile(join(root, '.env'), 'utf8');
    expect(env).toContain(`BRAIN_TOKEN_SHA256=${digest(token)}`);
    expect(env.match(/BRAIN_TOKEN_SHA256=/g)).toHaveLength(1);
    expect(result.env_path).toBe(join(root, '.env'));

    const cursor = await readFile(join(root, 'secrets/cursor-key'));
    expect(cursor.length).toBeGreaterThanOrEqual(32);
    expect(cursor).not.toEqual(Buffer.from(token));

    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'secrets/brain-token'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
    }
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
    await expect(stat(join(root, 'vault', 'Projects', 'freellmapi'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy-only setup stops with explicit conversion instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await mkdir(join(root, 'secrets'), { recursive: true });
    await writeFile(
      join(root, 'secrets/credentials.json'),
      JSON.stringify({ credentials: [{ token_sha256: 'a'.repeat(64) }] }),
      'utf8'
    );
    await expect(bootstrap({ root })).rejects.toThrow(/auth migrate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy layout is refused before any file is written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await mkdir(join(root, 'secrets'), { recursive: true });
    await mkdir(join(root, 'config'), { recursive: true });
    const tokenBefore = 'legacy-worker-token\n';
    await writeFile(join(root, 'secrets/brain-token'), tokenBefore, { mode: 0o600 });
    await writeFile(
      join(root, 'secrets/credentials.json'),
      JSON.stringify({ credentials: [{ token_sha256: 'a'.repeat(64) }] }),
      'utf8'
    );
    await writeFile(
      join(root, 'config/brain.yaml'),
      'credentials_file: /run/secrets/brain_credentials\n',
      'utf8'
    );
    await expect(bootstrap({ root })).rejects.toThrow(/conversion|auth migrate/);
    await expect(readFile(join(root, '.env'))).rejects.toThrow();
    await expect(stat(join(root, 'secrets/cursor-key'))).rejects.toThrow();
    await expect(stat(join(root, 'vault'))).rejects.toThrow();
    expect(await readFile(join(root, 'secrets/brain-token'), 'utf8')).toBe(tokenBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a legacy credentials layout without a config is refused before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await mkdir(join(root, 'secrets'), { recursive: true });
    await writeFile(
      join(root, 'secrets/credentials.json'),
      JSON.stringify({ credentials: [{ token_sha256: 'a'.repeat(64) }] }),
      'utf8'
    );
    await expect(bootstrap({ root })).rejects.toThrow(/auth migrate/);
    await expect(stat(join(root, 'secrets/brain-token'))).rejects.toThrow();
    await expect(readFile(join(root, '.env'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a credentials_file config is refused even when a digest exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await mkdir(join(root, 'config'), { recursive: true });
    await mkdir(join(root, 'secrets'), { recursive: true });
    await writeFile(
      join(root, 'config/brain.yaml'),
      'credentials_file: /run/secrets/brain_credentials\n',
      'utf8'
    );
    await writeFile(join(root, '.env'), `BRAIN_TOKEN_SHA256=${'a'.repeat(64)}\n`, { mode: 0o600 });
    await expect(bootstrap({ root })).rejects.toThrow(/conversion/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap rejects secrets placed inside the vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  try {
    await expect(bootstrap({ root, vault_path: root })).rejects.toThrow(/vault/);
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
