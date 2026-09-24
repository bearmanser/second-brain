import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { extractLinks } from '../../src/notes/links.js';
import { projectIndexDocument, projectIndexPath } from '../../src/obsidian/project-index.js';

const ASSETS = fileURLToPath(new URL('../../src/obsidian/assets', import.meta.url));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function walk(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const child = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await walk(join(directory, entry.name), child)));
      continue;
    }
    found.push(child);
  }
  return found.sort();
}

async function assetPaths(): Promise<string[]> {
  return walk(ASSETS);
}

async function readAsset(relativePath: string): Promise<string> {
  return readFile(join(ASSETS, relativePath), 'utf8');
}

async function assetTexts(suffix: string): Promise<{ path: string; raw: string }[]> {
  const paths = (await assetPaths()).filter((path) => path.endsWith(suffix));
  return Promise.all(paths.map(async (path) => ({ path, raw: await readAsset(path) })));
}

interface BaseView {
  type?: string;
  name?: string;
  order?: string[];
  sort?: { property?: string; direction?: string }[];
  groupBy?: { property?: string; direction?: string };
  filters?: unknown;
}

interface BaseDocument {
  filters?: { and?: string[]; or?: string[]; not?: string[] };
  views?: BaseView[];
}

function baseOf(raw: string): BaseDocument {
  return parseYaml(raw) as BaseDocument;
}

function filterStrings(filters: BaseDocument['filters']): string[] {
  if (filters === undefined) return [];
  const values: string[] = [];
  for (const group of [filters.and, filters.or, filters.not]) {
    if (Array.isArray(group)) values.push(...group.filter((entry): entry is string => typeof entry === 'string'));
  }
  return values;
}

const REQUIRED_TEMPLATE_TYPES = [
  'project',
  'decision',
  'architecture',
  'research',
  'reference',
  'lesson',
  'playbook',
  'concept',
  'fact',
  'preference',
  'task',
  'person',
  'meeting',
  'daily',
  'session'
] as const;

test('every generated base parses as YAML with built-in table views', async () => {
  const bases = await assetTexts('.base');
  const expected = [
    'Views/Projects.base',
    'Views/Active decisions.base',
    'Views/Review queue.base',
    'Views/Tasks.base',
    'Views/Recent notes.base',
    'Views/Project notes.base'
  ];
  expect(bases.map((base) => base.path)).toEqual([...expected].sort());
  for (const base of bases) {
    const parsed = baseOf(base.raw);
    expect(Array.isArray(parsed.views), `${base.path} has no views`).toBe(true);
    expect(parsed.views?.length ?? 0).toBeGreaterThan(0);
    for (const view of parsed.views ?? []) {
      expect(view.type, `${base.path} view type`).toBe('table');
      expect(typeof view.name).toBe('string');
    }
    expect(base.raw.toLowerCase()).not.toContain('dataview');
  }
});

test('project, decision, and review views select their types and exclude templates', async () => {
  const projects = baseOf(await readAsset('Views/Projects.base'));
  expect(filterStrings(projects.filters)).toContain('note.type == "project"');
  expect(filterStrings(projects.filters)).toContain('!file.inFolder("Templates")');

  const decisions = baseOf(await readAsset('Views/Active decisions.base'));
  expect(decisions.filters).toEqual({
    and: [
      'file.ext == "md"',
      'note.type == "decision"',
      'note.status == "active"',
      '!file.inFolder("Templates")'
    ]
  });
  expect(decisions.views?.[0]?.name).toBe('Active decisions');
  expect(decisions.views?.[0]?.order).toEqual([
    'file.name',
    'note.project',
    'note.updated',
    'note.tags'
  ]);

  const review = baseOf(await readAsset('Views/Review queue.base'));
  expect(filterStrings(review.filters)).toContain('note.status == "candidate"');
  expect(filterStrings(review.filters)).toContain('!file.inFolder("Templates")');
});

test('task tables group by task_status rather than memory lifecycle status', async () => {
  const tasks = baseOf(await readAsset('Views/Tasks.base'));
  expect(filterStrings(tasks.filters)).toContain('note.type == "task"');
  expect(filterStrings(tasks.filters).join('\n')).not.toContain('note.status');
  expect(tasks.views?.[0]?.groupBy).toEqual({ property: 'note.task_status', direction: 'ASC' });
});

test('recent notes sorts updated descending with a documented file mtime fallback', async () => {
  const recent = baseOf(await readAsset('Views/Recent notes.base'));
  const view = recent.views?.[0];
  expect(view?.sort?.[0]).toEqual({ property: 'note.updated', direction: 'DESC' });
  expect(view?.sort?.some((entry) => entry.property === 'file.mtime' && entry.direction === 'DESC')).toBe(true);
  expect(recent.views?.some((entry) => entry.name === 'Daily notes')).toBe(true);
  const docs = await readFile(new URL('../../docs/obsidian.md', import.meta.url), 'utf8');
  expect(docs).toMatch(/file\.mtime/);
});

test('project notes filter on the embedded page link and exclude the page itself', async () => {
  const projectNotes = baseOf(await readAsset('Views/Project notes.base'));
  const filters = filterStrings(projectNotes.filters);
  expect(filters).toContain('note.project == this.file.asLink()');
  expect(filters).toContain('file.path != this.file.path');
  expect(filters).toContain('!file.inFolder("Templates")');
});

test('native templates have readable sections and never embed a UUID', async () => {
  const templates = await assetTexts('.md');
  const templateFiles = templates.filter((entry) => entry.path.startsWith('Templates/'));
  const types = new Set<string>();
  for (const template of templateFiles) {
    expect(template.raw.startsWith('---\n'), `${template.path} frontmatter`).toBe(true);
    expect(template.raw).not.toMatch(UUID);
    expect(template.raw).not.toMatch(/\{\{\s*(?:uuid|id)\b/i);
    expect(template.raw).not.toMatch(/^id:/m);
    const type = /^type:\s*(\S+)\s*$/m.exec(template.raw)?.[1];
    if (type !== undefined) types.add(type);
    expect(template.raw).toContain('## Sources');
    expect(template.raw).toContain('## Related notes');
  }
  for (const type of REQUIRED_TEMPLATE_TYPES) {
    expect(types.has(type), `missing template type ${type}`).toBe(true);
  }
  const task = templateFiles.find((entry) => entry.path === 'Templates/Task.md');
  expect(task?.raw).toMatch(/task_status:\s*todo/);
});

test('canvas assets are valid JSON with unique node ids and resolvable file paths', async () => {
  const canvases = await assetTexts('.canvas');
  expect(canvases.length).toBeGreaterThan(0);
  const installed = new Set(await assetPaths());
  for (const canvas of canvases) {
    const data = JSON.parse(canvas.raw) as {
      nodes?: { id?: unknown; type?: unknown; file?: unknown }[];
    };
    expect(Array.isArray(data.nodes), `${canvas.path} has nodes`).toBe(true);
    const ids = (data.nodes ?? []).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const node of data.nodes ?? []) {
      expect(typeof node.id).toBe('string');
      if (node.type !== 'file') continue;
      expect(typeof node.file).toBe('string');
      const target = (node.file as string).split('#')[0] ?? '';
      expect(target.startsWith('/')).toBe(false);
      expect(target).not.toContain('..');
      expect(installed.has(target), `canvas file ${target} is installed`).toBe(true);
    }
  }
});

test('internal links in generated notes resolve to installed assets', async () => {
  const installed = new Set(await assetPaths());
  const markdown = await assetTexts('.md');
  const unresolved: string[] = [];
  for (const asset of markdown) {
    for (const link of extractLinks(asset.raw)) {
      const target = link.target.replace(/^\.\//, '');
      const candidates = [target, `${target}.md`];
      if (!candidates.some((candidate) => installed.has(candidate))) {
        unresolved.push(`${asset.path} -> ${link.target}`);
      }
    }
  }
  expect(unresolved).toEqual([]);
});

test('project index documents use canonical links and the project notes base embed', () => {
  const project = { id: 'readable-name', display_name: 'Readable Name', relative_root: 'Projects/Readable Name' };
  const path = projectIndexPath(project);
  expect(path).toBe('Projects/Readable Name/Readable Name.md');
  const document = projectIndexDocument(project, { today: '2026-09-24' });
  expect(document).toContain('# Readable Name');
  expect(document).toContain('project: "[[Projects/Readable Name/Readable Name]]"');
  expect(document).toContain('![[Views/Project notes.base]]');
  expect(document).toContain('## Sources');
  expect(document).toContain('## Related notes');
  expect(document).not.toMatch(UUID);
  expect(document).not.toContain('Readable Name.md');
});

test('project index paths preserve Unicode and avoid an opaque identifier fallback', () => {
  const unicode = { id: 'laering', display_name: 'Læring', relative_root: 'Projects/Læring' };
  expect(projectIndexPath(unicode)).toBe('Projects/Læring/Læring.md');
  const colliding = { id: 'x', display_name: 'CON', relative_root: 'Projects/CON_' };
  expect(projectIndexPath(colliding)).not.toBe('Projects/CON_/CON.md');
  expect(colliding.relative_root).toBe('Projects/CON_');
});
