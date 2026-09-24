import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { ensureProject } from '../../src/features/project-ensure.js';
import { legacyNotePaths } from '../../src/notes/identity.js';
import { allocateNotePath, allocateProjectRoot, collisionKey, safeBasename } from '../../src/notes/paths.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { workerContext } from '../fixtures/principals.js';
import { createHarness } from '../support/harness.js';

const request = (remote_url: string, display_name?: string) => ({
  idempotency_key: randomUUID(),
  remote_url,
  ...(display_name === undefined ? {} : { display_name })
});

test('collisions stay human readable and never overwrite another note', () => {
  const path = allocateNotePath({
    directory: 'Projects/Second Brain/Decisions',
    title: 'Memory retrieval',
    occupied: ['Projects/Second Brain/Decisions/Memory retrieval.md']
  });
  expect(path).toBe('Projects/Second Brain/Decisions/Memory retrieval (2).md');
  expect(safeBasename('Læring fra feilsøking')).toBe('Læring fra feilsøking');
  expect(safeBasename('CON')).not.toBe('CON');
});

test('preserves Unicode letters while replacing reserved and ambiguous characters', () => {
  expect(safeBasename('Læring fra feilsøking')).toBe('Læring fra feilsøking');
  expect(safeBasename('Æ Ø Å og blåbærsyltetøy')).toBe('Æ Ø Å og blåbærsyltetøy');
  expect(safeBasename('a#b^c[d]e|f')).toBe('a b c d e f');
  expect(safeBasename('bad:name?.md')).toBe('bad name .md');
  expect(safeBasename('a\u0000b\u001fc')).toBe('a b c');
  expect(safeBasename('  spaced   out  ')).toBe('spaced out');
  expect(safeBasename('trailing space. ')).toBe('trailing space');
  expect(safeBasename('...')).toBe('Note');
});

test('never emits a Windows reserved device basename, with or without an extension', () => {
  for (const title of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
    const safe = safeBasename(title);
    expect(safe.toUpperCase()).not.toBe(title.toUpperCase());
    expect(collisionKey(safe)).not.toBe(collisionKey(title));
  }
  expect(safeBasename('NUL.txt')).toBe('NUL_.txt');
  expect(safeBasename('com1.log')).toBe('com1_.log');
  expect(allocateNotePath({ directory: 'Knowledge', title: 'CON', occupied: [] })).toBe(
    'Knowledge/CON_.md'
  );
});

test('case-only collisions share one normalized collision key', () => {
  expect(collisionKey('Knowledge/Release Notes.md')).toBe(collisionKey('knowledge/release notes.MD'));
  expect(
    allocateNotePath({
      directory: 'Knowledge',
      title: 'release NOTES',
      occupied: ['Knowledge/Release notes.md']
    })
  ).toBe('Knowledge/release NOTES (2).md');
});

test('composed and decomposed Unicode names collide after NFC normalization', () => {
  expect(collisionKey('Knowledge/Caf\u00e9.md')).toBe(collisionKey('Knowledge/Cafe\u0301.md'));
  expect(
    allocateNotePath({
      directory: 'Knowledge',
      title: 'Cafe\u0301',
      occupied: ['Knowledge/Caf\u00e9.md']
    })
  ).toBe('Knowledge/Caf\u00e9 (2).md');
});

test('generated basenames and vault-relative paths stay inside their byte limits', () => {
  const title = 'Æ'.repeat(200);
  expect(Buffer.byteLength(safeBasename(title), 'utf8')).toBeLessThanOrEqual(100);
  const path = allocateNotePath({ directory: 'Knowledge', title, occupied: [] });
  const basename = path.slice('Knowledge/'.length);
  expect(Buffer.byteLength(basename, 'utf8')).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(path, 'utf8')).toBeLessThanOrEqual(220);
  expect(path.endsWith('.md')).toBe(true);
  expect(Buffer.from(path, 'utf8').toString('utf8')).toBe(path);

  const deep = `${'D'.repeat(90)}/${'E'.repeat(90)}`;
  const deepPath = allocateNotePath({ directory: deep, title, occupied: [] });
  expect(Buffer.byteLength(deepPath, 'utf8')).toBeLessThanOrEqual(220);
  expect(Buffer.from(deepPath, 'utf8').toString('utf8')).toBe(deepPath);
});

test('collision suffixes still respect the basename and path byte limits', () => {
  const title = 'B'.repeat(300);
  const occupied = [`Knowledge/${'B'.repeat(97)}.md`];
  const path = allocateNotePath({ directory: 'Knowledge', title, occupied });
  expect(path.endsWith(' (2).md')).toBe(true);
  expect(Buffer.byteLength(path.slice('Knowledge/'.length), 'utf8')).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(path, 'utf8')).toBeLessThanOrEqual(220);
});

test('project roots stay human readable inside the byte limits', () => {
  const root = allocateProjectRoot('Æ'.repeat(200), []);
  expect(root.startsWith('Projects/')).toBe(true);
  expect(Buffer.byteLength(root, 'utf8')).toBeLessThanOrEqual(220);
  expect(Buffer.byteLength(root.slice('Projects/'.length), 'utf8')).toBeLessThanOrEqual(100);
});

test('rejects unsafe directory arguments before sanitizing the title', () => {
  for (const directory of [
    '',
    '../escape',
    'Projects/../../etc',
    '/absolute',
    'C:\\absolute',
    'Projects//Decisions',
    'Projects/./Decisions',
    'Projects/Decisions/..',
    'Projects/.hidden',
    'a\\b',
    'Projects/Decisions/'
  ]) {
    expect(() => allocateNotePath({ directory, title: 'Safe', occupied: [] })).toThrow(
      /INVALID_INPUT/
    );
  }
});

test('normalizes directory components to NFC', () => {
  expect(
    allocateNotePath({ directory: 'Knowledge/Cafe\u0301', title: 'X', occupied: [] })
  ).toBe('Knowledge/Caf\u00e9/X.md');
});

test('a traversal-shaped project display name becomes one safe segment', () => {
  expect(allocateProjectRoot('../escape', [])).toBe('Projects/escape');
});

test('a traversal-shaped title becomes one safe path component', () => {
  expect(
    allocateNotePath({ directory: 'Knowledge', title: '../../etc/passwd', occupied: [] })
  ).toBe('Knowledge/etc passwd.md');
  expect(
    allocateNotePath({ directory: 'Knowledge', title: '..\\..\\windows', occupied: [] })
  ).toBe('Knowledge/windows.md');
});

test('duplicate suffixes are deterministic, readable, and never overwrite', () => {
  const occupied = ['Inbox/Memory retrieval.md', 'inbox/memory retrieval (2).md'];
  expect(
    allocateNotePath({ directory: 'Inbox', title: 'Memory retrieval', occupied })
  ).toBe('Inbox/Memory retrieval (3).md');
  expect(
    allocateNotePath({ directory: 'Inbox', title: 'Memory retrieval', occupied: [...occupied] })
  ).toBe('Inbox/Memory retrieval (3).md');
});

test('project and type folders qualify titles before a numeric suffix is needed', () => {
  expect(
    allocateNotePath({
      directory: 'Projects/Alpha/Notes',
      title: 'Overview',
      occupied: ['Projects/Beta/Notes/Overview.md', 'Knowledge/Overview.md']
    })
  ).toBe('Projects/Alpha/Notes/Overview.md');
});

test('a generated note path never falls back to an opaque identifier', () => {
  const path = allocateNotePath({
    directory: 'Knowledge',
    title: 'Memory retrieval',
    occupied: ['Knowledge/Memory retrieval.md']
  });
  expect(path).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  expect(path).not.toMatch(/[0-9a-f]{10,}/i);
});

test('the legacy revision path helpers remain available to the migration reader', () => {
  expect(legacyNotePaths.slugify('Hello World')).toBe('hello-world');
  expect(legacyNotePaths.revisionDirectory('decision', 'note-id')).toBe('Decisions/note-id');
});

test('allocates readable, collision-safe project roots', () => {
  expect(allocateProjectRoot('Second Brain', [])).toBe('Projects/Second Brain');
  expect(allocateProjectRoot('Second Brain', ['Projects/Second Brain'])).toBe(
    'Projects/Second Brain (2)'
  );
  expect(allocateProjectRoot('Læring', ['Projects/læring'])).toBe('Projects/Læring (2)');
  expect(() => allocateProjectRoot('..', [])).toThrow(/INVALID_INPUT/);
  expect(() => allocateProjectRoot('   ', [])).toThrow(/INVALID_INPUT/);
});

test('project registry treats display names as editable metadata, not identity', () => {
  const registry = new ProjectRegistry([
    { id: 'project-a', display_name: 'First Name', relative_root: 'Projects/project-a' },
    { id: 'project-a', display_name: 'Readable Name', relative_root: 'Projects/project-a' }
  ]);
  expect(registry.get('project-a')?.display_name).toBe('Readable Name');
  expect(
    () =>
      new ProjectRegistry([
        { id: 'project-a', display_name: 'A', relative_root: 'Projects/project-a' },
        { id: 'project-a', display_name: 'A', relative_root: 'Projects/elsewhere' }
      ])
  ).toThrow(/CONFLICT/);
});

test('project ensure persists a readable display name and its vault root', async () => {
  const h = await createHarness();
  try {
    const result = await ensureProject(
      workerContext,
      request('https://github.com/example/Readable.Name.git'),
      h.deps
    );
    expect(result.scope).toBe('readable-name');
    expect(
      h.deps.journal.getProjectByIdentity('github.com/example/Readable.Name')?.project
    ).toMatchObject({
      id: 'readable-name',
      display_name: 'Readable.Name',
      relative_root: 'Projects/Readable.Name'
    });
  } finally {
    await h.close();
  }
});

test('project ensure accepts a human display name', async () => {
  const h = await createHarness();
  try {
    const result = await ensureProject(
      workerContext,
      request('https://github.com/example/readable.git', 'Readable Project'),
      h.deps
    );
    expect(
      h.deps.journal.getProjectByIdentity('github.com/example/readable')?.project
    ).toMatchObject({
      id: result.scope,
      display_name: 'Readable Project',
      relative_root: 'Projects/Readable Project'
    });
  } finally {
    await h.close();
  }
});

test('a changed display name never creates a second project for one remote', async () => {
  const h = await createHarness();
  try {
    const remote = 'https://github.com/example/stable.git';
    const first = await ensureProject(workerContext, request(remote, 'First Label'), h.deps);
    const second = await ensureProject(workerContext, request(remote, 'Second Label'), h.deps);
    expect(second.scope).toBe(first.scope);
    expect(second.created).toBe(false);
    expect(h.deps.journal.countProjects()).toBe(1);
    expect(
      h.deps.journal.getProjectByIdentity('github.com/example/stable')?.project.display_name
    ).toBe('First Label');
  } finally {
    await h.close();
  }
});

test('project ensure qualifies a colliding basename with the repository owner', async () => {
  const h = await createHarness();
  try {
    await ensureProject(workerContext, request('https://github.com/alice/shared-api.git'), h.deps);
    const second = await ensureProject(
      workerContext,
      request('https://github.com/bob/shared-api.git'),
      h.deps
    );
    expect(
      h.deps.journal.getProjectByIdentity('github.com/bob/shared-api')?.project
    ).toMatchObject({
      id: second.scope,
      display_name: 'bob shared-api',
      relative_root: 'Projects/bob shared-api'
    });
  } finally {
    await h.close();
  }
});
