import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  BRAIN_TOKEN_ENV,
  assertTokenDigest,
  loadTokenDigest
} from '../../src/config/load.js';
import { SYSTEM_ACTOR, type AuthenticatedContext } from '../../src/core/types.js';
import {
  MAX_AUTHORIZATION_HEADER_CHARS,
  SessionRegistry,
  readAuthorizationHeader
} from '../../src/mcp/http.js';
import { generateBearerToken, verifyBearer } from '../../src/security/authenticate.js';
import { runCli } from '../../src/cli.js';
import { workerPrincipal } from '../fixtures/principals.js';

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

test('one token authenticates without a principal or role', () => {
  const token = 'a'.repeat(64);
  const expected = createHash('sha256').update(token).digest('hex');
  expect(verifyBearer(`Bearer ${token}`, expected)).toBe(true);
  expect(verifyBearer(`Bearer ${'b'.repeat(64)}`, expected)).toBe(false);
  expect(verifyBearer(undefined, expected)).toBe(false);
  expect(verifyBearer('Bearer one, Bearer two', expected)).toBe(false);
});

test('the digest is the only accepted credential shape', () => {
  const token = 'correct-horse-battery-staple';
  const expected = digest(token);
  expect(verifyBearer(`bearer ${token}`, expected)).toBe(true);
  expect(verifyBearer(`Bearer ${token}`, expected.toUpperCase())).toBe(false);
  expect(verifyBearer(`Bearer ${token}`, 'abcd')).toBe(false);
  expect(verifyBearer(`Bearer ${token}`, 'z'.repeat(64))).toBe(false);
  expect(verifyBearer('', expected)).toBe(false);
  expect(verifyBearer('Bearer', expected)).toBe(false);
  expect(verifyBearer('Bearer ', expected)).toBe(false);
  expect(verifyBearer('Basic dXNlcjpwYXNz', expected)).toBe(false);
  expect(verifyBearer(`Bearer ${token} `, expected)).toBe(false);
  expect(verifyBearer(` Bearer ${token}`, expected)).toBe(false);
  expect(verifyBearer(`Bearer ${token}!`, expected)).toBe(false);
});

test('an authenticated context has a fixed system actor and no role or grant fields', () => {
  const context: AuthenticatedContext = {
    actor: SYSTEM_ACTOR,
    request_id: 'request-id',
    signal: new AbortController().signal
  };
  expect(Object.keys(context).sort()).toEqual(['actor', 'request_id', 'signal']);
  expect(Object.keys(context.actor).sort()).toEqual(['id', 'kind']);
  expect(context.actor.kind).toBe('system');
  expect(context).not.toHaveProperty('principal');
  expect(context).not.toHaveProperty('role');
  expect(context).not.toHaveProperty('read_scopes');
  expect(context).not.toHaveProperty('write_scopes');
  expect(context).not.toHaveProperty('review_scopes');
});

test('a missing or malformed token digest fails closed', () => {
  expect(() => loadTokenDigest({})).toThrow(/INVALID_INPUT/);
  expect(() => loadTokenDigest({ [BRAIN_TOKEN_ENV]: '' })).toThrow(/INVALID_INPUT/);
  expect(() => loadTokenDigest({ [BRAIN_TOKEN_ENV]: 'not-a-digest' })).toThrow(/INVALID_INPUT/);
  expect(() => loadTokenDigest({ [BRAIN_TOKEN_ENV]: 'A'.repeat(64) })).toThrow(/INVALID_INPUT/);
  expect(() => assertTokenDigest(undefined)).toThrow(/INVALID_INPUT/);
  expect(assertTokenDigest('a'.repeat(64))).toBe('a'.repeat(64));
  expect(loadTokenDigest({ [BRAIN_TOKEN_ENV]: 'a'.repeat(64) })).toBe('a'.repeat(64));
});

test('a raw authorization header list rejects duplicates and oversized values', () => {
  expect(readAuthorizationHeader([])).toBeUndefined();
  expect(readAuthorizationHeader(['Authorization', 'Bearer sample'])).toBe('Bearer sample');
  expect(readAuthorizationHeader(['authorization', 'Bearer sample'])).toBe('Bearer sample');
  expect(
    readAuthorizationHeader([
      'Authorization',
      'Bearer first',
      'authorization',
      'Bearer second'
    ])
  ).toBeUndefined();
  expect(
    readAuthorizationHeader(['Authorization', 'x'.repeat(MAX_AUTHORIZATION_HEADER_CHARS + 1)])
  ).toBeUndefined();
});

function counterGenerator(prefix: string): () => string {
  let count = 0;
  return () => `${prefix}${(count += 1)}`;
}

test('the session registry retains guard-issued identifiers within a capacity bound', () => {
  const registry = new SessionRegistry({
    capacity: 3,
    idle_ms: 60_000,
    generate: counterGenerator('session-')
  });
  const issued = [
    registry.resolve(undefined, 0),
    registry.resolve(undefined, 0),
    registry.resolve(undefined, 0),
    registry.resolve(undefined, 0)
  ];
  expect(new Set(issued).size).toBe(4);
  expect(registry.size).toBe(3);

  expect(registry.resolve(issued[3], 10)).toBe(issued[3]);
  expect(registry.size).toBe(3);

  const chosenByCaller = registry.resolve('caller-chosen-id', 11);
  expect(chosenByCaller).not.toBe('caller-chosen-id');
  expect(registry.size).toBe(3);
});

test('the session registry expires idle identifiers and revokes all on demand', () => {
  const registry = new SessionRegistry({
    capacity: 10,
    idle_ms: 1000,
    generate: counterGenerator('idle-')
  });
  const first = registry.resolve(undefined, 0);
  expect(registry.size).toBe(1);
  const afterIdle = registry.resolve(undefined, 5000);
  expect(afterIdle).not.toBe(first);
  expect(registry.size).toBe(1);

  registry.revokeAll();
  expect(registry.size).toBe(0);
});

test('generated tokens carry at least 32 bytes of entropy and their own digest', () => {
  const generated = generateBearerToken();
  expect(generated.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(generated.token_sha256).toBe(digest(generated.token));
  expect(generateBearerToken().token).not.toBe(generated.token);
});

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const code = await run();
    const out = spy.mock.calls.map((call) => String(call[0])).join('');
    return { code, out };
  } finally {
    spy.mockRestore();
  }
}

test('auth generate emits the digest assignment and prints the raw token only on request', async () => {
  const withoutToken = await captureStdout(() => runCli(['auth', 'generate']));
  expect(withoutToken.code).toBe(0);
  const lines = withoutToken.out.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^BRAIN_TOKEN_SHA256=[a-f0-9]{64}$/);

  const withToken = await captureStdout(() => runCli(['auth', 'generate', '--show-token']));
  expect(withToken.code).toBe(0);
  const shown = withToken.out.trim().split('\n');
  expect(shown).toHaveLength(2);
  expect(shown[0]).toMatch(/^BRAIN_TOKEN_SHA256=([a-f0-9]{64})$/);
  expect(digest(shown[1])).toBe(shown[0].split('=')[1]);
});

test('auth migrate selects exactly one legacy entry and never emits raw tokens', async () => {
  const root = mkdtempSync(join('/tmp/opencode', 'brain-auth-'));
  const path = join(root, 'credentials.json');
  const first = 'first-legacy-token';
  const second = 'second-legacy-token';
  writeFileSync(
    path,
    `${JSON.stringify({
      credentials: [
        { token_sha256: digest(first), principal: workerPrincipal },
        { token_sha256: digest(second), principal: workerPrincipal }
      ]
    })}\n`,
    'utf8'
  );

  const migrated = await captureStdout(() =>
    runCli(['auth', 'migrate', '--credentials-file', path, '--select-entry', '2'])
  );
  expect(migrated.code).toBe(0);
  expect(migrated.out.trim()).toBe(`BRAIN_TOKEN_SHA256=${digest(second)}`);
  expect(migrated.out).not.toContain(second);
  expect(migrated.out).not.toContain(first);

  await expect(
    runCli(['auth', 'migrate', '--credentials-file', path, '--select-entry', '3'])
  ).rejects.toThrow(/INVALID_INPUT/);
  await expect(
    runCli(['auth', 'migrate', '--credentials-file', path, '--select-entry', '0'])
  ).rejects.toThrow(/INVALID_INPUT/);
  await expect(runCli(['auth', 'migrate', '--credentials-file', path])).rejects.toThrow(
    /INVALID_INPUT/
  );
});
