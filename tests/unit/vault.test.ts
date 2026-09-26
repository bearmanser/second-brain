import { existsSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Vault, sha256 } from '../../src/vault/vault.js';
import { scratch, writeTree } from '../helpers.js';

function vaultWith(files: Record<string, string>): { vault: Vault; root: string } {
  const root = scratch('vault');
  writeTree(root, files);
  return { vault: new Vault(root), root };
}

test('lists markdown notes and skips dot entries, other files, and symlinks', () => {
  const { vault, root } = vaultWith({
    'Projects/A/one.md': '1',
    'Notes/two.md': '22',
    '.obsidian/app.md': 'x',
    '.trash/old.md': 'x',
    'Projects/A/.hidden.md': 'x',
    'Projects/A/image.png': 'x'
  });
  symlinkSync(join(root, 'Notes/two.md'), join(root, 'Notes/link.md'));
  const files = vault.list().map((f) => f.path).sort();
  expect(files).toEqual(['Notes/two.md', 'Projects/A/one.md']);
  expect(vault.list().find((f) => f.path === 'Notes/two.md')?.size).toBe(2);
});

test('reads, stats, and checks existence', () => {
  const { vault } = vaultWith({ 'Notes/a.md': 'hello' });
  expect(vault.read('Notes/a.md')).toBe('hello');
  expect(vault.stat('Notes/a.md').size).toBe(5);
  expect(vault.exists('Notes/a.md')).toBe(true);
  expect(vault.exists('Notes/missing.md')).toBe(false);
  expect(() => vault.read('Notes/missing.md')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
});

test('refuses to cross symbolic links', () => {
  const { vault, root } = vaultWith({ 'real/a.md': 'x' });
  symlinkSync(join(root, 'real'), join(root, 'linked'));
  expect(() => vault.read('linked/a.md')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  expect(() => vault.write('linked/b.md', 'y')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

test('writes atomically into new directories without leaving temp files', () => {
  const { vault, root } = vaultWith({});
  vault.write('Projects/New/note.md', 'content');
  expect(readFileSync(join(root, 'Projects/New/note.md'), 'utf8')).toBe('content');
  vault.write('Projects/New/note.md', 'replaced');
  expect(readFileSync(join(root, 'Projects/New/note.md'), 'utf8')).toBe('replaced');
  expect(readdirSync(join(root, 'Projects/New'))).toEqual(['note.md']);
});

test('moves notes into .trash with collision suffixes', () => {
  const { vault, root } = vaultWith({ 'Notes/a.md': '1', 'Projects/P/a.md': '2' });
  expect(vault.trash('Notes/a.md')).toBe('.trash/a.md');
  expect(vault.trash('Projects/P/a.md')).toBe('.trash/a (2).md');
  expect(existsSync(join(root, 'Notes/a.md'))).toBe(false);
  expect(readFileSync(join(root, '.trash/a (2).md'), 'utf8')).toBe('2');
});

test('removes files and lists project folders', () => {
  const { vault, root } = vaultWith({ 'Projects/B/x.md': '', 'Projects/A/y.md': '', 'Projects/.hidden/z.md': '' });
  writeFileSync(join(root, 'Projects/file.md'), '');
  vault.remove('Projects/B/x.md');
  expect(vault.exists('Projects/B/x.md')).toBe(false);
  expect(vault.projectFolders()).toEqual(['A', 'B']);
});

test('reports mtime changes', () => {
  const { vault, root } = vaultWith({ 'Notes/a.md': 'x' });
  utimesSync(join(root, 'Notes/a.md'), new Date(1000), new Date(2000));
  expect(vault.stat('Notes/a.md').mtimeMs).toBe(2000);
});

test('hashes with sha256', () => {
  expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
