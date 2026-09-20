import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(mode).toBe(0o600);
    expect(result.vault_path).toBe(join(root, 'vault'));
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
