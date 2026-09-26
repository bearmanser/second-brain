import { expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';

const DIGEST = 'a'.repeat(64);

test('applies defaults', () => {
  expect(loadConfig({ BRAIN_TOKEN_SHA256: DIGEST })).toEqual({
    tokenSha256: DIGEST,
    vaultDir: '/vault',
    stateDir: '/var/lib/second-brain',
    port: 7331,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: [],
    scanIntervalMs: 30000
  });
});

test('parses overrides', () => {
  const config = loadConfig({
    BRAIN_TOKEN_SHA256: DIGEST,
    BRAIN_VAULT_DIR: '/v',
    BRAIN_STATE_DIR: '/s',
    BRAIN_PORT: '0',
    BRAIN_ALLOWED_HOSTS: ' 127.0.0.1 , Brain.Example ',
    BRAIN_ALLOWED_ORIGINS: 'http://127.0.0.1:7331,http://100.68.146.36:7331',
    BRAIN_SCAN_INTERVAL_MS: '500'
  });
  expect(config.port).toBe(0);
  expect(config.allowedHosts).toEqual(['127.0.0.1', 'brain.example']);
  expect(config.allowedOrigins).toEqual(['http://127.0.0.1:7331', 'http://100.68.146.36:7331']);
  expect(config.scanIntervalMs).toBe(500);
});

test('rejects invalid values with operator-facing messages', () => {
  expect(() => loadConfig({})).toThrow(/BRAIN_TOKEN_SHA256/);
  expect(() => loadConfig({ BRAIN_TOKEN_SHA256: 'A'.repeat(64) })).toThrow(/BRAIN_TOKEN_SHA256/);
  expect(() => loadConfig({ BRAIN_TOKEN_SHA256: DIGEST, BRAIN_PORT: '70000' })).toThrow(/BRAIN_PORT/);
  expect(() => loadConfig({ BRAIN_TOKEN_SHA256: DIGEST, BRAIN_PORT: '12ab' })).toThrow(/BRAIN_PORT/);
  expect(() => loadConfig({ BRAIN_TOKEN_SHA256: DIGEST, BRAIN_SCAN_INTERVAL_MS: '10' })).toThrow(/BRAIN_SCAN_INTERVAL_MS/);
  expect(() => loadConfig({ BRAIN_TOKEN_SHA256: DIGEST, BRAIN_ALLOWED_ORIGINS: 'http://x/path' })).toThrow(/BRAIN_ALLOWED_ORIGINS/);
  expect(() => loadConfig({ BRAIN_TOKEN_SHA256: DIGEST, BRAIN_ALLOWED_ORIGINS: 'not a url' })).toThrow(/BRAIN_ALLOWED_ORIGINS/);
});
