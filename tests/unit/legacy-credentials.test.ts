import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  listLegacyCredentialDigests,
  selectLegacyCredentialDigest
} from '../../src/operations/legacy-credentials.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function writeCredentials(entries: unknown, contents?: string): { path: string; root: string } {
  const root = mkdtempSync(join('/tmp/opencode', 'legacy-credentials-'));
  const path = join(root, 'credentials.json');
  writeFileSync(path, contents ?? `${JSON.stringify({ credentials: entries }, null, 2)}\n`, 'utf8');
  return { path, root };
}

const legacyEntries = [
  {
    token_sha256: digest('worker-token'),
    principal: { id: 'worker', role: 'worker', read_scopes: ['shared'] }
  },
  {
    token_sha256: digest('owner-token'),
    principal: { id: 'owner', role: 'owner', read_scopes: ['shared', 'profile'] }
  }
];

test('selects exactly one explicitly numbered legacy digest', () => {
  const { path } = writeCredentials(legacyEntries);
  expect(selectLegacyCredentialDigest(path, 1)).toBe(digest('worker-token'));
  expect(selectLegacyCredentialDigest(path, 2)).toBe(digest('owner-token'));
});

test('lists digest-only entries without exporting a role model', () => {
  const { path } = writeCredentials(legacyEntries);
  const entries = listLegacyCredentialDigests(path);
  expect(entries).toEqual([
    { token_sha256: digest('worker-token') },
    { token_sha256: digest('owner-token') }
  ]);
  expect(Object.keys(entries[0])).toEqual(['token_sha256']);
});

test('does not modify the legacy credentials file', () => {
  const { path } = writeCredentials(legacyEntries);
  const before = readFileSync(path);
  selectLegacyCredentialDigest(path, 2);
  listLegacyCredentialDigests(path);
  expect(readFileSync(path)).toEqual(before);
});

test('rejects an explicit selection outside the recorded entries', () => {
  const { path } = writeCredentials(legacyEntries);
  expect(() => selectLegacyCredentialDigest(path, 0)).toThrow(/INVALID_INPUT/);
  expect(() => selectLegacyCredentialDigest(path, -1)).toThrow(/INVALID_INPUT/);
  expect(() => selectLegacyCredentialDigest(path, 3)).toThrow(/INVALID_INPUT/);
  expect(() => selectLegacyCredentialDigest(path, 1.5)).toThrow(/INVALID_INPUT/);
});

test('rejects malformed, duplicate and missing legacy credential files', () => {
  const malformed = writeCredentials([], '{not json');
  expect(() => listLegacyCredentialDigests(malformed.path)).toThrow(/INVALID_INPUT/);

  const duplicate = writeCredentials([
    { token_sha256: digest('same'), principal: { id: 'a' } },
    { token_sha256: digest('same'), principal: { id: 'b' } }
  ]);
  expect(() => listLegacyCredentialDigests(duplicate.path)).toThrow(/INVALID_INPUT/);

  const shortDigest = writeCredentials([
    { token_sha256: 'short', principal: { id: 'a' } }
  ]);
  expect(() => listLegacyCredentialDigests(shortDigest.path)).toThrow(/INVALID_INPUT/);

  const missing = join(mkdtempSync(join('/tmp/opencode', 'legacy-credentials-')), 'missing.json');
  expect(() => listLegacyCredentialDigests(missing)).toThrow(/INVALID_INPUT/);
});

test('rejects an empty credentials list rather than defaulting', () => {
  const { path } = writeCredentials([]);
  expect(() => listLegacyCredentialDigests(path)).toThrow(/INVALID_INPUT/);
  expect(() => selectLegacyCredentialDigest(path, 1)).toThrow(/INVALID_INPUT/);
});
