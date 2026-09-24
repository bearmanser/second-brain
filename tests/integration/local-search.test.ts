import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { CurrentCatalogue, reconcileCurrentVault } from '../../src/notes/current-catalogue.js';
import { indexReconciledDocuments } from '../../src/notes/reconcile.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { FileVault } from '../../src/storage/vault.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const MANAGED_ID = '44b093c5-71db-4785-b9a5-bb8118304278';

function frontmatterDocument(
  body: string,
  options: { id?: string; type?: string; status?: string; project?: string; aliases?: string[] } = {}
): string {
  const lines = ['---'];
  if (options.id !== undefined) lines.push(`id: ${options.id}`);
  lines.push(
    'brain_schema_version: 2',
    `type: ${options.type ?? 'note'}`,
    `status: ${options.status ?? 'active'}`
  );
  if (options.project !== undefined) lines.push(`project: "${options.project}"`);
  if (options.aliases !== undefined) {
    lines.push('aliases:');
    for (const alias of options.aliases) lines.push(`  - ${alias}`);
  }
  lines.push('---', '', body);
  return lines.join('\n');
}

test('filters narrow candidates before the limit is applied', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Projects/Alpha/Decisions/One.md',
      raw: frontmatterDocument('# One\n\nalpha term', { type: 'decision', project: '[[Projects/Alpha]]' }),
      etag: '1'
    });
    index.replaceDocument({
      path: 'Knowledge/Two.md',
      raw: frontmatterDocument('# Two\n\nalpha term', { type: 'note' }),
      etag: '2'
    });
    expect(index.candidates({ query: 'alpha', limit: 50 })).toHaveLength(2);
    expect(index.candidates({ query: 'alpha', project: 'Alpha', limit: 50 })).toHaveLength(1);
    expect(index.candidates({ query: 'alpha', types: ['decision'], limit: 50 })).toHaveLength(1);
    expect(index.candidates({ query: 'alpha', statuses: ['active'], limit: 50 })).toHaveLength(2);
  } finally {
    index.close();
  }
});

test('an unknown type filter is rejected instead of injecting SQL', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({ path: 'Knowledge/One.md', raw: '# One\n\nalpha', etag: '1' });
    expect(() =>
      index.candidates({ query: 'alpha', types: ['note"); DROP TABLE documents; --'], limit: 10 })
    ).toThrowError(/document type/);
  } finally {
    index.close();
  }
});

test('a title or alias only match is still retrievable', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Laya.md',
      raw:
        '---\naliases:\n  - Laya classifier\n---\n\n# Laya\n\nThe model lives here.\n',
      etag: 'a'
    });
    const byTitle = index.candidates({ query: 'Laya', limit: 10 });
    expect(byTitle.length).toBeGreaterThan(0);
    expect(byTitle.some((candidate) => candidate.reasons.includes('title'))).toBe(true);
    const byAlias = index.candidates({ query: 'Laya classifier', limit: 10 });
    expect(byAlias.some((candidate) => candidate.reasons.includes('alias'))).toBe(true);
  } finally {
    index.close();
  }
});

test('a synonym-only answer with no shared term or link stays absent', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Car.md',
      raw: '# Car\n\nAn automobile with four wheels.\n',
      etag: 'c'
    });
    expect(index.candidates({ query: 'vehicle', limit: 10 })).toHaveLength(0);
  } finally {
    index.close();
  }
});

test('graph expansion reaches a resolved link but never fabricates a lexical score', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Seed.md',
      raw: '# Seed\n\nrouter topic\n\nSee [[Knowledge/Answer]].\n',
      etag: 's'
    });
    index.replaceDocument({
      path: 'Knowledge/Answer.md',
      raw: '# Answer\n\nThe carburetor detail lives here.\n',
      etag: 'a'
    });
    const seeds = index.candidates({ query: 'router', limit: 10 });
    expect(seeds).toHaveLength(1);
    const expansion = index.expandGraph(seeds.map((candidate) => candidate.document_key), {}, 10);
    expect(expansion.neighbors.map((neighbor) => neighbor.path)).toContain('Knowledge/Answer.md');
    expect(expansion.neighbors[0].reason).toBe('graph:link');
    expect(expansion.neighbors[0].chunk).toHaveProperty('chunk_key');
  } finally {
    index.close();
  }
});

test('one graph hop deduplicates cycles and caps neighbors at ten', () => {
  const index = openSearchIndex(':memory:');
  try {
    for (let i = 0; i < 12; i += 1) {
      index.replaceDocument({
        path: `Knowledge/Neighbor ${i}.md`,
        raw: `# Neighbor ${i}\n\nbody ${i}\n`,
        etag: `n${i}`
      });
    }
    const links = Array.from({ length: 12 }, (_value, i) => `[[Knowledge/Neighbor ${i}]]`).join('\n');
    index.replaceDocument({
      path: 'Knowledge/Hub.md',
      raw: `# Hub\n\nhub term\n\n${links}\n`,
      etag: 'hub'
    });
    index.replaceDocument({
      path: 'Knowledge/Cycle.md',
      raw: '# Cycle\n\ncycle term\n\n[[Knowledge/Hub]]\n',
      etag: 'cycle'
    });
    const hub = index.expandGraph(['Knowledge/Hub.md'], {}, 10);
    expect(hub.neighbors).toHaveLength(10);
    const cycle = index.expandGraph(['Knowledge/Cycle.md'], {}, 10);
    expect(cycle.neighbors.map((neighbor) => neighbor.path)).not.toContain('Knowledge/Cycle.md');
  } finally {
    index.close();
  }
});

test('graph expansion traverses only five seeds and respects the original filters', () => {
  const index = openSearchIndex(':memory:');
  try {
    for (let i = 0; i < 6; i += 1) {
      index.replaceDocument({
        path: `Knowledge/Seed ${i}.md`,
        raw: `# Seed ${i}\n\nseed ${i}\n\n[[Knowledge/Neighbor ${i}]]\n`,
        etag: `s${i}`
      });
      index.replaceDocument({
        path: `Knowledge/Neighbor ${i}.md`,
        raw: frontmatterDocument(`# Neighbor ${i}\n\nneighbor ${i}\n`, {
          type: i === 5 ? 'note' : 'research'
        }),
        etag: `n${i}`
      });
    }
    const seeds = Array.from({ length: 6 }, (_value, i) => `Knowledge/Seed ${i}.md`);
    const bounded = index.expandGraph(seeds, {}, 10);
    expect(bounded.neighbors.map((neighbor) => neighbor.path)).toContain('Knowledge/Neighbor 4.md');
    expect(bounded.neighbors.map((neighbor) => neighbor.path)).not.toContain('Knowledge/Neighbor 5.md');
    const filtered = index.expandGraph(seeds, { types: ['research'] }, 10);
    expect(filtered.neighbors).toHaveLength(5);
  } finally {
    index.close();
  }
});

test('typed relationships from frontmatter are indexed with their relationship reason', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Source.md',
      raw: '---\nrelated:\n  - "[[Knowledge/Target]]"\n---\n\n# Source\n\nsource term\n',
      etag: 'source'
    });
    index.replaceDocument({
      path: 'Knowledge/Target.md',
      raw: '# Target\n\ntarget body\n',
      etag: 'target'
    });
    const expansion = index.expandGraph(['Knowledge/Source.md'], {}, 10);
    expect(expansion.neighbors).toHaveLength(1);
    expect(expansion.neighbors[0].reason).toBe('graph:related');
    expect(expansion.edges[0].relationship).toBe('related');
  } finally {
    index.close();
  }
});

test('graph neighbour chunks prefer lexical relevance over the first section', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Seed.md',
      raw: '# Seed\n\nrouter term\n\n[[Knowledge/Target]]\n',
      etag: 'seed'
    });
    index.replaceDocument({
      path: 'Knowledge/Target.md',
      raw:
        '---\ntype: research\n---\n\n# Target\n\n## Intro\n\nunrelated opening\n\n' +
        '## Detail\n\ncarburetor router details\n',
      etag: 'target'
    });
    const first = index.expandGraph(['Knowledge/Seed.md'], {}, 10);
    expect(first.neighbors[0].chunk.text).toContain('# Target');
    const ranked = index.expandGraph(['Knowledge/Seed.md'], { query: 'carburetor' }, 10);
    expect(ranked.neighbors[0].chunk.text).toContain('carburetor router details');
  } finally {
    index.close();
  }
});

test('graph edges are returned only for selected neighbours', () => {
  const index = openSearchIndex(':memory:');
  try {
    for (let i = 0; i < 12; i += 1) {
      index.replaceDocument({
        path: `Knowledge/Linked ${i}.md`,
        raw: `# Linked ${i}\n\nbody ${i}\n`,
        etag: `l${i}`
      });
    }
    const links = Array.from({ length: 12 }, (_value, i) => `[[Knowledge/Linked ${i}]]`).join('\n');
    index.replaceDocument({
      path: 'Knowledge/Origin.md',
      raw: `# Origin\n\norigin term\n\n${links}\n`,
      etag: 'origin'
    });
    const zero = index.expandGraph(['Knowledge/Origin.md'], {}, 0);
    expect(zero.neighbors).toHaveLength(0);
    expect(zero.edges).toHaveLength(0);
    const capped = index.expandGraph(['Knowledge/Origin.md'], {}, 10);
    expect(capped.neighbors).toHaveLength(10);
    expect(capped.edges).toHaveLength(10);
    for (const edge of capped.edges) {
      expect(capped.neighbors.map((neighbor) => neighbor.document_key)).toContain(edge.target);
    }
    const filtered = index.expandGraph(['Knowledge/Origin.md'], { statuses: ['archived'] }, 10);
    expect(filtered.neighbors).toHaveLength(0);
    expect(filtered.edges).toHaveLength(0);
  } finally {
    index.close();
  }
});

test('adding an id to an existing path cleans up its former path keyed links', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Note.md',
      raw: '# Note\n\n[[Knowledge/Target]]\n',
      etag: 'v1'
    });
    index.replaceDocument({ path: 'Knowledge/Target.md', raw: '# Target\n\ntarget body\n', etag: 't' });
    expect(index.expandGraph(['Knowledge/Note.md'], {}, 10).neighbors.map((n) => n.path)).toContain(
      'Knowledge/Target.md'
    );
    index.replaceDocument({
      path: 'Knowledge/Note.md',
      raw: frontmatterDocument('# Note\n\n[[Knowledge/Target]]\n', { id: MANAGED_ID }),
      etag: 'v2'
    });
    expect(index.expandGraph(['Knowledge/Note.md'], {}, 10).neighbors).toHaveLength(0);
    expect(
      index.expandGraph([MANAGED_ID], {}, 10).neighbors.map((neighbor) => neighbor.path)
    ).toContain('Knowledge/Target.md');
  } finally {
    index.close();
  }
});

test('a frontmatter-only note is retrievable by its alias and title', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Metadata only.md',
      raw: '---\naliases:\n  - Legacy alias\n---\n',
      etag: 'm'
    });
    const byAlias = index.candidates({ query: 'legacy alias', limit: 10 });
    expect(byAlias).toHaveLength(1);
    expect(byAlias[0].reasons).toContain('alias');
    expect(byAlias[0].text).toBe('---\naliases:\n  - Legacy alias\n---\n');
    const byTitle = index.candidates({ query: 'Metadata only', limit: 10 });
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0].reasons).toContain('title');
  } finally {
    index.close();
  }
});

test('a note deleted while the index is closed is pruned on restart', async () => {
  const sandbox = await vaultSandbox();
  const databasePath = join(sandbox.state, 'search.sqlite');
  try {
    await mkdir(join(sandbox.vault, 'Knowledge'), { recursive: true });
    await writeFile(join(sandbox.vault, 'Knowledge', 'Gone.md'), '# Gone\n\nvanishing term\n');
    const vault = new FileVault(sandbox.vault, []);
    const firstCatalogue = CurrentCatalogue.open({});
    const first = openSearchIndex(databasePath);
    const firstReport = await reconcileCurrentVault({ vault, catalogue: firstCatalogue });
    indexReconciledDocuments({ catalogue: firstCatalogue, index: first, report: firstReport });
    expect(first.candidates({ query: 'vanishing', limit: 10 })).toHaveLength(1);
    first.close();
    firstCatalogue.close();

    await rm(join(sandbox.vault, 'Knowledge', 'Gone.md'));

    const secondCatalogue = CurrentCatalogue.open({});
    const second = openSearchIndex(databasePath);
    const secondReport = await reconcileCurrentVault({ vault, catalogue: secondCatalogue });
    indexReconciledDocuments({ catalogue: secondCatalogue, index: second, report: secondReport });
    expect(second.candidates({ query: 'vanishing', limit: 10 })).toHaveLength(0);
    expect(second.paths()).toEqual([]);
    second.close();
    secondCatalogue.close();
  } finally {
    await sandbox.dispose();
  }
});

test('deletion removes searchable content and a managed rename follows its id', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Before.md',
      raw: frontmatterDocument('# Note\n\nrelocated term', { id: MANAGED_ID }),
      etag: 'v1'
    });
    expect(index.candidates({ query: 'relocated', limit: 10 })).toHaveLength(1);
    index.replaceDocument({
      path: 'Knowledge/After.md',
      raw: frontmatterDocument('# Note\n\nrelocated term', { id: MANAGED_ID }),
      etag: 'v1'
    });
    const paths = index.candidates({ query: 'relocated', limit: 10 }).map((candidate) => candidate.path);
    expect(paths).toEqual(['Knowledge/After.md']);
    index.deletePath('Knowledge/After.md');
    expect(index.candidates({ query: 'relocated', limit: 10 })).toHaveLength(0);
  } finally {
    index.close();
  }
});

test('a malformed note does not stop valid notes from being searchable', () => {
  const index = openSearchIndex(':memory:');
  try {
    index.replaceDocument({
      path: 'Knowledge/Broken.md',
      raw: '---\nid: not-a-uuid\n---\n\n# Broken\n\nbroken term\n',
      etag: 'b'
    });
    index.replaceDocument({ path: 'Knowledge/Article.md', raw: '# Article\n\nzeta body term\n', etag: 'g' });
    expect(index.candidates({ query: 'zeta', limit: 10 })).toHaveLength(1);
  } finally {
    index.close();
  }
});

test('a corrupt index is disposable and rebuilds from current notes', async () => {
  const sandbox = await vaultSandbox();
  const databasePath = join(sandbox.state, 'search.sqlite');
  try {
    const first = openSearchIndex(databasePath);
    first.replaceDocument({ path: 'Knowledge/Keep.md', raw: '# Keep\n\nkept term\n', etag: 'k' });
    first.close();
    const reopened = openSearchIndex(databasePath);
    expect(reopened.candidates({ query: 'kept', limit: 10 })).toHaveLength(1);
    reopened.close();

    await writeFile(databasePath, 'this is not a sqlite database');
    const rebuilt = openSearchIndex(databasePath);
    expect(rebuilt.candidates({ query: 'kept', limit: 10 })).toHaveLength(0);
    rebuilt.replaceDocument({ path: 'Knowledge/Keep.md', raw: '# Keep\n\nkept term\n', etag: 'k' });
    expect(rebuilt.candidates({ query: 'kept', limit: 10 })).toHaveLength(1);
    rebuilt.close();
  } finally {
    await sandbox.dispose();
  }
});

test('reconciliation supplies current documents to the index and reports malformed files', async () => {
  const sandbox = await vaultSandbox();
  const index = openSearchIndex(':memory:');
  const catalogue = CurrentCatalogue.open({});
  try {
    await mkdir(join(sandbox.vault, 'Knowledge'), { recursive: true });
    await writeFile(join(sandbox.vault, 'Knowledge', 'Article.md'), '# Article\n\nzeta body term\n');
    await writeFile(
      join(sandbox.vault, 'Knowledge', 'Broken.md'),
      '---\nid: not-a-uuid\n---\n\n# Broken\n\nbroken term\n'
    );
    const vault = new FileVault(sandbox.vault, []);
    const report = await reconcileCurrentVault({ vault, catalogue });
    indexReconciledDocuments({ catalogue, index, report });
    expect(report.malformed.map((entry) => entry.path)).toContain('Knowledge/Broken.md');
    expect(index.candidates({ query: 'zeta', limit: 10 })).toHaveLength(1);
    await writeFile(join(sandbox.vault, 'Knowledge', 'Article.md'), '# Article\n\neta body term\n');
    const second = await reconcileCurrentVault({ vault, catalogue });
    indexReconciledDocuments({ catalogue, index, report: second });
    expect(index.candidates({ query: 'zeta', limit: 10 })).toHaveLength(0);
    expect(index.candidates({ query: 'eta', limit: 10 })).toHaveLength(1);
  } finally {
    index.close();
    catalogue.close();
    await sandbox.dispose();
  }
});
