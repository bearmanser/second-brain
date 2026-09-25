import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { brainConfigSchema } from '../../src/config/schema.js';
import { BrainError } from '../../src/contracts/errors.js';
import {
  REDACTED,
  REDACTION_CAVEAT,
  assertNoCredentials,
  containsCredentials,
  detectCredentials,
  redactError,
  redactString,
  redactValue
} from '../../src/security/redact.js';

const temporaryRoot = join('/tmp/opencode', 'brain-security-tests');
const writeTemporaryFile = (name: string, contents: string): string => {
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'case-'));
  const path = join(directory, name);
  writeFileSync(path, contents, 'utf8');
  return path;
};

const exampleConfigPath = fileURLToPath(new URL('../../config/brain.example.yaml', import.meta.url));

const baseConfig = {
  endpoint: 'http://127.0.0.1:7331/mcp',
  backend_endpoint: 'http://memory:8000/mcp',
  port: 7331,
  mounts: { vault: '/vault', state: '/var/lib/second-brain' },
  allowed_hosts: ['127.0.0.1:7331'],
  allowed_origins: ['http://127.0.0.1:7331'],
  scopes: [
    { id: 'freellmapi', backend_project: 'freellmapi', relative_root: 'freellmapi', repository_aliases: ['free-api'] },
    { id: 'shared', backend_project: 'shared', relative_root: 'shared', repository_aliases: [] },
    { id: 'profile', backend_project: 'profile', relative_root: 'profile', repository_aliases: [] }
  ],
  limits: {}
};

test('loads the documented example configuration', () => {
  const config = loadConfig(exampleConfigPath);
  expect(config.scopes.map((scope) => scope.id)).toEqual(['freellmapi', 'shared', 'profile']);
  expect(config.endpoint).toBe('http://127.0.0.1:7331/mcp');
  expect(config.backend_endpoint).toBeUndefined();
  expect(config.search_mode).toBe('text');
  expect(config.search_fallback_only).toBe(false);
  expect(config.mounts.vault).toBe('/vault');
  expect(config.allowed_hosts.length).toBeGreaterThan(0);
  expect(config.limits.backend_timeout_ms).toBe(15000);
  expect(config.limits.concurrent_reads).toBe(8);
  expect(config.limits.project_provision_global_per_minute).toBe(50);
  expect(config.limits.dynamic_projects_max).toBe(1000);
});

test('rejects missing, malformed, and schema-invalid configuration', () => {
  const malformedYaml = writeTemporaryFile('brain.yaml', 'scopes: [unclosed\n');
  expect(() => loadConfig(malformedYaml)).toThrow(/INVALID_INPUT/);

  const invalidSchema = writeTemporaryFile(
    'brain.yaml',
    [
      'endpoint: http://127.0.0.1:7331/mcp',
      'backend_endpoint: http://memory:8000/mcp',
      'port: 7331',
      'mounts: { vault: /vault, state: /var/lib/second-brain }',
      'allowed_hosts: [127.0.0.1:7331]',
      'allowed_origins: []',
      'scopes:',
      '  - id: Not-A-Scope',
      '    backend_project: example',
      '    relative_root: example',
      '    repository_aliases: []'
    ].join('\n')
  );
  expect(() => loadConfig(invalidSchema)).toThrow(/INVALID_INPUT/);
  expect(() => loadConfig(join(temporaryRoot, 'missing.yaml'))).toThrow(/INVALID_INPUT/);
});

test('rejects duplicate scopes, alias collisions, and traversal in configured paths', () => {
  expect(
    brainConfigSchema.safeParse({
      ...baseConfig,
      scopes: [
        { id: 'freellmapi', backend_project: 'freellmapi', relative_root: 'freellmapi', repository_aliases: [] },
        { id: 'freellmapi', backend_project: 'other', relative_root: 'other', repository_aliases: [] }
      ]
    }).success
  ).toBe(false);
  expect(
    brainConfigSchema.safeParse({
      ...baseConfig,
      scopes: [
        { id: 'freellmapi', backend_project: 'freellmapi', relative_root: 'freellmapi', repository_aliases: ['shared'] },
        { id: 'shared', backend_project: 'shared', relative_root: 'shared', repository_aliases: [] }
      ]
    }).success
  ).toBe(false);
  expect(
    brainConfigSchema.safeParse({
      ...baseConfig,
      scopes: [{ id: 'freellmapi', backend_project: 'freellmapi', relative_root: '../escape', repository_aliases: [] }]
    }).success
  ).toBe(false);
  expect(
    brainConfigSchema.safeParse({ ...baseConfig, mounts: { vault: '/vault/../../etc', state: '/var/lib/second-brain' } })
      .success
  ).toBe(false);
  expect(
    brainConfigSchema.safeParse({ ...baseConfig, mounts: { vault: '/vault/%2e%2e/etc', state: '/var/lib/second-brain' } })
      .success
  ).toBe(false);
  expect(
    brainConfigSchema.safeParse({
      ...baseConfig,
      scopes: [{ id: 'freellmapi', backend_project: 'freellmapi', relative_root: '/absolute', repository_aliases: [] }]
    }).success
  ).toBe(false);
  expect(
    brainConfigSchema.safeParse({ ...baseConfig, limits: { backend_timeout_ms: 1000, backned_timeout_ms: 5 } }).success
  ).toBe(false);
  expect(
    brainConfigSchema.safeParse({ ...baseConfig, limits: { backend_timeout_ms: 1000, concurrent_reads: 4 } }).success
  ).toBe(true);
});

test('redacts bearer tokens and credential fields from structured errors', () => {
  const workerToken = 'worker-token-0123456789abcdef';
  const ownerToken = 'owner-token-0123456789abcdef';
  const error = new BrainError({
    code: 'BACKEND_UNAVAILABLE',
    message: `backend rejected Bearer ${workerToken}`
  });
  const redacted = redactError(error);
  expect(redacted.code).toBe('BACKEND_UNAVAILABLE');
  expect(redacted.message).not.toContain(workerToken);
  expect(redacted.message).toContain('Bearer [REDACTED]');

  const value = redactValue({
    authorization: `Bearer ${ownerToken}`,
    password: 'hunter2',
    nested: { api_key: 'k-123', note: `token=${workerToken}` },
    list: [{ secret: 's' }]
  }) as {
    authorization: string;
    password: string;
    nested: { api_key: string; note: string };
    list: { secret: string }[];
  };
  expect(value.authorization).toBe(REDACTED);
  expect(value.password).toBe(REDACTED);
  expect(value.nested.api_key).toBe(REDACTED);
  expect(value.nested.note).not.toContain(workerToken);
  expect(value.list[0].secret).toBe(REDACTED);
  expect(REDACTION_CAVEAT).toMatch(/best-effort/i);
});

test('redacts and rejects a real-looking private key capture string', () => {
  const privateKey = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
    'QyNTUxOQAAACBmYWtlLWtleS1tYXRlcmlhbC1mb3ItdGVzdGluZy1vbmx5AAAAAAAA',
    '-----END OPENSSH PRIVATE KEY-----'
  ].join('\n');
  const message = redactString(`capture rejected: ${privateKey}`);
  expect(message).not.toContain('b3BlbnNzaC1rZXk');
  expect(message).toContain('[REDACTED PRIVATE KEY]');
  expect(message).not.toContain('END OPENSSH PRIVATE KEY');

  expect(containsCredentials(privateKey)).toBe(true);
  expect(detectCredentials(privateKey)).toContain('private_key');
  expect(containsCredentials('A plain lesson about streaming latency.')).toBe(false);
  expect(detectCredentials('credential: Bearer abcdefghijklmnopqrstuvwxyz0123456789')).toContain('bearer_token');
  expect(detectCredentials('api_key=abcdef0123456789')).toContain('credential_assignment');

  let thrown: unknown;
  try {
    assertNoCredentials(`note body\n${privateKey}`, 'note.body');
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BrainError);
  expect((thrown as BrainError).code).toBe('INVALID_INPUT');
  expect((thrown as BrainError).message).toContain('note.body');
  expect((thrown as BrainError).message).not.toContain('b3BlbnNzaC1rZXk');

  expect(() => assertNoCredentials('A plain lesson about streaming latency.')).not.toThrow();
  expect(() => assertNoCredentials('api_key=abcdef0123456789')).toThrow(/INVALID_INPUT/);
});
