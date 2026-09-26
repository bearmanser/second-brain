import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { formatReport, runImport } from '../../src/import.js';
import { SearchIndex } from '../../src/index/search-index.js';
import { Sync } from '../../src/index/sync.js';
import { Vault } from '../../src/vault/vault.js';
import { scratch, writeTree } from '../helpers.js';

function journalWith(rows: [string, string][]): string {
  const dir = scratch('journal');
  const file = join(dir, 'journal.db');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE projects_v2 (
      id TEXT PRIMARY KEY,
      repository_identity TEXT UNIQUE,
      display_name TEXT NOT NULL,
      relative_root TEXT NOT NULL UNIQUE,
      legacy_scope TEXT UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'recovery_required')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare(
    'INSERT INTO projects_v2 (id, repository_identity, display_name, relative_root, legacy_scope, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  rows.forEach(([displayName, identity], index) => {
    insert.run(
      `project-${index}`,
      identity,
      displayName,
      displayName,
      null,
      'ready',
      '2026-09-24T07:36:00.360Z',
      '2026-09-24T07:36:00.360Z'
    );
  });
  db.close();
  return file;
}

function oldVault(): string {
  const from = scratch('v1');
  writeTree(from, {
    'Projects/Doccary/Doccary.md':
      '---\ntype: project\n---\n\n# Doccary\n\n![[Projects/Doccary/lessons/token-audit]]\n',
    'Projects/Doccary/lessons/token-audit.md':
      '---\nid: 8a431d1f-1cd5-4892-9386-50bbca8307d1\nschema: 2\ntype: lesson\nstatus: active\ntags:\n  - security\ncreated: 2026-09-24T07:36:00.360Z\nupdated: 2026-09-24T07:36:00.360Z\n---\n\n# Token audit: parent/worker\n\nSee [[Projects/Doccary/lessons/token-audit-two]] and [[token-audit-two]].\n\nUnresolved: [[44b093c5-0000-4000-8000-000000000000]].\n',
    'Projects/Doccary/lessons/token-audit-two.md':
      '---\nid: 11111111-2222-4333-8444-555555555555\ntype: lesson\ncreated: 2026-09-20T00:00:00.000Z\nupdated: 2026-09-20T00:00:00.000Z\n---\n\n# Token audit two\n\nbody\n',
    'Projects/Doccary/archive/old.md': '---\nid: 99999999-9999-4999-8999-999999999999\ntype: lesson\nstatus: archived\n---\n\n# Old\n',
    'Projects/Shared/api-decision.md':
      '---\nid: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\ntype: decision\ntags: [api]\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\n\n# API decision\n\nBare link [[token-audit-two]].\n',
    'Projects/Secondary/Secondary.md': '---\ntype: project\n---\n\n# Secondary\n',
    '.obsidian/app.json': '{}\n',
    '.trash/gone.md': '# gone\n',
    'Profile/.keep': ''
  });
  return from;
}

test('ports notes, rewrites links, and generates project notes', () => {
  const from = oldVault();
  const to = scratch('v2');
  const report = runImport({ from, to, journal: journalWith([['Doccary', 'github.com/Doccary/doccary']]) });
  expect(report.written.sort()).toEqual([
    'Projects/Doccary/Doccary.md',
    'Projects/Doccary/Token audit parent worker.md',
    'Projects/Doccary/Token audit two.md',
    'Projects/Secondary/Secondary.md',
    'Projects/Shared/API decision.md',
    'Projects/Shared/Shared.md'
  ]);
  expect(report.skipped).toEqual([{ path: 'Projects/Doccary/archive/old.md', reason: 'archived' }]);
  expect(report.notCopied.sort()).toEqual(['.trash', 'Profile']);
  expect(report.linksRewritten).toBe(4);
  expect(report.unresolvedLinks).toEqual(['44b093c5-0000-4000-8000-000000000000']);
  expect(readFileSync(join(to, 'Projects/Doccary/Token audit parent worker.md'), 'utf8')).toContain(
    'See [[Projects/Doccary/Token audit two]] and [[Projects/Doccary/Token audit two]].'
  );
  expect(readFileSync(join(to, 'Projects/Doccary/Doccary.md'), 'utf8')).toBe(
    '---\ntype: project\nrepositories:\n  - github.com/Doccary/doccary\n---\n\n# Doccary\n\n![[Projects/Doccary/Token audit parent worker]]\n'
  );
  expect(readFileSync(join(to, 'Projects/Shared/Shared.md'), 'utf8')).toBe('---\ntype: project\nrepositories: []\n---\n\n# Shared\n');
  expect(existsSync(join(to, '.obsidian/app.json'))).toBe(true);
  expect(existsSync(join(to, 'Projects/Doccary/archive/old.md'))).toBe(false);
});

test('throws when the journal has the old wrong schema', () => {
  const from = oldVault();
  const to = scratch('v2');
  const dir = scratch('journal');
  const file = join(dir, 'journal.db');
  const db = new Database(file);
  db.exec('CREATE TABLE projects_v2 (name TEXT, repository_identity TEXT)');
  db.prepare('INSERT INTO projects_v2 (name, repository_identity) VALUES (?, ?)').run('Doccary', 'github.com/Doccary/doccary');
  db.close();

  let thrown: unknown;
  try {
    runImport({ from, to, journal: file });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain('cannot read the project journal');
  expect((thrown as Error).message).toContain(file);
});

test('imports an existing vault when the journal file is absent', () => {
  const from = oldVault();
  const to = scratch('v2');
  const missing = join(scratch('journal'), 'missing.db');
  const report = runImport({ from, to, journal: missing });
  expect(report.written).toContain('Projects/Doccary/Doccary.md');
  expect(readFileSync(join(to, 'Projects/Doccary/Doccary.md'), 'utf8')).toBe(
    '---\ntype: project\nrepositories: []\n---\n\n# Doccary\n\n![[Projects/Doccary/Token audit parent worker]]\n'
  );
});

test('rewrites a path-qualified cross-project link in a second pass', () => {
  const from = scratch('v1');
  writeTree(from, {
    'Projects/Alpha/alpha.md':
      '---\nid: alpha-id\ntype: note\n---\n\n# Alpha intro\n\nSee [[Projects/Beta/bravo]] and [[Projects/Beta/bravo|alias]] and [[Projects/Beta/bravo#section]].\n',
    'Projects/Beta/bravo.md': '---\nid: beta-id\ntype: note\n---\n\n# Bravo note\n\nbody\n'
  });
  const to = scratch('v2');
  const report = runImport({ from, to, journal: journalWith([]) });
  expect(report.unresolvedLinks).toEqual([]);
  expect(report.linksRewritten).toBe(3);
  expect(readFileSync(join(to, 'Projects/Alpha/Alpha intro.md'), 'utf8')).toContain(
    'See [[Projects/Beta/Bravo note]] and [[Projects/Beta/Bravo note|alias]] and [[Projects/Beta/Bravo note#section]].'
  );
});

test('keeps ported content byte-identical after the rewritten frontmatter', () => {
  const to = scratch('v2');
  runImport({ from: oldVault(), to, journal: journalWith([]) });
  const raw = readFileSync(join(to, 'Projects/Shared/API decision.md'), 'utf8');
  expect(raw.startsWith(
    '---\nid: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\ntype: decision\ntags:\n  - api\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\n\n# API decision\n\n'
  )).toBe(true);
});

test('a dry run writes nothing but still reports', () => {
  const to = scratch('v2');
  const report = runImport({ from: oldVault(), to, journal: journalWith([]), dryRun: true });
  expect(report.written).toContain('Projects/Doccary/Token audit parent worker.md');
  expect(existsSync(join(to, 'Projects/Doccary/Token audit parent worker.md'))).toBe(false);
});

test('refuses a non-empty target and duplicate ids', () => {
  const to = scratch('v2');
  writeTree(to, { 'existing.md': '# X\n' });
  expect(() => runImport({ from: oldVault(), to, journal: journalWith([]) })).toThrow(/not empty/);

  const empty = scratch('v2');
  const from = scratch('v1');
  writeTree(from, {
    'Projects/A/one.md': '---\nid: dup\ntype: lesson\n---\n\n# One\n',
    'Projects/A/two.md': '---\nid: dup\ntype: lesson\n---\n\n# Two\n'
  });
  expect(() => runImport({ from, to: empty, journal: journalWith([]) })).toThrow(/duplicate id dup/);
  expect(existsSync(join(empty, 'Projects/A/one.md'))).toBe(false);
});

test('the imported vault reports no problems', () => {
  const to = scratch('v2');
  runImport({ from: oldVault(), to, journal: journalWith([['Doccary', 'github.com/Doccary/doccary']]) });
  const vault = new Vault(to);
  const index = SearchIndex.open(':memory:');
  const sync = new Sync(vault, index);
  sync.scan();
  expect(sync.problems()).toEqual([]);
  expect(index.all()).toHaveLength(3);
});
