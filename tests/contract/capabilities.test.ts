import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { assertBackendCapabilities } from '../../scripts/probe-compatibility.mjs';

const readText = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const readJson = <T>(path: string): T => JSON.parse(readText(path)) as T;

const fixtureNames = [
  'initialize',
  'tools-list',
  'write-note',
  'write-note-duplicate',
  'search-notes',
  'read-note',
  'list-memory-projects',
  'create-memory-project'
];

test('requires note and project creation, search, read, and project discovery tools (historical Basic Memory fixture)', () => {
  expect(() => assertBackendCapabilities([
    { name: 'search_notes', inputSchema: {} }
  ])).toThrow(/write_note/);
});

test('accepts the observed Basic Memory tool surface (historical fixture retained for reproducible import tests)', () => {
  const fixture = readJson<{ observedToolCount: number; tools: { name: string; inputSchema: unknown }[] }>(
    'tests/fixtures/backend/tools-list.json'
  );
  expect(fixture.tools.length).toBe(fixture.observedToolCount);
  expect(fixture.tools.length).toBeGreaterThan(0);
  expect(() => assertBackendCapabilities(fixture.tools)).not.toThrow();
});

test('pins validated image digests consistently across images.env and the dependency lock', () => {
  const env = new Map(
    readText('config/images.env')
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string])
  );
  const lock = readJson<{ images: Record<string, string> }>('config/dependency-lock.json');
  expect(env.size).toBe(2);
  for (const name of ['NODE_IMAGE', 'PYTHON_IMAGE']) {
    expect(env.get(name)).toBe(lock.images[name]);
    expect(env.get(name)).toMatch(/@sha256:[a-f0-9]{64}$/);
  }
  expect(lock.images).not.toHaveProperty('BASIC_MEMORY_IMAGE');
});

test('ships a single application service with no live Basic Memory backend', () => {
  const compose = readText('compose.yaml');
  expect(compose).not.toMatch(/^\s{2}memory:\s*$/m);
  expect(compose).not.toMatch(/BASIC_MEMORY|backend_endpoint|BRAIN_BACKEND_URL/);
  expect(compose).not.toMatch(/embedding|fastembed/i);
  expect(compose).toContain('${VAULT_PATH:-./vault}:/vault');
  expect(compose).not.toContain('/vault:ro');
  expect(compose).not.toContain('/app/data');
});

test('records exact resolved dependency versions and the Node 24 engine range', () => {
  const packageJson = readJson<{
    engines: { node: string };
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  }>('package.json');
  const lock = readJson<{ dependencies: Record<string, string>; devDependencies: Record<string, string> }>(
    'config/dependency-lock.json'
  );
  expect(packageJson.engines.node).toBe('>=24 <25');
  expect(lock.dependencies).toEqual(packageJson.dependencies);
  expect(lock.devDependencies).toEqual(packageJson.devDependencies);
  for (const version of [...Object.values(packageJson.dependencies), ...Object.values(packageJson.devDependencies)]) {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  }
});

test('ships sanitized historical fixtures for the observed backend wire responses', () => {
  const combined = fixtureNames.map((name) => readText(`tests/fixtures/backend/${name}.json`)).join('\n');
  const initialize = readJson<{ protocolVersion: string; serverInfo: { name: string; version: string } }>(
    'tests/fixtures/backend/initialize.json'
  );
  expect(initialize.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(initialize.serverInfo.name).toBe('Basic Memory');
  const write = readJson<{ structuredContent: { result: { action: string } } }>(
    'tests/fixtures/backend/write-note.json'
  );
  expect(write.structuredContent.result.action).toBe('created');
  const duplicate = readJson<{ structuredContent: { result: { action: string; error: string } } }>(
    'tests/fixtures/backend/write-note-duplicate.json'
  );
  expect(duplicate.structuredContent.result).toMatchObject({ action: 'conflict', error: 'NOTE_ALREADY_EXISTS' });
  const projectCreate = readJson<{
    structuredContent: { result: { name: string; path: string; created: boolean; already_exists: boolean } };
  }>('tests/fixtures/backend/create-memory-project.json');
  expect(projectCreate.structuredContent.result).toMatchObject({
    name: '<generated-project>',
    path: '/app/data/Projects/<generated-project>',
    created: true,
    already_exists: false
  });
  expect(combined).not.toMatch(/Bearer\s/);
  expect(combined).not.toMatch(/\/home\/appuser/);
  expect(combined).not.toMatch(/api[_-]?key/i);
});
