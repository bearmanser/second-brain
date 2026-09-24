import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { BrainConfig } from '../../src/config/schema.js';
import type { AuthenticatedContext, LocalHandlerDeps } from '../../src/core/types.js';
import { SYSTEM_ACTOR } from '../../src/core/types.js';
import { runCli } from '../../src/cli.js';
import { captureLocal } from '../../src/features/capture.js';
import { projectEnsureLocal } from '../../src/features/project-ensure.js';
import { buildLocalHandlerDeps, type LocalBrain } from '../../src/features/local-support.js';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { parseDocument } from '../../src/notes/document-codec.js';
import { installObsidianAssets } from '../../src/obsidian/install.js';
import { projectHubPath, projectProperty } from '../../src/projects/hub.js';
import { openDocumentStore, type DocumentStore } from '../../src/storage/document-store.js';
import { Journal, LocalOperationJournal } from '../../src/storage/journal.js';
import { openRevisionStore, type RevisionStore } from '../../src/storage/revision-store.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { FileVault } from '../../src/storage/vault.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const clock = { now: () => new Date() };
const ids = { next: () => randomUUID() };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function ctx(): AuthenticatedContext {
  return { actor: SYSTEM_ACTOR, request_id: randomUUID(), signal: new AbortController().signal };
}

async function assetPaths(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const child = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await assetPaths(join(directory, entry.name), child)));
      continue;
    }
    found.push(child);
  }
  return found.sort();
}

async function existsIn(directory: string, relativePath: string): Promise<boolean> {
  return (await assetPaths(directory)).includes(relativePath);
}

interface Ground {
  deps: LocalHandlerDeps;
  vaultRoot: string;
  dispose: () => Promise<void>;
}

async function openGround(): Promise<Ground> {
  const sandbox = await vaultSandbox();
  const journal = Journal.open(join(sandbox.state, 'journal.db'), { clock, ids });
  const operations = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
  const revisions = await openRevisionStore(sandbox.state);
  const store = await openDocumentStore({ vault: sandbox.vault, state: sandbox.state });
  const index = openSearchIndex(':memory:');
  const vault = new FileVault(sandbox.vault, []);
  const catalogue = CurrentCatalogue.open({ revisions, ids });
  const config = {
    mounts: { vault: sandbox.vault, state: sandbox.state },
    scopes: [],
    result_delivery: 'structured',
    limits: { reconcile_interval_ms: 1000 }
  } as unknown as BrainConfig;
  const brain: LocalBrain = {
    config,
    clock,
    ids,
    documents: store,
    catalogue,
    index,
    journal,
    operations,
    vault,
    vaultRoot: sandbox.vault,
    close: async () => undefined
  };
  try {
    const deps = await buildLocalHandlerDeps(brain);
    return {
      deps,
      vaultRoot: sandbox.vault,
      dispose: async () => {
        try {
          operations.close();
        } catch {
          undefined;
        }
        journal.close();
        await store.close();
        catalogue.close();
        index.close();
        await sandbox.dispose();
      }
    };
  } catch (error) {
    operations.close();
    journal.close();
    await store.close().catch(() => undefined);
    catalogue.close();
    index.close();
    await sandbox.dispose();
    throw error;
  }
}

test('installing dashboards preserves a personal home page', async () => {
  const s = await vaultSandbox();
  try {
    await writeFile(join(s.vault, 'Home.md'), '# My home\n');
    await installObsidianAssets({ vault: s.vault, mode: 'create-only' });
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('# My home\n');
  } finally {
    await s.dispose();
  }
});

test('a second install is idempotent and leaves every asset byte-identical', async () => {
  const s = await vaultSandbox();
  try {
    const first = await installObsidianAssets({ vault: s.vault, mode: 'create-only' });
    expect(first.created.length).toBeGreaterThan(0);
    expect(first.conflicts).toEqual([]);
    const before = new Map<string, string>();
    for (const asset of first.created) {
      before.set(asset, await readFile(join(s.vault, asset), 'utf8'));
    }
    const second = await installObsidianAssets({ vault: s.vault, mode: 'create-only' });
    expect(second.created).toEqual([]);
    expect(second.conflicts).toEqual([]);
    expect(second.unchanged.sort()).toEqual(first.created.sort());
    for (const [asset, raw] of before) {
      expect(await readFile(join(s.vault, asset), 'utf8')).toBe(raw);
    }
  } finally {
    await s.dispose();
  }
});

test('a custom .obsidian/app.json remains byte-identical', async () => {
  const s = await vaultSandbox();
  const settings = join(s.vault, '.obsidian', 'app.json');
  try {
    await mkdir(join(s.vault, '.obsidian'), { recursive: true });
    await writeFile(settings, '{"custom": true}\n');
    await installObsidianAssets({ vault: s.vault, mode: 'create-only' });
    expect(await readFile(settings, 'utf8')).toBe('{"custom": true}\n');
  } finally {
    await s.dispose();
  }
});

test('install reports a modified page as a conflict instead of overwriting it', async () => {
  const s = await vaultSandbox();
  try {
    await writeFile(join(s.vault, 'Home.md'), '# Personal\n');
    const result = await installObsidianAssets({ vault: s.vault, mode: 'create-only' });
    expect(result.conflicts).toContain('Home.md');
    expect(result.created).not.toContain('Home.md');
    expect(await readFile(join(s.vault, 'Home.md'), 'utf8')).toBe('# Personal\n');
  } finally {
    await s.dispose();
  }
});

test('install never addresses .obsidian or hidden paths', async () => {
  const s = await vaultSandbox();
  try {
    const result = await installObsidianAssets({ vault: s.vault, mode: 'create-only' });
    const touched = [...result.created, ...result.unchanged, ...result.conflicts];
    expect(touched.some((path) => path.startsWith('.'))).toBe(false);
    expect(touched.some((path) => path.startsWith('.obsidian'))).toBe(false);
  } finally {
    await s.dispose();
  }
});

test('project ensure generates a readable project page that embeds the project base', async () => {
  const ground = await openGround();
  try {
    await installObsidianAssets({ vault: ground.vaultRoot, mode: 'create-only' });
    const result = await projectEnsureLocal(
      ctx(),
      { idempotency_key: randomUUID(), remote_url: 'https://github.com/example/readable-page.git', display_name: 'Læring prosjekt' },
      ground.deps
    );
    const relativeRoot = result.relative_root;
    expect(relativeRoot).toBe('Projects/Læring prosjekt');
    const pagePath = `${relativeRoot}/Læring prosjekt.md`;
    expect(await existsIn(ground.vaultRoot, pagePath)).toBe(true);
    const page = await readFile(join(ground.vaultRoot, pagePath), 'utf8');
    expect(page).toContain('# Læring prosjekt');
    expect(page).toContain('type: project');
    expect(page).toContain('project: "[[Projects/Læring prosjekt/Læring prosjekt]]"');
    expect(page).toContain('![[Views/Project notes.base]]');
    expect(page).not.toMatch(UUID);

    const replay = await projectEnsureLocal(
      ctx(),
      { idempotency_key: randomUUID(), remote_url: 'git@github.com:example/readable-page.git' },
      ground.deps
    );
    expect(replay.relative_root).toBe(relativeRoot);
    expect(await readFile(join(ground.vaultRoot, pagePath), 'utf8')).toBe(page);

    await reconcileCurrentVault({ vault: ground.deps.vault, catalogue: ground.deps.catalogue });
    const source = ground.deps.catalogue.all().find((entry) => entry.path === pagePath);
    expect(source?.id).toBeUndefined();
    expect(source?.title).toBe('Læring prosjekt');
  } finally {
    await ground.dispose();
  }
});

test('captured project notes use the canonical hub link that the project view compares', async () => {
  const ground = await openGround();
  try {
    await installObsidianAssets({ vault: ground.vaultRoot, mode: 'create-only' });
    const project = await projectEnsureLocal(
      ctx(),
      {
        idempotency_key: randomUUID(),
        remote_url: 'https://github.com/example/hub-link.git',
        display_name: 'Læring prosjekt'
      },
      ground.deps
    );
    const relativeRoot = project.relative_root as string;
    const capture = await captureLocal(
      ctx(),
      {
        project: project.project_id,
        idempotency_key: randomUUID(),
        note: {
          title: 'Hub link note',
          tags: [],
          content: { kind: 'note', summary: 'hub', body_markdown: '# Hub link note\n' },
          evidence: [],
          related_ids: []
        }
      },
      ground.deps
    );
    const path = ground.deps.catalogue.getById(capture.id)?.path;
    expect(path).toBeTruthy();
    const document = parseDocument(
      await readFile(join(ground.vaultRoot, path as string), 'utf8'),
      path as string
    );
    const expectedProperty = projectProperty(relativeRoot);
    expect(expectedProperty).toBe('[[Projects/Læring prosjekt/Læring prosjekt]]');
    expect(document.project).toBe(expectedProperty);

    const hubRelative = projectHubPath(relativeRoot);
    expect(await existsIn(ground.vaultRoot, hubRelative)).toBe(true);
    expect(expectedProperty.slice(2, -2)).toBe(
      hubRelative.slice(0, hubRelative.length - '.md'.length)
    );

    const base = await readFile(join(ground.vaultRoot, 'Views/Project notes.base'), 'utf8');
    expect(base).toContain('note.project == this.file.asLink()');
  } finally {
    await ground.dispose();
  }
});

test('the obsidian init CLI installs create-only assets into the vault', async () => {
  const s = await vaultSandbox();
  try {
    const code = await runCli(['obsidian', 'init', '--create-only', '--vault', s.vault]);
    expect(code).toBe(0);
    expect(await existsIn(s.vault, 'Home.md')).toBe(true);
    expect(await existsIn(s.vault, 'Views/Projects.base')).toBe(true);
    expect(await existsIn(s.vault, 'Templates/Decision.md')).toBe(true);
  } finally {
    await s.dispose();
  }
});
