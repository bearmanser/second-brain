import { expect, test } from 'vitest';
import {
  assertNotePath,
  dirOf,
  isIgnoredPath,
  isProjectNotePath,
  noteDirectory,
  projectNotePath,
  projectOfPath,
  sanitizeFileStem,
  slugify,
  stemOf,
  withCollisionSuffix
} from '../../src/vault/paths.js';

test('sanitizes titles into filename stems', () => {
  expect(sanitizeFileStem('Model routing preference (revised): Opus implementer, GPT-6 Astra reviewer/escalation'))
    .toBe('Model routing preference (revised) Opus implementer, GPT-6 Astra reviewer escalation');
  expect(sanitizeFileStem('  a\tb\n  c  ')).toBe('a b c');
  expect(sanitizeFileStem('trailing dots...')).toBe('trailing dots');
  expect(sanitizeFileStem('Kunnskapsoppslag med æøå')).toBe('Kunnskapsoppslag med æøå');
  expect(sanitizeFileStem('///')).toBe('Untitled');
  expect(sanitizeFileStem('')).toBe('Untitled');
  expect(Array.from(sanitizeFileStem('x'.repeat(150))).length).toBe(100);
  expect(sanitizeFileStem('😀'.repeat(120))).toBe('😀'.repeat(100));
});

test('slugifies project names and never returns an empty key', () => {
  expect(slugify('Second Brain')).toBe('second-brain');
  expect(slugify('FreeLLM API')).toBe('freellm-api');
  expect(slugify('Café Notes')).toBe('cafe-notes');
  expect(slugify('Æøå')).toBe('a');
  expect(slugify('!!!')).toBe('project');
});

test('accepts safe vault-relative note paths', () => {
  expect(assertNotePath('Projects/Second Brain/Note.md')).toBe('Projects/Second Brain/Note.md');
  expect(assertNotePath('Notes/a.md')).toBe('Notes/a.md');
});

test('rejects unsafe or non-note paths', () => {
  for (const bad of [
    '', '/abs.md', 'C:/x.md', '../x.md', 'a/../b.md', 'a//b.md', './a.md', 'a\\b.md',
    'a%2fb.md', 'a%2e%2e/b.md', 'a\u0000.md', 'a.txt', '.obsidian/x.md', '.trash/x.md', 42
  ]) {
    expect(() => assertNotePath(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  }
});

test('derives projects and locations from paths', () => {
  expect(isIgnoredPath('.obsidian/app.json')).toBe(true);
  expect(isIgnoredPath('Projects/.trash/x.md')).toBe(false);
  expect(projectOfPath('Projects/Shared/a.md')).toBe('Shared');
  expect(projectOfPath('Projects/Shared/sub/a.md')).toBe('Shared');
  expect(projectOfPath('Projects/a.md')).toBeNull();
  expect(projectOfPath('Notes/a.md')).toBeNull();
  expect(isProjectNotePath('Projects/Shared/Shared.md')).toBe(true);
  expect(isProjectNotePath('Projects/Shared/Other.md')).toBe(false);
  expect(isProjectNotePath('Projects/Shared/sub/Shared.md')).toBe(false);
  expect(projectNotePath('Second Brain')).toBe('Projects/Second Brain/Second Brain.md');
  expect(noteDirectory(null)).toBe('Notes');
  expect(noteDirectory('Doccary')).toBe('Projects/Doccary');
  expect(stemOf('Projects/A/My note.md')).toBe('My note');
  expect(dirOf('Projects/A/My note.md')).toBe('Projects/A');
  expect(dirOf('top.md')).toBe('');
});

test('appends collision suffixes', () => {
  const taken = new Set(['Note', 'Note (2)']);
  expect(withCollisionSuffix('Fresh', (c) => taken.has(c))).toBe('Fresh');
  expect(withCollisionSuffix('Note', (c) => taken.has(c))).toBe('Note (3)');
});
