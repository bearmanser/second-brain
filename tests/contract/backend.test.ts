import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { isBrainError } from '../../src/contracts/errors.js';
import type { BrainError } from '../../src/contracts/errors.js';
import { BACKEND_TIMEOUT_MS } from '../../src/core/limits.js';
import type { BackendSearch, PlannedWrite, ScopeConfig, StoredRevision } from '../../src/core/types.js';
import { encodeRevision } from '../../src/notes/codec.js';
import { slugify } from '../../src/notes/identity.js';
import {
  argumentsForCreate,
  argumentsForIndexedLookup,
  argumentsForProjectCreate,
  argumentsForSearch,
  decodeProjectCreateResponse
} from '../../src/storage/backend-contract.js';
import { BasicMemoryBackend, normalizeToolResponse } from '../../src/storage/basic-memory.js';
import type { BackendConnection, ConnectionFactory } from '../../src/storage/basic-memory.js';
import { FakeBackend } from '../support/fake-backend.js';

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/backend/${name}.json`, import.meta.url), 'utf8')) as unknown;

const fixtureEnvelope = (name: string): { content: unknown; structuredContent: { result: unknown } } =>
  readFixture(name) as { content: unknown; structuredContent: { result: unknown } };

const envelope = (result: unknown): unknown => ({
  content: [{ type: 'text', text: JSON.stringify(result) }],
  structuredContent: { result },
  isError: false
});

const scope: ScopeConfig = {
  id: 'freellmapi',
  backend_project: 'probe',
  relative_root: '',
  repository_aliases: []
};

const baseRevision: StoredRevision = {
  id: '0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  revision_id: '1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
  parents: [],
  scope: 'freellmapi',
  status: 'candidate',
  note: {
    title: 'Compare direct and proxied TTFT',
    tags: ['streaming'],
    content: {
      kind: 'lesson',
      situation: 'Streaming latency looked worse through the proxy.',
      lesson: 'Measure both paths with the same prompt before blaming the proxy.',
      applicability: 'Synthetic streaming benchmarks.'
    },
    evidence: [],
    related_ids: []
  },
  created_at: '2026-01-01T00:00:00.000Z',
  modified_at: '2026-01-01T00:00:00.000Z',
  operation_id: '33333333-3333-4333-8333-333333333333',
  extra_frontmatter: {},
  extra_markdown: ''
};

const revision = (overrides: Partial<StoredRevision> = {}): StoredRevision => ({
  ...baseRevision,
  ...overrides
});

const plannedWrite = (overrides: Partial<StoredRevision> = {}): PlannedWrite =>
  encodeRevision(revision(overrides), scope);

const uuidSuffix = (base: string, suffix: string): string => `${base.slice(0, -suffix.length)}${suffix}`;

const search = (overrides: Partial<BackendSearch> = {}): BackendSearch => ({
  project: 'probe',
  query: 'ttft',
  mode: 'text',
  kinds: ['lesson'],
  statuses: ['candidate'],
  page: 1,
  page_size: 10,
  ...overrides
});

type Handler = (name: string, args: Record<string, unknown>, timeout_ms: number) => Promise<unknown>;

class ScriptedConnection implements BackendConnection {
  opens = 0;
  closes = 0;
  readonly calls: { name: string; args: Record<string, unknown>; timeout_ms: number }[] = [];

  constructor(
    private readonly handler: Handler,
    private readonly tools: string[] = [
      'write_note',
      'search_notes',
      'read_note',
      'list_memory_projects',
      'create_memory_project'
    ]
  ) {}

  async open(): Promise<void> {
    this.opens += 1;
  }

  async listTools(): Promise<string[]> {
    return [...this.tools];
  }

  async call(name: string, args: unknown, timeout_ms: number): Promise<unknown> {
    const record = args as Record<string, unknown>;
    this.calls.push({ name, args: record, timeout_ms });
    return this.handler(name, record, timeout_ms);
  }

  serverVersion(): string | undefined {
    return '4.0.0b1';
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

const scriptedBackend = (
  handler: Handler,
  options: { projects?: string[]; tools?: string[]; timeout_ms?: number; read_attempts?: number } = {}
): { backend: BasicMemoryBackend; connections: ScriptedConnection[] } => {
  const connections: ScriptedConnection[] = [];
  const factory: ConnectionFactory = () => {
    const connection = new ScriptedConnection(handler, options.tools);
    connections.push(connection);
    return connection;
  };
  const backend = new BasicMemoryBackend({
    url: 'http://127.0.0.1:9/mcp',
    projects: options.projects ?? ['probe'],
    read_attempts: options.read_attempts ?? 2,
    read_retry_delay_ms: 0,
    connection_factory: factory,
    ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms })
  });
  return { backend, connections };
};

const captureAsync = async (run: () => Promise<unknown>): Promise<BrainError> => {
  try {
    await run();
  } catch (error) {
    if (isBrainError(error)) return error;
    throw error;
  }
  throw new Error('expected a BrainError');
};

const tempDirectories: string[] = [];

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'fake-backend-'));
  tempDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not mistake an MCP tool error for a successful empty result', () => {
  expect(() => normalizeToolResponse({
    isError: true,
    content: [{ type: 'text', text: 'Storage is unavailable' }]
  })).toThrow(/BACKEND_UNAVAILABLE/);
});

test('rejects malformed JSON instead of guessing a note from prose', () => {
  expect(() => normalizeToolResponse({
    content: [{ type: 'text', text: 'not a JSON payload' }]
  })).toThrow(/BACKEND_PROTOCOL_ERROR/);
});

test('prefers structuredContent when the backend provides it', () => {
  expect(
    normalizeToolResponse({
      content: [{ type: 'text', text: 'not a JSON payload' }],
      structuredContent: { result: { ok: true } }
    })
  ).toEqual({ ok: true });
});

test('parses the JSON text payload when structuredContent is absent', () => {
  const fixture = fixtureEnvelope('search-notes');
  expect(
    normalizeToolResponse({ content: fixture.content, isError: false })
  ).toEqual(fixture.structuredContent.result);
});

test('decodes every captured fixture identically from structured and text payloads', () => {
  for (const name of [
    'write-note',
    'write-note-duplicate',
    'search-notes',
    'read-note',
    'list-memory-projects'
  ]) {
    const fixture = fixtureEnvelope(name);
    expect(normalizeToolResponse(fixture)).toEqual(fixture.structuredContent.result);
    expect(
      normalizeToolResponse({ content: fixture.content, isError: false })
    ).toEqual(fixture.structuredContent.result);
  }
});

test('treats a genuine empty result as data, not a failure', () => {
  expect(normalizeToolResponse(envelope({ results: [], has_more: false }))).toEqual({
    results: [],
    has_more: false
  });
});

test('reports a missing payload and a non-object result as protocol errors', () => {
  expect(() => normalizeToolResponse({ content: [], isError: false })).toThrow(
    /BACKEND_PROTOCOL_ERROR/
  );
  expect(() => normalizeToolResponse(null)).toThrow(/BACKEND_PROTOCOL_ERROR/);
});

test('separates an unavailable embedding model from generic backend failure', () => {
  expect(() =>
    normalizeToolResponse({
      isError: true,
      content: [{ type: 'text', text: 'Embedding model is unavailable' }]
    })
  ).toThrow(/EMBEDDINGS_UNAVAILABLE/);
});

test('create forwards the generated permalink through metadata with overwrite disabled', () => {
  const write = plannedWrite();
  const args = argumentsForCreate(write);
  expect(args).toEqual({
    project: 'probe',
    title: write.storage_title,
    directory: write.directory,
    note_type: 'lesson',
    content: write.body,
    metadata: { ...write.metadata, permalink: write.permalink },
    overwrite: false,
    output_format: 'json'
  });
  expect(args.metadata.permalink).toBe(write.permalink);
  expect(args.overwrite).toBe(false);
});

test('project creation arguments are generated by the gateway with safe fixed options', () => {
  expect(
    argumentsForProjectCreate('second-brain', '/app/data/Projects/second-brain')
  ).toEqual({
    project_name: 'second-brain',
    project_path: '/app/data/Projects/second-brain',
    set_default: false,
    output_format: 'json'
  });
});

test('project creation response requires the exact generated name and path', () => {
  const expected = {
    name: 'second-brain',
    path: '/app/data/Projects/second-brain',
    created: true,
    already_exists: false
  };
  expect(
    decodeProjectCreateResponse(
      {
        ...expected,
        external_id: '3cfa352c-e73f-40ea-8e11-08cf23997122',
        is_default: false,
        indexing: { state: 'completed' }
      },
      expected.name,
      expected.path
    )
  ).toEqual({ created: true });

  for (const malformed of [null, {}, { name: expected.name, path: expected.path }]) {
    expect(() =>
      decodeProjectCreateResponse(malformed, expected.name, expected.path)
    ).toThrow(/BACKEND_PROTOCOL_ERROR/);
  }
  expect(() =>
    decodeProjectCreateResponse({ ...expected, name: 'other' }, expected.name, expected.path)
  ).toThrow(/BACKEND_PROTOCOL_ERROR/);
  expect(() =>
    decodeProjectCreateResponse(
      { ...expected, path: '/app/data/Projects/other' },
      expected.name,
      expected.path
    )
  ).toThrow(/BACKEND_PROTOCOL_ERROR/);
});

test('ensureProject creates a missing project and verifies it by exact name', async () => {
  let listCalls = 0;
  const { backend, connections } = scriptedBackend(async (name) => {
    if (name === 'list_memory_projects') {
      listCalls += 1;
      return envelope({
        projects: listCalls === 1
          ? [{ name: 'probe', path: '/data/probe' }]
          : [
              { name: 'probe', path: '/data/probe' },
              { name: 'second-brain', path: '/app/data/Projects/second-brain' }
            ]
      });
    }
    return envelope({
      name: 'second-brain',
      path: '/app/data/Projects/second-brain',
      created: true,
      already_exists: false
    });
  });
  await backend.connect();

  await expect(
    backend.ensureProject('second-brain', '/app/data/Projects/second-brain')
  ).resolves.toEqual({ created: true });
  expect(connections[0].calls.map((call) => call.name)).toEqual([
    'list_memory_projects',
    'create_memory_project',
    'list_memory_projects'
  ]);
  expect(connections[0].calls[1].args).toEqual(
    argumentsForProjectCreate('second-brain', '/app/data/Projects/second-brain')
  );
});

test('ensureProject returns without creating when the exact project already exists', async () => {
  const { backend, connections } = scriptedBackend(async () =>
    envelope({ projects: [{ name: 'second-brain', path: '/app/data/Projects/second-brain' }] })
  );
  await backend.connect();

  await expect(
    backend.ensureProject('second-brain', '/app/data/Projects/second-brain')
  ).resolves.toEqual({ created: false });
  expect(connections[0].calls.map((call) => call.name)).toEqual(['list_memory_projects']);
});

test('ensureProject accepts the backend project-root-relative path representation', async () => {
  const { backend } = scriptedBackend(async () =>
    envelope({ projects: [{ name: 'second-brain', path: '/Projects/second-brain' }] })
  );
  await backend.connect();

  await expect(
    backend.ensureProject('second-brain', '/app/data/Projects/second-brain')
  ).resolves.toEqual({ created: false });
});

test('ensureProject rejects an existing project whose path differs', async () => {
  const { backend } = scriptedBackend(async () =>
    envelope({ projects: [{ name: 'second-brain', path: '/app/data/Projects/wrong' }] })
  );
  await backend.connect();

  await expect(
    backend.ensureProject('second-brain', '/app/data/Projects/second-brain')
  ).rejects.toMatchObject({ code: 'BACKEND_PROTOCOL_ERROR' });
});

test('ensureProject fails closed on tool errors without leaking the backend payload', async () => {
  let listCalls = 0;
  const { backend } = scriptedBackend(async (name) => {
    if (name === 'list_memory_projects') {
      listCalls += 1;
      return envelope({ projects: [] });
    }
    return {
      isError: true,
      content: [{ type: 'text', text: 'secret backend diagnostic: token=do-not-leak' }]
    };
  });
  await backend.connect();

  const error = await captureAsync(() =>
    backend.ensureProject('second-brain', '/app/data/Projects/second-brain')
  );
  expect(error.code).toBe('BACKEND_UNAVAILABLE');
  expect(error.message).not.toContain('secret backend diagnostic');
  expect(error.message).not.toContain('do-not-leak');
  expect(listCalls).toBe(1);
});

test('ensureProject rejects a create response mismatch before adopting the project', async () => {
  const { backend } = scriptedBackend(async (name) =>
    name === 'list_memory_projects'
      ? envelope({ projects: [] })
      : envelope({
          name: 'second-brain',
          path: '/app/data/Projects/wrong',
          created: true,
          already_exists: false
        })
  );
  await backend.connect();

  const error = await captureAsync(() =>
    backend.ensureProject('second-brain', '/app/data/Projects/second-brain')
  );
  expect(error.code).toBe('BACKEND_PROTOCOL_ERROR');
});

test('search forwards the gateway-generated filters and never a caller-supplied backend argument', () => {
  expect(argumentsForSearch(search({ page: 2, page_size: 40 }))).toEqual({
    project: 'probe',
    query: 'ttft',
    search_type: 'text',
    note_types: ['lesson'],
    metadata_filters: { brain_status: { $in: ['candidate'] } },
    page: 2,
    page_size: 40,
    search_all_projects: false,
    output_format: 'json'
  });
});

test('bounds backend search to four pages of forty candidates', () => {
  for (const page of [1, 4]) {
    expect(() => argumentsForSearch(search({ page, page_size: 40 }))).not.toThrow();
  }
  for (const page of [0, 5]) {
    expect(() => argumentsForSearch(search({ page }))).toThrow(/INVALID_INPUT/);
  }
  for (const page_size of [1, 40]) {
    expect(() => argumentsForSearch(search({ page_size }))).not.toThrow();
  }
  for (const page_size of [0, 41]) {
    expect(() => argumentsForSearch(search({ page_size }))).toThrow(/INVALID_INPUT/);
  }
  for (const page of [1.5, Number.NaN]) {
    expect(() => argumentsForSearch(search({ page }))).toThrow(/INVALID_INPUT/);
  }
});

test('rejects an out-of-bounds page before touching the transport', async () => {
  const { backend, connections } = scriptedBackend(async () => fixtureEnvelope('search-notes'));
  await backend.connect();
  const error = await captureAsync(() => backend.search(search({ page_size: 41 })));
  expect(error.code).toBe('INVALID_INPUT');
  expect(connections[0].calls).toHaveLength(0);
});

test('isIndexed issues a metadata-only lookup for the revision identity', () => {
  expect(argumentsForIndexedLookup('probe', baseRevision.revision_id)).toEqual({
    project: 'probe',
    query: null,
    search_all_projects: false,
    output_format: 'json',
    page: 1,
    page_size: 1,
    metadata_filters: { brain_revision_id: baseRevision.revision_id }
  });
});

test('create sends write_note to the configured project and maps the created result', async () => {
  const write = plannedWrite();
  const { backend, connections } = scriptedBackend(async () => fixtureEnvelope('write-note'));
  await backend.connect();
  const result = await backend.create(write);
  expect(result).toEqual({
    permalink: 'probe/notes/probe/probe-revision-1',
    relative_path: 'Notes/probe/Probe Revision 1.md'
  });
  expect(connections[0].calls).toHaveLength(1);
  expect(connections[0].calls[0].name).toBe('write_note');
  expect(connections[0].calls[0].args).toEqual(argumentsForCreate(write));
  expect(connections[0].calls[0].args.overwrite).toBe(false);
  expect(connections[0].calls[0].args.project).toBe('probe');
  expect(connections[0].calls[0].args.metadata).toMatchObject({ permalink: write.permalink });
});

test('create surfaces a create-only conflict as a typed CONFLICT', async () => {
  const write = plannedWrite();
  const { backend } = scriptedBackend(async () => fixtureEnvelope('write-note-duplicate'));
  await backend.connect();
  const error = await captureAsync(() => backend.create(write));
  expect(error.code).toBe('CONFLICT');
});

test('create does not retry a write that may have been persisted', async () => {
  let calls = 0;
  const { backend, connections } = scriptedBackend(async () => {
    calls += 1;
    throw new Error('socket hang up');
  });
  await backend.connect();
  const error = await captureAsync(() => backend.create(plannedWrite()));
  expect(error.code).toBe('BACKEND_UNAVAILABLE');
  expect(calls).toBe(1);
  expect(connections[0].calls).toHaveLength(1);
});

test('search maps hits and forwards the exact request arguments', async () => {
  const { backend, connections } = scriptedBackend(async () => fixtureEnvelope('search-notes'));
  await backend.connect();
  const result = await backend.search(search());
  expect(result).toEqual({
    hits: [
      {
        permalink: 'probe/notes/probe/probe-revision-1',
        relative_path: 'Notes/probe/Probe Revision 1.md',
        revision_id: '',
        logical_id: '',
        rank: 1,
        matched_text: '# Probe\n\nA searchable synthetic observation.'
      }
    ],
    has_more: false
  });
  expect(connections[0].calls[0].name).toBe('search_notes');
  expect(connections[0].calls[0].args).toEqual(argumentsForSearch(search()));
});

test('search leaves gateway identity empty when metadata omits brain fields', async () => {
  const { backend } = scriptedBackend(async () => fixtureEnvelope('search-notes'));
  await backend.connect();
  const { hits } = await backend.search(search());
  expect(hits[0].logical_id).toBe('');
  expect(hits[0].revision_id).toBe('');
  expect(hits[0].logical_id).not.toBe('00000000-0000-4000-8000-000000000001');
});

test('search uses brain_id and brain_revision_id metadata when the backend supplies them', async () => {
  const hit = {
    title: 'Probe Revision 1',
    type: 'entity',
    score: 1,
    entity: 'probe/notes/probe/probe-revision-1',
    external_id: '00000000-0000-4000-8000-000000000001',
    permalink: 'probe/notes/probe/probe-revision-1',
    content: '# Probe\n\nA searchable synthetic observation.',
    matched_chunk: '# Probe\n\nA searchable synthetic observation.',
    file_path: 'Notes/probe/Probe Revision 1.md',
    updated_at: '2026-01-01T00:00:00.000000+00:00',
    metadata: {
      note_type: 'note',
      brain_id: '0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      brain_revision_id: '1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
    },
    entity_id: 12
  };
  const { backend } = scriptedBackend(async () =>
    envelope({ results: [hit], current_page: 1, page_size: 10, has_more: false })
  );
  await backend.connect();
  const { hits } = await backend.search(search());
  expect(hits[0].logical_id).toBe('0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d');
  expect(hits[0].revision_id).toBe('1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e');
});

test('search returns empty hits for a genuine empty result without failing', async () => {
  const { backend } = scriptedBackend(async () => envelope({ results: [], has_more: false }));
  await backend.connect();
  await expect(backend.search(search())).resolves.toEqual({ hits: [], has_more: false });
});

test('search retries a transient transport failure a bounded number of times', async () => {
  let calls = 0;
  const { backend } = scriptedBackend(async () => {
    calls += 1;
    throw new Error('fetch failed');
  });
  await backend.connect();
  const error = await captureAsync(() => backend.search(search()));
  expect(error.code).toBe('BACKEND_UNAVAILABLE');
  expect(calls).toBe(2);
});

test('search does not retry an MCP isError or a malformed payload', async () => {
  let isErrorCalls = 0;
  const first = scriptedBackend(async () => {
    isErrorCalls += 1;
    return { isError: true, content: [{ type: 'text', text: 'Storage is unavailable' }] };
  });
  await first.backend.connect();
  const isError = await captureAsync(() => first.backend.search(search()));
  expect(isError.code).toBe('BACKEND_UNAVAILABLE');
  expect(isErrorCalls).toBe(1);

  let malformedCalls = 0;
  const second = scriptedBackend(async () => {
    malformedCalls += 1;
    return { content: [{ type: 'text', text: 'not a JSON payload' }], isError: false };
  });
  await second.backend.connect();
  const malformed = await captureAsync(() => second.backend.search(search()));
  expect(malformed.code).toBe('BACKEND_PROTOCOL_ERROR');
  expect(malformedCalls).toBe(1);
});

test('search surfaces an unavailable embedding model distinctly', async () => {
  const { backend } = scriptedBackend(async () => ({
    isError: true,
    content: [{ type: 'text', text: 'Embedding model is unavailable' }]
  }));
  await backend.connect();
  const error = await captureAsync(() => backend.search(search({ mode: 'hybrid' })));
  expect(error.code).toBe('EMBEDDINGS_UNAVAILABLE');
});

test('isIndexed reports availability from a metadata-only lookup', async () => {
  const { backend, connections } = scriptedBackend(async () => fixtureEnvelope('search-notes'));
  await backend.connect();
  await expect(backend.isIndexed('probe', baseRevision.revision_id)).resolves.toBe(true);
  expect(connections[0].calls[0].args).toEqual(
    argumentsForIndexedLookup('probe', baseRevision.revision_id)
  );

  const empty = scriptedBackend(async () => envelope({ results: [], has_more: false }));
  await empty.backend.connect();
  await expect(empty.backend.isIndexed('probe', baseRevision.revision_id)).resolves.toBe(false);
});

test('rejects a backend project that is not configured before touching the transport', async () => {
  const { backend, connections } = scriptedBackend(async () => envelope({ results: [], has_more: false }));
  await backend.connect();
  for (const run of [
    () => backend.search(search({ project: 'elsewhere' })),
    () => backend.create(encodeRevision(revision(), { ...scope, backend_project: 'elsewhere' })),
    () => backend.isIndexed('elsewhere', baseRevision.revision_id)
  ]) {
    const error = await captureAsync(run);
    expect(error.code).toBe('INVALID_INPUT');
  }
  expect(connections[0].calls).toHaveLength(0);
});

test('refuses calls before connect and after close, and reconnects cleanly', async () => {
  const { backend, connections } = scriptedBackend(async () => fixtureEnvelope('search-notes'));
  const beforeConnect = await captureAsync(() => backend.search(search()));
  expect(beforeConnect.code).toBe('BACKEND_UNAVAILABLE');

  await backend.connect();
  await expect(backend.search(search())).resolves.toBeDefined();

  await backend.close();
  const afterClose = await captureAsync(() => backend.search(search()));
  expect(afterClose.code).toBe('BACKEND_UNAVAILABLE');

  await backend.connect();
  await expect(backend.search(search())).resolves.toBeDefined();
  expect(connections).toHaveLength(2);
  expect(connections[0].closes).toBe(1);
});

test('applies the configured timeout to every backend call', async () => {
  const { backend, connections } = scriptedBackend(
    async () => fixtureEnvelope('write-note'),
    { timeout_ms: 1234 }
  );
  await backend.connect();
  await backend.create(plannedWrite());
  expect(connections[0].calls[0].timeout_ms).toBe(1234);
  expect(BACKEND_TIMEOUT_MS).toBe(15_000);
});

test('probe reports the server version and tool names without forwarding initialization instructions', async () => {
  const { backend, connections } = scriptedBackend(async (name) =>
    name === 'list_memory_projects' ? fixtureEnvelope('list-memory-projects') : envelope({})
  );
  await backend.connect();
  const result = await backend.probe();
  expect(result.server_version).toBe('4.0.0b1');
  expect(result.tools).toContain('write_note');
  expect(Object.keys(result).sort()).toEqual(['server_version', 'tools']);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('personal knowledge base');
  expect(serialized).not.toContain('recent_activity');
  expect(connections[0].calls[0].args).toEqual({ output_format: 'json' });
});

test('probe fails when a required backend tool is missing', async () => {
  const { backend } = scriptedBackend(
    async () => fixtureEnvelope('list-memory-projects'),
    { tools: ['write_note', 'search_notes', 'list_memory_projects'] }
  );
  await backend.connect();
  const error = await captureAsync(() => backend.probe());
  expect(error.code).toBe('BACKEND_PROTOCOL_ERROR');
});

test('probe fails when a configured project is absent from the backend', async () => {
  const { backend } = scriptedBackend(
    async () => fixtureEnvelope('list-memory-projects'),
    { projects: ['missing-project'] }
  );
  await backend.connect();
  const error = await captureAsync(() => backend.probe());
  expect(error.code).toBe('INVALID_INPUT');
});

test('FakeBackend materialises real, create-only files under the configured project', async () => {
  const root = temporaryDirectory();
  const fake = new FakeBackend({ root, projects: ['probe'] });
  await fake.connect();
  const write = plannedWrite();
  const created = await fake.create(write);
  const relativePath = `${write.directory}/${slugify(write.storage_title)}.md`;
  expect(created).toEqual({ permalink: write.permalink, relative_path: relativePath });
  const absolutePath = join(root, 'probe', relativePath);
  expect(existsSync(absolutePath)).toBe(true);
  const raw = readFileSync(absolutePath, 'utf8');
  expect(raw).toContain(`brain_revision_id: ${baseRevision.revision_id}`);

  const error = await captureAsync(() => fake.create(write));
  expect(error.code).toBe('CONFLICT');
  expect(readFileSync(absolutePath, 'utf8')).toBe(raw);
  expect(fake.create_calls).toHaveLength(2);
});

test('FakeBackend keeps its cumulative call counter across a simulated restart', async () => {
  const root = temporaryDirectory();
  const fake = new FakeBackend({ root, projects: ['probe'] });
  await fake.connect();
  await fake.create(plannedWrite());
  const countAfterWrite = fake.call_count;
  expect(fake.create_calls).toHaveLength(1);

  await fake.close();
  await fake.connect();
  expect(fake.call_count).toBe(countAfterWrite);
  await fake.probe();
  expect(fake.call_count).toBe(countAfterWrite + 1);
  expect(fake.create_calls).toHaveLength(1);
});

test('FakeBackend paginates matches and filters by kind, status, and project', async () => {
  const root = temporaryDirectory();
  const fake = new FakeBackend({ root, projects: ['probe'] });
  await fake.connect();
  for (const suffix of ['1', '2', '3']) {
    await fake.create(
      plannedWrite({
        id: uuidSuffix(baseRevision.id, suffix),
        revision_id: uuidSuffix(baseRevision.revision_id, suffix),
        operation_id: uuidSuffix(baseRevision.operation_id, suffix)
      })
    );
  }

  const first = await fake.search(search({ page: 1, page_size: 2 }));
  expect(first.hits).toHaveLength(2);
  expect(first.has_more).toBe(true);
  const second = await fake.search(search({ page: 2, page_size: 2 }));
  expect(second.hits).toHaveLength(1);
  expect(second.has_more).toBe(false);

  await expect(fake.search(search({ kinds: ['decision'] }))).resolves.toEqual({
    hits: [],
    has_more: false
  });
  const error = await captureAsync(() => fake.search(search({ project: 'elsewhere' })));
  expect(error.code).toBe('INVALID_INPUT');
});

test('FakeBackend reports indexing and injectable read faults distinctly', async () => {
  const root = temporaryDirectory();
  const fake = new FakeBackend({ root, projects: ['probe'] });
  await fake.connect();
  await fake.create(plannedWrite());

  await expect(fake.isIndexed('probe', baseRevision.revision_id)).resolves.toBe(true);
  await expect(
    fake.isIndexed('probe', 'ffffffff-ffff-4fff-8fff-ffffffffffff')
  ).resolves.toBe(false);

  fake.fail_once = 'search_unavailable';
  const unavailableError = await captureAsync(() => fake.search(search()));
  expect(unavailableError.code).toBe('BACKEND_UNAVAILABLE');

  fake.fail_once = 'embedding_unavailable';
  const embeddingError = await captureAsync(() => fake.search(search({ mode: 'hybrid' })));
  expect(embeddingError.code).toBe('EMBEDDINGS_UNAVAILABLE');
});

test('FakeBackend distinguishes a lost request from a lost response', async () => {
  const beforeRoot = temporaryDirectory();
  const before = new FakeBackend({ root: beforeRoot, projects: ['probe'] });
  await before.connect();
  before.fail_once = 'before_write';
  const beforeError = await captureAsync(() => before.create(plannedWrite()));
  expect(beforeError.code).toBe('BACKEND_UNAVAILABLE');
  expect(before.materialisedPaths('probe')).toHaveLength(0);

  const afterRoot = temporaryDirectory();
  const after = new FakeBackend({ root: afterRoot, projects: ['probe'] });
  await after.connect();
  const write = plannedWrite();
  after.fail_once = 'after_write';
  const afterError = await captureAsync(() => after.create(write));
  expect(afterError.code).toBe('BACKEND_UNAVAILABLE');
  expect(after.create_calls).toHaveLength(1);
  expect(after.materialisedPaths('probe')).toEqual([
    `${write.directory}/${slugify(write.storage_title)}.md`
  ]);
});

test('FakeBackend refuses operations while disconnected', async () => {
  const root = temporaryDirectory();
  const fake = new FakeBackend({ root, projects: ['probe'] });
  const disconnected = await captureAsync(() => fake.search(search()));
  expect(disconnected.code).toBe('BACKEND_UNAVAILABLE');

  await fake.connect();
  await fake.create(plannedWrite());
  const callsBeforeClose = fake.call_count;
  await fake.close();

  const searchAfterClose = await captureAsync(() => fake.search(search()));
  expect(searchAfterClose.code).toBe('BACKEND_UNAVAILABLE');
  const writeAfterClose = await captureAsync(() => fake.create(plannedWrite()));
  expect(writeAfterClose.code).toBe('BACKEND_UNAVAILABLE');
  expect(fake.call_count).toBe(callsBeforeClose);
});
