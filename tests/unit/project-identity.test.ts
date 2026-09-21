import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  normalizeRepositoryIdentity,
  scopeCandidateForRepository,
  scopeWithCollisionSuffix
} from '../../src/projects/identity.js';

test.each([
  'https://github.com/bearmanser/second-brain.git',
  'ssh://git@github.com/bearmanser/second-brain.git',
  'git@github.com:bearmanser/second-brain.git'
])('normalizes equivalent Git remotes to one repository identity', (remote) => {
  expect(normalizeRepositoryIdentity(remote)).toBe('github.com/bearmanser/second-brain');
});

test('removes the SSH default port and preserves valid at-signs in repository paths', () => {
  expect(normalizeRepositoryIdentity('ssh://git@github.com:22/owner/repo.git')).toBe(
    'github.com/owner/repo'
  );
  expect(normalizeRepositoryIdentity('https://github.com/owner/repo@v2.git')).toBe(
    'github.com/owner/repo@v2'
  );
});

test('lowercases and IDNA-normalizes the host while preserving repository path case', () => {
  expect(normalizeRepositoryIdentity('https://BÜCHER.example/Owner/Repo.GIT')).toBe(
    'xn--bcher-kva.example/Owner/Repo'
  );
});

test.each([
  '',
  'https://github.com',
  'https://github.com/',
  'C:\\Git\\second-brain',
  '/srv/git/second-brain',
  './second-brain',
  'https://github.com/owner/repo.git?token=secret',
  'https://github.com/owner/repo.git#branch',
  'https://github.com/owner%2Frepo.git',
  'https://github.com/owner%5Crepo.git',
  'https://github.com/owner/../repo.git',
  'https://github.com/owner/./repo.git',
  'https://user:secret@github.com/owner/repo.git',
  'ssh://deploy@github.com/owner/repo.git',
  'ssh://ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/owner/repo.git',
  'deploy@github.com:owner/repo.git',
  'git@github.com:owner//repo.git',
  'git@github.com:owner/repo.git\nmalicious'
])('rejects malformed or unsafe repository identity input without echoing it', (remote) => {
  try {
    normalizeRepositoryIdentity(remote);
  } catch (error) {
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    if (remote.length > 0) expect((error as Error).message).not.toContain(remote);
    expect((error as Error).message).not.toContain('secret');
    return;
  }
  throw new Error('expected repository identity rejection');
});

test('derives a bounded readable scope and rejects protected scope names', () => {
  expect(scopeCandidateForRepository('github.com/Owner/My.Repository')).toBe('my-repository');
  expect(scopeCandidateForRepository(`github.com/owner/${'A'.repeat(100)}`)).toBe(
    'a'.repeat(64)
  );
  for (const reserved of ['shared', 'profile']) {
    expect(() => scopeCandidateForRepository(`github.com/owner/${reserved}`)).toThrow(
      /INVALID_INPUT/
    );
  }
  expect(() => scopeCandidateForRepository('github.com/owner/---')).toThrow(/INVALID_INPUT/);
});

test('adds a deterministic collision suffix while preserving the scope limit', () => {
  const identity = 'github.com/other/second-brain';
  const suffix = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 10);
  expect(scopeWithCollisionSuffix('second-brain', identity)).toBe(`second-brain-${suffix}`);
  const long = scopeWithCollisionSuffix('a'.repeat(64), identity);
  expect(long).toBe(`${'a'.repeat(53)}-${suffix}`);
  expect(long).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
});
