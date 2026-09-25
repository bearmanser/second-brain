import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openBrain } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { scratch, writeTree } from '../helpers.js';

function config(root: string): Config {
  mkdirSync(join(root, 'vault'), { recursive: true });
  return {
    tokenSha256: 'a'.repeat(64),
    vaultDir: join(root, 'vault'),
    stateDir: join(root, 'state'),
    port: 0,
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: [],
    scanIntervalMs: 1000
  };
}

test('opens a brain, scans the vault, and releases the lock on close', () => {
  const root = scratch('app');
  writeTree(join(root, 'vault'), { 'Notes/a.md': '# A\n\ntext\n' });
  const brain = openBrain(config(root));
  expect(brain.index.all().map((note) => note.path)).toEqual(['Notes/a.md']);
  brain.close();
  const again = openBrain(config(root));
  again.close();
});

test('refuses a second instance on the same state directory', () => {
  const root = scratch('app');
  const brain = openBrain(config(root));
  expect(() => openBrain(config(root))).toThrow(/already holds/);
  brain.close();
});

test('reclaims a stale lock left by a dead process', () => {
  const root = scratch('app');
  const setup = config(root);
  mkdirSync(setup.stateDir, { recursive: true });
  writeFileSync(join(setup.stateDir, 'brain.lock'), JSON.stringify({ pid: 999999 }));
  openBrain(setup).close();
});

test('writes index, store, and lock files into the state directory', () => {
  const root = scratch('app');
  const setup = config(root);
  writeTree(join(root, 'vault'), { 'Notes/a.md': '# A\n' });
  const brain = openBrain(setup);
  expect(existsSync(join(setup.stateDir, 'brain.lock'))).toBe(true);
  expect(existsSync(join(setup.stateDir, 'index.db'))).toBe(true);
  expect(existsSync(join(setup.stateDir, 'brain.db'))).toBe(true);
  brain.close();
  expect(existsSync(join(setup.stateDir, 'brain.lock'))).toBe(false);
});
