import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ensureProject } from '../../src/features/project-ensure.js';
import { legacyNotePaths } from '../../src/notes/identity.js';
import { allocateNotePath, allocateProjectRoot, collisionKey, safeBasename } from '../../src/notes/paths.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { workerContext } from '../fixtures/principals.js';
import { createLegacyHarness } from '../support/harness.js';

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

test('a deep directory with a collision is rejected instead of emitting an over-long path', () => {
  const collisionDirectory = 'E'.repeat(213);
  const base = allocateNotePath({ directory: collisionDirectory, title: 'Name', occupied: [] });
  expect(Buffer.byteLength(base, 'utf8')).toBeLessThanOrEqual(220);
  expect(() =>
    allocateNotePath({ directory: collisionDirectory, title: 'Name', occupied: [base] })
  ).toThrow(/INVALID_INPUT/);

  const noRoom = 'D'.repeat(217);
  expect(() => allocateNotePath({ directory: noRoom, title: 'x', occupied: [] })).toThrow(
    /INVALID_INPUT/
  );
});

test('a device-shaped truncation cannot emit a reserved Windows name', () => {
  const directory = 'D'.repeat(213);
  const path = allocateNotePath({ directory, title: 'CONfederation', occupied: [] });
  expect(Buffer.byteLength(path, 'utf8')).toBeLessThanOrEqual(220);
  const basename = path.slice(directory.length + 1);
  const head = (basename.split('.')[0] ?? '').replace(/[. ]+$/u, '');
  expect(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(head)).toBe(false);
  expect(safeBasename('conference')).toBe('conference');
});

test('superscript device-number aliases are reserved names and directory segments', () => {
  expect(safeBasename('COM\u00b9')).toBe('COM\u00b9_');
  expect(safeBasename('LPT\u00b2.md')).toBe('LPT\u00b2_.md');
  expect(safeBasename('com\u00b3')).toBe('com\u00b3_');
  expect(allocateNotePath({ directory: 'Knowledge', title: 'COM\u00b9', occupied: [] })).toBe(
    'Knowledge/COM\u00b9_.md'
  );
  expect(() =>
    allocateNotePath({ directory: 'Knowledge/LPT\u00b2', title: 'X', occupied: [] })
  ).toThrow(/INVALID_INPUT/);
});

test('unpaired surrogates are replaced consistently before fitting and collision checks', () => {
  const name = safeBasename('broken \uD800 name');
  expect(name).toBe('broken \uFFFD name');
  expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name);
  const path = allocateNotePath({ directory: 'Knowledge', title: 'x\uDFFF', occupied: [] });
  expect(path).toBe('Knowledge/x\uFFFD.md');
  expect(collisionKey(path)).toBe(collisionKey(Buffer.from(path, 'utf8').toString('utf8')));
  expect(
    allocateNotePath({
      directory: 'Knowledge',
      title: 'x\uD800',
      occupied: ['Knowledge/x\uFFFD.md']
    })
  ).toBe('Knowledge/x\uFFFD (2).md');
  expect(
    allocateNotePath({
      directory: 'Knowledge',
      title: 'x\uFFFD',
      occupied: ['Knowledge/x\uD800.md']
    })
  ).toBe('Knowledge/x\uFFFD (2).md');
  expect(() =>
    allocateNotePath({ directory: 'Knowledge/bad\uD800', title: 'x', occupied: [] })
  ).toThrow(/INVALID_INPUT/);
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
  const h = await createLegacyHarness();
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
  const h = await createLegacyHarness();
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
  const h = await createLegacyHarness();
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
  const h = await createLegacyHarness();
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

test('project ensure never adopts an existing unregistered Projects directory', async () => {
  const h = await createLegacyHarness();
  try {
    const vault = h.deps.config.mounts.vault;
    const humanRoot = join(vault, 'Projects', 'human-made');
    await mkdir(humanRoot, { recursive: true });
    const result = await ensureProject(
      workerContext,
      request('https://github.com/example/human-made.git'),
      h.deps
    );
    const project = h.deps.journal.getProjectByIdentity('github.com/example/human-made')?.project;
    expect(result.created).toBe(true);
    expect(project?.relative_root).toBe('Projects/example human-made');
    expect(existsSync(humanRoot)).toBe(true);
    expect(existsSync(join(vault, project?.relative_root ?? 'missing'))).toBe(true);
  } finally {
    await h.close();
  }
});

test('project ensure fails closed when the Projects inventory cannot be read', async () => {
  const h = await createLegacyHarness();
  try {
    const vault = h.deps.config.mounts.vault;
    const projectsPath = join(vault, 'Projects');
    await writeFile(projectsPath, 'not a directory\n');
    await expect(
      ensureProject(workerContext, request('https://github.com/example/fail-closed.git'), h.deps)
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(
      h.deps.journal.getProjectByIdentity('github.com/example/fail-closed')
    ).toBeUndefined();
    expect(h.deps.journal.countProjects()).toBe(0);
    expect(readFileSync(projectsPath, 'utf8')).toBe('not a directory\n');
  } finally {
    await h.close();
  }
});

test('project ensure refuses allocation for a dangling Projects symlink', async () => {
  const h = await createLegacyHarness();
  try {
    const vault = h.deps.config.mounts.vault;
    await symlink(join(vault, 'missing-target'), join(vault, 'Projects'));
    await expect(
      ensureProject(workerContext, request('https://github.com/example/dangling.git'), h.deps)
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(
      h.deps.journal.getProjectByIdentity('github.com/example/dangling')
    ).toBeUndefined();
    expect(h.deps.journal.countProjects()).toBe(0);
  } finally {
    await h.close();
  }
});

test('project ensure refuses allocation when the vault root is missing', async () => {
  const h = await createLegacyHarness();
  try {
    const vault = h.deps.config.mounts.vault;
    await rm(vault, { recursive: true, force: true });
    await expect(
      ensureProject(workerContext, request('https://github.com/example/no-vault.git'), h.deps)
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(
      h.deps.journal.getProjectByIdentity('github.com/example/no-vault')
    ).toBeUndefined();
    expect(h.deps.journal.countProjects()).toBe(0);
  } finally {
    await h.close();
  }
});
