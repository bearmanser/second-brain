import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const NODE_DIGEST = `node@sha256:${'a'.repeat(64)}`;
const BACKEND_DIGEST = `ghcr.io/basicmachines-co/basic-memory@sha256:${'b'.repeat(64)}`;

const FAKE_DOCKER = `#!/bin/sh
case "$*" in
  *RepoDigests*node:24-alpine) echo '["${NODE_DIGEST}"]' ;;
  *RepoDigests*basic-memory:latest) echo '["${BACKEND_DIGEST}"]' ;;
  *image.version*) echo '0.23.2' ;;
  *image.revision*) echo 'c0bd87c6d5a4a58034b1d6c8c5018e443b0bd048' ;;
  *) echo "unexpected docker call: $*" >&2; exit 9 ;;
esac
`;

const FAKE_NPM = `#!/bin/sh
echo '10.9.9'
`;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sandbox(previousLock?: string): { bin: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), 'lock-images-'));
  directories.push(root);
  const bin = join(root, 'bin');
  const config = join(root, 'config');
  spawnSync('mkdir', ['-p', bin, config]);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  writeFileSync(join(bin, 'npm'), FAKE_NPM);
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  if (previousLock !== undefined) writeFileSync(join(config, 'dependency-lock.json'), previousLock);
  return { bin, config };
}

function runLockImages(bin: string, config: string) {
  return spawnSync(process.execPath, ['scripts/lock-images.mjs', '--config-dir', config], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin` }
  });
}

test('refreshing image metadata preserves the committed Laya provenance section', () => {
  const committed = JSON.parse(readFileSync('config/dependency-lock.json', 'utf8')) as Record<string, unknown>;
  expect(committed.laya).toBeDefined();
  const stale = { ...committed, images: { NODE_IMAGE: 'old', BASIC_MEMORY_IMAGE: 'old' } };
  const { bin, config } = sandbox(`${JSON.stringify(stale, null, 2)}\n`);
  const run = runLockImages(bin, config);
  expect(run.status, run.stderr).toBe(0);
  const refreshed = JSON.parse(readFileSync(join(config, 'dependency-lock.json'), 'utf8')) as Record<string, unknown>;
  expect(refreshed.laya).toEqual(committed.laya);
  expect(refreshed.images).toEqual({ NODE_IMAGE: NODE_DIGEST, BASIC_MEMORY_IMAGE: BACKEND_DIGEST });
  expect((refreshed.runtime as Record<string, unknown>).npm).toBe('10.9.9');
  expect(readFileSync(join(config, 'images.env'), 'utf8')).toBe(`NODE_IMAGE=${NODE_DIGEST}\nBASIC_MEMORY_IMAGE=${BACKEND_DIGEST}\n`);
});

test('a fresh lock without a previous file has no Laya section to preserve', () => {
  const { bin, config } = sandbox();
  const run = runLockImages(bin, config);
  expect(run.status, run.stderr).toBe(0);
  const created = JSON.parse(readFileSync(join(config, 'dependency-lock.json'), 'utf8')) as Record<string, unknown>;
  expect(created.laya).toBeUndefined();
  expect(created.images).toEqual({ NODE_IMAGE: NODE_DIGEST, BASIC_MEMORY_IMAGE: BACKEND_DIGEST });
});

test('refuses to overwrite an unreadable or malformed previous lock', () => {
  for (const previous of ['{not json', JSON.stringify({ schemaVersion: 1, laya: 'dropped' })]) {
    const { bin, config } = sandbox(previous);
    const run = runLockImages(bin, config);
    expect(run.status).not.toBe(0);
    expect(readFileSync(join(config, 'dependency-lock.json'), 'utf8')).toBe(previous);
  }
});
