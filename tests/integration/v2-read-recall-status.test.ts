import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import type { BrainConfig } from '../../src/config/schema.js';
import type {
  AuthenticatedContext,
  LocalHandlerDeps,
  NoteInput
} from '../../src/core/types.js';
import { SYSTEM_ACTOR } from '../../src/core/types.js';
import { CurrentCatalogue } from '../../src/notes/current-catalogue.js';
import { readLocal } from '../../src/features/read.js';
import { recallLocal } from '../../src/features/recall.js';
import { recallLocalTraced } from '../../src/features/recall.js';
import {
  LEXICAL_QUESTION_ID,
  LEXICAL_QUESTION_VERSION,
  RERANK_QUESTION_ID,
  retrievalQueryId
} from '../../src/retrieval/evaluation.js';
import { statusLocal } from '../../src/features/status.js';
import { reviewLocal } from '../../src/features/review.js';
import { captureLocal } from '../../src/features/capture.js';
import { retrievalEventFromRecall } from '../../src/features/feedback.js';
import { buildLocalHandlerDeps, reconcileDeps, type LocalBrain } from '../../src/features/local-support.js';
import { openDocumentStore, type DocumentStore } from '../../src/storage/document-store.js';
import { Journal, LocalOperationJournal } from '../../src/storage/journal.js';
import { openRevisionStore, type RevisionStore } from '../../src/storage/revision-store.js';
import { openSearchIndex } from '../../src/storage/search-index.js';
import { FileVault } from '../../src/storage/vault.js';
import { toolDefinitions, TOOL_NAMES } from '../../src/mcp/tools.js';
import type { LayaCandidate, LayaScoreResult } from '../../src/retrieval/laya-protocol.js';
import type { RerankWorker, RerankWorkerHealth } from '../../src/retrieval/reranker.js';
import { vaultSandbox } from '../helpers/vault-sandbox.js';

const clock = { now: () => new Date() };
const ids = { next: () => randomUUID() };
const FINGERPRINT = 'f'.repeat(64);

function ctx(signal: AbortSignal = new AbortController().signal): AuthenticatedContext {
  return { actor: SYSTEM_ACTOR, request_id: randomUUID(), signal };
}

function sha(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

interface DocOptions {
  id?: string;
  type?: string;
  status?: string;
  project?: string;
  related?: string[];
}

function doc(body: string, options: DocOptions = {}): string {
  const lines = ['---'];
  if (options.id !== undefined) lines.push(`id: ${options.id}`);
  lines.push('brain_schema_version: 2', `type: ${options.type ?? 'note'}`, `status: ${options.status ?? 'active'}`);
  if (options.project !== undefined) lines.push(`project: "${options.project}"`);
  if (options.related !== undefined) {
    lines.push('related:');
    for (const target of options.related) lines.push(`  - "${target}"`);
  }
  lines.push('---', '', body);
  return lines.join('\n');
}

function note(title: string, marker: string): NoteInput {
  return {
    title,
    tags: [],
    content: { kind: 'note', summary: marker, body_markdown: `# ${title}\n\n${marker}\n` },
    evidence: [],
    related_ids: []
  };
}

interface Ground {
  brain: LocalBrain;
  deps: LocalHandlerDeps;
  store: DocumentStore;
  catalogue: CurrentCatalogue;
  operations: LocalOperationJournal;
  journal: Journal;
  revisions: RevisionStore;
  vaultRoot: string;
  state: string;
  dispose: () => Promise<void>;
}

async function openGround(options: { worker?: RerankWorker; secret?: boolean } = {}): Promise<Ground> {
  const sandbox = await vaultSandbox();
  const journal = Journal.open(join(sandbox.state, 'journal.db'), { clock, ids });
  const operations = LocalOperationJournal.open(join(sandbox.state, 'operations.sqlite'));
  const revisions = await openRevisionStore(sandbox.state);
  const store = await openDocumentStore({ vault: sandbox.vault, state: sandbox.state });
  const index = openSearchIndex(':memory:');
  const vault = new FileVault(sandbox.vault, []);
  const catalogue = CurrentCatalogue.open({ revisions, ids });
  const secretFile = join(sandbox.state, 'cursor.secret');
  if (options.secret !== false) await writeFile(secretFile, randomBytes(32));
  const config = {
    mounts: { vault: sandbox.vault, state: sandbox.state },
    scopes: [
      { id: 'shared', backend_project: 'shared', relative_root: 'Shared', repository_aliases: [] },
      { id: 'beta', backend_project: 'beta', relative_root: 'Projects/Beta', repository_aliases: [] },
      { id: 'gamma', backend_project: 'gamma', relative_root: 'Projects/Gamma', repository_aliases: [] }
    ],
    result_delivery: 'text-json',
    cursor_secret_file: secretFile,
    limits: { reconcile_interval_ms: 1000, tool_result_max_bytes: 128 * 1024 }
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
    ...(options.worker === undefined ? {} : { worker: options.worker }),
    close: async () => undefined
  };
  const deps = await buildLocalHandlerDeps(brain);
  return {
    brain,
    deps,
    store,
    catalogue,
    operations,
    journal,
    revisions,
    vaultRoot: sandbox.vault,
    state: sandbox.state,
    dispose: async () => {
      operations.close();
      journal.close();
      await store.close();
      catalogue.close();
      index.close();
      await sandbox.dispose();
    }
  };
}

async function put(ground: Ground, path: string, raw: string): Promise<void> {
  const absolute = join(ground.vaultRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, raw);
}

class FakeWorker implements RerankWorker {
  calls = 0;
  lastSignal: AbortSignal | undefined;
  constructor(
    private readonly behaviour: (candidates: readonly LayaCandidate[], signal?: AbortSignal) => Promise<LayaScoreResult>,
    private readonly state: RerankWorkerHealth['state'] = 'ready'
  ) {}
  health(): RerankWorkerHealth {
    return { state: this.state, model_fingerprint: FINGERPRINT, question_version: 'relevance-2026-09-23.1' };
  }
  score(input: { request_id: string; query: string; candidates: readonly LayaCandidate[]; signal?: AbortSignal }): Promise<LayaScoreResult> {
    this.calls += 1;
    this.lastSignal = input.signal;
    return this.behaviour(input.candidates, input.signal);
  }
}

function scored(candidates: readonly LayaCandidate[], score: (candidate: LayaCandidate, position: number) => number): LayaScoreResult {
  return {
    model_fingerprint: FINGERPRINT,
    question_version: 'relevance-2026-09-23.1',
    scores: candidates.map((candidate, position) => {
      const value = score(candidate, position);
      return {
        chunk_key: candidate.chunk_key,
        probabilities: { A: value, B: 0, C: 1 - value },
        input_tokens: 4,
        truncated: false
      };
    })
  };
}

test('current reads resolve by id, path, and title with explicit current source identity', async () => {
  const ground = await openGround();
  try {
    const id = randomUUID();
    const managed = doc('# Managed title\n\nmanaged body\n', { id });
    const human = doc('# Human title\n\nhuman body\n');
    await put(ground, 'Knowledge/Managed.md', managed);
    await put(ground, 'Knowledge/Human.md', human);
    const c = ctx();
    const byId = await readLocal(c, { id }, ground.deps);
    const byPath = await readLocal(c, { path: 'Knowledge/Managed.md' }, ground.deps);
    const byTitle = await readLocal(c, { title: 'Managed title' }, ground.deps);
    for (const result of [byId, byPath, byTitle]) {
      expect(result.markdown).toBe(managed);
      expect(result.next_cursor).toBeUndefined();
      expect(result.source).toMatchObject({
        id,
        title: 'Managed title',
        relative_path: 'Knowledge/Managed.md',
        etag: sha(managed),
        status: 'active'
      });
      expect(result.source.revision_id).toBe(ground.catalogue.getById(id)?.revision_id);
      expect(result.source.warnings).not.toContain('historical');
    }
    const unmanaged = await readLocal(c, { path: 'Knowledge/Human.md' }, ground.deps);
    expect(unmanaged.markdown).toBe(human);
    expect(unmanaged.source.relative_path).toBe('Knowledge/Human.md');
    expect(unmanaged.source.revision_id).toBe(unmanaged.source.etag);
    await expect(readLocal(c, { title: 'Missing title' }, ground.deps)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(readLocal(c, { id, path: 'Knowledge/Managed.md' }, ground.deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(readLocal(c, { path: 'Knowledge/Human.md', revision_id: randomUUID() }, ground.deps))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  } finally {
    await ground.dispose();
  }
});

test('an ambiguous title returns AMBIGUOUS_REFERENCE with candidate paths and a project filter never widens', async () => {
  const ground = await openGround();
  try {
    await put(ground, 'Projects/Beta/Plan.md', doc('# Plan\n\nbeta plan\n'));
    await put(ground, 'Projects/Gamma/Plan.md', doc('# Plan\n\ngamma plan\n'));
    const c = ctx();
    const ambiguous = readLocal(c, { title: 'Plan' }, ground.deps);
    await expect(ambiguous).rejects.toMatchObject({ code: 'AMBIGUOUS_REFERENCE' });
    await expect(ambiguous).rejects.toThrow(/Projects\/Beta\/Plan\.md.*Projects\/Gamma\/Plan\.md/);
    const beta = await readLocal(c, { title: 'Plan', project: 'beta' }, ground.deps);
    expect(beta.source.relative_path).toBe('Projects/Beta/Plan.md');
    expect(beta.markdown).toContain('beta plan');
    await expect(readLocal(c, { path: 'Projects/Gamma/Plan.md', project: 'beta' }, ground.deps))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(readLocal(c, { title: 'Plan', project: 'unknown-project' }, ground.deps))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await ground.dispose();
  }
});

test('a duplicate managed id is an identity conflict for current reads while revisions stay addressable and resolution removes absorbed recall hits', async () => {
  const ground = await openGround();
  try {
    const id = randomUUID();
    const rootRaw = doc('# root\n\nroot\n', { id, status: 'candidate' });
    const rootRev = randomUUID();
    await ground.revisions.persistRevision(id, rootRev, rootRaw);
    await ground.revisions.persistRevisionMetadata({ id, revision_id: rootRev, parents: [], created_at: new Date().toISOString() });
    const branches: { path: string; raw: string; rev: string }[] = [
      { path: 'Knowledge/A.md', raw: doc('# forkmarker A\n\nforkmarker alpha branch\n', { id, status: 'candidate' }), rev: randomUUID() },
      { path: 'Knowledge/B.md', raw: doc('# forkmarker B\n\nforkmarker beta branch\n', { id, status: 'candidate' }), rev: randomUUID() }
    ];
    for (const branch of branches) {
      await ground.revisions.persistRevision(id, branch.rev, branch.raw);
      await ground.revisions.persistRevisionMetadata({
        id, revision_id: branch.rev, parents: [{ revision_id: rootRev, raw_hash: sha(rootRaw) }], created_at: new Date().toISOString()
      });
      await put(ground, branch.path, branch.raw);
      await ground.revisions.bindCurrent(id, branch.path, branch.rev, sha(branch.raw));
    }
    const c = ctx();
    const current = readLocal(c, { id }, ground.deps);
    await expect(current).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(current).rejects.toThrow(/Knowledge\/A\.md.*Knowledge\/B\.md/);
    await expect(readLocal(c, { path: 'Knowledge/B.md' }, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const branch of branches) {
      const historical = await readLocal(c, { id, revision_id: branch.rev }, ground.deps);
      expect(historical.markdown).toBe(branch.raw);
      expect(historical.source).toMatchObject({ id, revision_id: branch.rev, etag: sha(branch.raw) });
      expect(historical.source.warnings).toContain('historical');
    }
    const heads = await ground.deps.mutations.enumerateConflictHeads(id);
    const resolved = await reviewLocal(c, { operation: {
      action: 'resolve', idempotency_key: randomUUID(), id,
      expected_heads: heads.map((head) => ({ revision_id: head.revision_id, etag: head.etag })),
      rationale: 'merge', note: note('forkmarker resolved', 'forkmarker merged branches')
    } }, ground.deps);
    expect('outcome' in resolved && resolved.outcome).toBe('stored');
    const survivor = await readLocal(c, { id }, ground.deps);
    const recalled = await recallLocal(c, { query: 'forkmarker', include_candidates: true }, ground.deps);
    const paths = recalled.items.map((item) => item.relative_path);
    expect(paths.length).toBeGreaterThan(0);
    expect(recalled.items.every((item) => item.id === id)).toBe(true);
    expect(paths.every((path) => path === survivor.source.relative_path)).toBe(true);
    const absorbed = branches.map((branch) => branch.path).filter((path) => path !== survivor.source.relative_path);
    for (const path of absorbed) expect(paths).not.toContain(path);
    for (const branch of branches) {
      expect((await readLocal(c, { id, revision_id: branch.rev }, ground.deps)).markdown).toBe(branch.raw);
    }
  } finally {
    await ground.dispose();
  }
});

test('current and historical reads paginate with signed source-bound cursors', async () => {
  const ground = await openGround();
  try {
    const id = randomUUID();
    const body = Array.from({ length: 400 }, (_value, index) => `Paragraph ${index} carries several distinct words.`).join('\n\n');
    const raw = doc(`# Long note\n\n${body}\n`, { id });
    await put(ground, 'Knowledge/Long.md', raw);
    await reconcileDeps(ground.deps);
    const revision = ground.catalogue.getById(id)?.revision_id as string;
    const c = ctx();
    const collect = async (request: { id: string; revision_id?: string }): Promise<{ text: string; pages: number; cursors: string[] }> => {
      let text = '';
      let cursor: string | undefined;
      let pages = 0;
      const cursors: string[] = [];
      do {
        const page = await readLocal(c, { ...request, budget_tokens: 256, ...(cursor === undefined ? {} : { cursor }) }, ground.deps);
        text += page.markdown;
        pages += 1;
        cursor = page.next_cursor;
        if (cursor !== undefined) cursors.push(cursor);
        if (request.revision_id !== undefined) expect(page.source.revision_id).toBe(request.revision_id);
      } while (cursor !== undefined && pages < 200);
      return { text, pages, cursors };
    };
    const current = await collect({ id });
    expect(current.text).toBe(raw);
    expect(current.pages).toBeGreaterThan(2);
    expect(current.cursors[0]).not.toMatch(/^eyJ/);
    const historical = await collect({ id, revision_id: revision });
    expect(historical.text).toBe(raw);
    expect(historical.pages).toBeGreaterThan(2);

    const first = await readLocal(c, { id, budget_tokens: 256 }, ground.deps);
    const cursor = first.next_cursor as string;
    const [prefix, bodyPart, signature] = cursor.split('.');
    const tampered = `${prefix}.${bodyPart}.${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(readLocal(c, { id, cursor: tampered }, ground.deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const legacyUnsigned = Buffer.from(JSON.stringify({ etag: sha(raw), offset: 10 }), 'utf8').toString('base64url');
    await expect(readLocal(c, { id, cursor: legacyUnsigned }, ground.deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const otherId = randomUUID();
    await put(ground, 'Knowledge/Other.md', doc(`# Other\n\n${body}\n`, { id: otherId }));
    await expect(readLocal(c, { id: otherId, cursor }, ground.deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const historicalCursor = historical.cursors[0];
    await expect(readLocal(c, { id, revision_id: randomUUID(), cursor: historicalCursor }, ground.deps))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await put(ground, 'Knowledge/Long.md', doc(`# Long note\n\n${body}\n\nEdited.\n`, { id }));
    await expect(readLocal(c, { id, cursor }, ground.deps)).rejects.toMatchObject({ code: 'CONFLICT' });
    const stillHistorical = await readLocal(c, { id, revision_id: revision, cursor: historicalCursor }, ground.deps);
    expect(stillHistorical.source.revision_id).toBe(revision);
    expect(stillHistorical.source.warnings).toContain('historical');
  } finally {
    await ground.dispose();
  }
});

test('a paginated read without a configured cursor secret fails closed instead of issuing unsigned cursors', async () => {
  const ground = await openGround({ secret: false });
  try {
    const id = randomUUID();
    const body = Array.from({ length: 200 }, (_value, index) => `Line ${index} of padded content.`).join('\n\n');
    await put(ground, 'Knowledge/Long.md', doc(`# Long\n\n${body}\n`, { id }));
    await expect(readLocal(ctx(), { id, budget_tokens: 256 }, ground.deps)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const short = await readLocal(ctx(), { id, budget_tokens: 8000 }, ground.deps);
    expect(short.next_cursor).toBeUndefined();
  } finally {
    await ground.dispose();
  }
});

test('an explicit project filter applies before the fifty-candidate limit', async () => {
  const ground = await openGround();
  try {
    for (let index = 0; index < 60; index += 1) {
      await put(ground, `Knowledge/Loud ${index}.md`, doc(`# Loud ${index}\n\nquasar quasar quasar quasar\n`));
    }
    const padding = Array.from({ length: 80 }, (_value, index) => `filler${index}`).join(' ');
    await put(ground, 'Projects/Beta/Quiet.md', doc(`# Quiet\n\nquasar ${padding}\n`));
    await put(ground, 'Inbox/Beta candidate.md', doc('# Inbox beta\n\nquasar beta inbox\n', { project: '[[Projects/Beta]]' }));
    const c = ctx();
    const unfiltered = await recallLocal(c, { query: 'quasar', limit: 12 }, ground.deps);
    expect(unfiltered.items.some((item) => item.relative_path === 'Projects/Beta/Quiet.md')).toBe(false);
    const filtered = await recallLocal(c, { query: 'quasar', project: 'beta', limit: 12 }, ground.deps);
    expect(filtered.items.map((item) => item.relative_path).sort()).toEqual(['Inbox/Beta candidate.md', 'Projects/Beta/Quiet.md']);
    const legacyAlias = await recallLocal(c, { query: 'quasar', scope: 'beta', limit: 12 }, ground.deps);
    expect(legacyAlias.items.map((item) => item.relative_path).sort()).toEqual(['Inbox/Beta candidate.md', 'Projects/Beta/Quiet.md']);
    await expect(recallLocal(c, { query: 'quasar', project: 'nowhere' }, ground.deps)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const kinds = await recallLocal(c, { query: 'quasar', project: 'beta', kinds: ['decision'] }, ground.deps);
    expect(kinds.items).toEqual([]);
  } finally {
    await ground.dispose();
  }
});

test('eligibility is rechecked against current metadata after ranking and stale chunks are omitted with a warning', async () => {
  let mutate: (() => Promise<void>) | undefined;
  const worker = new FakeWorker(async (candidates) => {
    await mutate?.();
    return scored(candidates, (_candidate, position) => 0.9 - position * 0.1);
  });
  const ground = await openGround({ worker });
  try {
    const archivedRaw = doc('# Nebula archived\n\nnebula archived later\n');
    const staleRaw = doc('# Nebula stale\n\nnebula stale bytes\n');
    await put(ground, 'Knowledge/Archived later.md', archivedRaw);
    await put(ground, 'Knowledge/Stale bytes.md', staleRaw);
    await put(ground, 'Knowledge/Stable.md', doc('# Nebula stable\n\nnebula stable\n'));
    const c = ctx();
    const before = await recallLocal(c, { query: 'nebula', mode: 'reranked' }, ground.deps);
    expect(before.mode).toBe('reranked');
    expect(before.items).toHaveLength(3);
    mutate = async () => {
      const archived = archivedRaw.replace('status: active', 'status: archived');
      await put(ground, 'Knowledge/Archived later.md', archived);
      ground.catalogue.upsert({ path: 'Knowledge/Archived later.md', raw: archived, etag: sha(archived) });
      await put(ground, 'Knowledge/Stale bytes.md', staleRaw.replace('stale bytes', 'fresh bytes changed'));
    };
    const after = await recallLocal(c, { query: 'nebula', mode: 'reranked' }, ground.deps);
    expect(after.items.map((item) => item.relative_path)).toEqual(['Knowledge/Stable.md']);
    expect(after.warnings).toContain('stale_hits_excluded');
    expect(after.partial).toBe(true);
  } finally {
    await ground.dispose();
  }
});

test('superseded and archived notes are excluded unless explicitly requested', async () => {
  const ground = await openGround();
  try {
    await put(ground, 'Knowledge/Active.md', doc('# Pulsar active\n\npulsar active\n'));
    await put(ground, 'Knowledge/Candidate.md', doc('# Pulsar candidate\n\npulsar candidate\n', { status: 'candidate' }));
    await put(ground, 'Knowledge/Superseded.md', doc('# Pulsar superseded\n\npulsar superseded\n', { status: 'superseded' }));
    await put(ground, 'Knowledge/Archived.md', doc('# Pulsar archived\n\npulsar archived\n', { status: 'archived' }));
    const c = ctx();
    const paths = async (request: Record<string, unknown>): Promise<string[]> =>
      (await recallLocal(c, { query: 'pulsar', limit: 12, ...request }, ground.deps)).items.map((item) => item.relative_path).sort();
    expect(await paths({})).toEqual(['Knowledge/Active.md']);
    expect(await paths({ include_candidates: true })).toEqual(['Knowledge/Active.md', 'Knowledge/Candidate.md']);
    expect(await paths({ include_superseded: true })).toEqual(['Knowledge/Active.md', 'Knowledge/Superseded.md']);
    expect(await paths({ include_archived: true })).toEqual(['Knowledge/Active.md', 'Knowledge/Archived.md']);
    const superseded = await recallLocal(c, { query: 'pulsar', include_superseded: true }, ground.deps);
    expect(superseded.items.find((item) => item.relative_path === 'Knowledge/Superseded.md')?.warnings).toContain('superseded');
  } finally {
    await ground.dispose();
  }
});

test('opt-in graph expansion adds at most ten bounded, deduplicated, filtered neighbours with relationship reasons', async () => {
  const ground = await openGround();
  try {
    const links = Array.from({ length: 12 }, (_value, index) => `[[Knowledge/Neighbour ${index}]]`).join('\n');
    await put(ground, 'Knowledge/Hub.md', doc(`# Hub\n\ncomet hub\n\n${links}\n\n[[Knowledge/Cycle]]\n`));
    await put(ground, 'Knowledge/Cycle.md', doc('# Cycle\n\ncomet cycle\n\n[[Knowledge/Hub]]\n'));
    for (let index = 0; index < 12; index += 1) {
      await put(ground, `Knowledge/Neighbour ${index}.md`, doc(`# Neighbour ${index}\n\nunrelated words ${index}\n`,
        { status: index === 0 ? 'archived' : 'active' }));
    }
    await put(ground, 'Knowledge/Typed seed.md', doc('# Typed\n\nbolide typed\n', { related: ['[[Knowledge/Typed target]]'] }));
    await put(ground, 'Knowledge/Typed target.md', doc('# Typed target\n\ntarget words\n'));
    const c = ctx();
    const lexical = await recallLocal(c, { query: 'comet', limit: 12, budget_tokens: 4000 }, ground.deps);
    expect(lexical.items.every((item) => item.reasons.every((reason) => !reason.startsWith('graph')))).toBe(true);
    expect(lexical.items.map((item) => item.relative_path).sort()).toEqual(['Knowledge/Cycle.md', 'Knowledge/Hub.md']);
    const expanded = await recallLocal(c, { query: 'comet', limit: 12, budget_tokens: 4000, expand_graph: true }, ground.deps);
    const graphItems = expanded.items.filter((item) => item.reasons.some((reason) => reason.startsWith('graph:')));
    const lexicalPaths = new Set(lexical.items.map((item) => item.relative_path));
    expect(graphItems.length).toBeGreaterThan(0);
    expect(graphItems.length).toBeLessThanOrEqual(10);
    for (const item of graphItems) {
      expect(lexicalPaths.has(item.relative_path)).toBe(false);
      expect(item.reasons).not.toContain('lexical');
      expect(item.reasons.some((reason) => reason.startsWith('graph_edge:'))).toBe(true);
    }
    expect(graphItems.map((item) => item.relative_path)).not.toContain('Knowledge/Neighbour 0.md');
    const typedResult = await recallLocal(c, { query: 'bolide', expand_graph: true }, ground.deps);
    expect(typedResult.items.map((item) => item.relative_path)).toEqual(['Knowledge/Typed seed.md', 'Knowledge/Typed target.md']);
    const typed = typedResult.items.find((item) => item.relative_path === 'Knowledge/Typed target.md');
    expect(typed?.reasons).toContain('graph:related');
    expect(typed?.reasons).toContain('graph_edge:outgoing:Knowledge/Typed seed.md');
    const hubNeighbour = graphItems.find((item) => item.relative_path.startsWith('Knowledge/Neighbour'));
    expect(hubNeighbour?.reasons).toContain('graph:link');
    expect(hubNeighbour?.reasons).toContain('graph_edge:outgoing:Knowledge/Hub.md');
    const unique = new Set(expanded.items.map((item) => `${item.relative_path}:${item.start_line}`));
    expect(unique.size).toBe(expanded.items.length);
    const allNeighbours = await recallLocal(c, { query: 'comet', limit: 12, budget_tokens: 4000, expand_graph: true, include_archived: true }, ground.deps);
    const added = allNeighbours.items.filter((item) => item.reasons.some((reason) => reason.startsWith('graph:')));
    expect(added.length).toBeLessThanOrEqual(10);
  } finally {
    await ground.dispose();
  }
});

test('recall returns exact source excerpts with line spans under the token budget', async () => {
  const ground = await openGround();
  try {
    const id = randomUUID();
    const sections = Array.from({ length: 30 }, (_value, index) =>
      `## Section ${index}\n\nmeteor section ${index} ${'detail '.repeat(40)}`).join('\n\n');
    const raw = doc(`# Meteor\n\n${sections}\n`, { id });
    await put(ground, 'Knowledge/Meteor.md', raw);
    await put(ground, 'Knowledge/Meteor two.md', doc(`# Meteor two\n\n${sections}\n`));
    const c = ctx();
    const result = await recallLocal(c, { query: 'meteor', limit: 12, budget_tokens: 256 }, ground.deps);
    expect(result.budget).toMatchObject({ tokenizer: 'cl100k_base', limit: 256 });
    expect(result.budget.used).toBeLessThanOrEqual(256);
    expect(result.warnings).toContain('budget_exhausted');
    expect(result.partial).toBe(true);
    const wide = await recallLocal(c, { query: 'meteor', limit: 12, budget_tokens: 4000 }, ground.deps);
    expect(wide.items.length).toBeGreaterThan(result.items.length);
    const perNote = new Map<string, number>();
    for (const item of wide.items) perNote.set(item.relative_path, (perNote.get(item.relative_path) ?? 0) + 1);
    for (const count of perNote.values()) expect(count).toBeLessThanOrEqual(2);
    for (const item of [...result.items, ...wide.items]) {
      const source = item.relative_path === 'Knowledge/Meteor.md' ? raw : (await ground.store.readPath(item.relative_path)).raw;
      const lines = source.split('\n').slice((item.start_line as number) - 1, item.end_line as number).join('\n');
      expect(lines).toContain(item.excerpt);
      expect(item.excerpt.length).toBeGreaterThan(0);
      expect(item.etag).toBe(sha(source));
      expect(typeof item.title).toBe('string');
      expect(item).toHaveProperty('heading');
      if (item.relative_path === 'Knowledge/Meteor.md') {
        expect(item.id).toBe(id);
        expect(item.revision_id).toBe(ground.catalogue.getById(id)?.revision_id);
      } else {
        expect(item.revision_id).toBe(item.etag);
      }
    }
  } finally {
    await ground.dispose();
  }
});

test('text mode never touches the worker and reranked mode reorders with a ready worker', async () => {
  const worker = new FakeWorker(async (candidates) => scored(candidates, (_candidate, position) => 0.1 + position * 0.05));
  const ground = await openGround({ worker });
  try {
    for (const name of ['One', 'Two', 'Three']) {
      await put(ground, `Knowledge/${name}.md`, doc(`# ${name}\n\nzenith ${name.toLowerCase()}\n`));
    }
    const c = ctx();
    const text = await recallLocal(c, { query: 'zenith' }, ground.deps);
    expect(text.mode).toBe('text');
    expect(worker.calls).toBe(0);
    const reranked = await recallLocal(c, { query: 'zenith', mode: 'reranked' }, ground.deps);
    expect(reranked.mode).toBe('reranked');
    expect(worker.calls).toBe(1);
    expect(reranked.items.map((item) => item.relative_path)).toEqual([...text.items].reverse().map((item) => item.relative_path));
    const hybrid = await recallLocal(c, { query: 'zenith', mode: 'hybrid' }, ground.deps);
    expect(hybrid.mode).toBe('reranked');
    expect(hybrid.warnings.some((warning) => warning.startsWith('hybrid_deprecated'))).toBe(true);
  } finally {
    await ground.dispose();
  }
});

test('a missing, disabled, failed, or malformed worker falls back to lexical order unless fallback is disabled', async () => {
  const seed = async (ground: Ground): Promise<void> => {
    for (const name of ['One', 'Two', 'Three']) {
      await put(ground, `Knowledge/${name}.md`, doc(`# ${name}\n\nhorizon ${name.toLowerCase()}\n`));
    }
  };
  const cases: { label: string; worker?: RerankWorker; reason: string }[] = [
    { label: 'missing', reason: 'disabled' },
    { label: 'disabled', worker: new FakeWorker(async (candidates) => scored(candidates, () => 0.5), 'disabled'), reason: 'disabled' },
    { label: 'failed', worker: new FakeWorker(() => Promise.reject(Object.assign(new Error('boom'), { reason: 'inference_failed' }))), reason: 'malformed' },
    { label: 'timeout', worker: new FakeWorker(() => Promise.reject(Object.assign(new Error('slow'), { reason: 'timeout' }))), reason: 'timeout' },
    { label: 'overloaded', worker: new FakeWorker(() => Promise.reject(Object.assign(new Error('busy'), { reason: 'overloaded' }))), reason: 'overloaded' },
    { label: 'malformed', worker: new FakeWorker(async () => ({ model_fingerprint: FINGERPRINT, question_version: 'x', scores: [] })), reason: 'malformed' },
    { label: 'nonfinite', worker: new FakeWorker(async (candidates) => scored(candidates, () => Number.NaN)), reason: 'invalid_scores' }
  ];
  for (const entry of cases) {
    const ground = await openGround(entry.worker === undefined ? {} : { worker: entry.worker });
    try {
      await seed(ground);
      const c = ctx();
      const text = await recallLocal(c, { query: 'horizon' }, ground.deps);
      const fallback = await recallLocal(c, { query: 'horizon', mode: 'reranked' }, ground.deps);
      expect(fallback.mode, entry.label).toBe('text');
      expect(fallback.warnings, entry.label).toContain(`reranker_unavailable:${entry.reason}`);
      expect(fallback.items.map((item) => item.relative_path), entry.label).toEqual(text.items.map((item) => item.relative_path));
      await expect(recallLocal(c, { query: 'horizon', mode: 'reranked', allow_text_fallback: false }, ground.deps), entry.label)
        .rejects.toMatchObject({ code: 'EMBEDDINGS_UNAVAILABLE' });
    } finally {
      await ground.dispose();
    }
  }
});

test('a caller cancellation during reranking cancels the worker call and the recall', async () => {
  const controller = new AbortController();
  const worker = new FakeWorker(async (candidates, signal) => {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signal?.aborted).toBe(true);
    return scored(candidates, () => 0.5);
  });
  const ground = await openGround({ worker });
  try {
    await put(ground, 'Knowledge/One.md', doc('# One\n\neclipse one\n'));
    await expect(recallLocal(ctx(controller.signal), { query: 'eclipse', mode: 'reranked' }, ground.deps))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(worker.lastSignal?.aborted).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await expect(recallLocal(ctx(aborted.signal), { query: 'eclipse' }, ground.deps)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(readLocal(ctx(aborted.signal), { path: 'Knowledge/One.md' }, ground.deps)).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(statusLocal(ctx(aborted.signal), {}, ground.deps)).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    await ground.dispose();
  }
});

test('pending coordinator operations keep their identities and paths out of recall', async () => {
  const ground = await openGround();
  try {
    const id = randomUUID();
    await put(ground, 'Knowledge/Pending head.md', doc('# Aurora pending\n\naurora pending\n', { id }));
    await put(ground, 'Knowledge/Pending target.md', doc('# Aurora target\n\naurora target\n'));
    await put(ground, 'Knowledge/Free.md', doc('# Aurora free\n\naurora free\n'));
    const c = ctx();
    expect((await recallLocal(c, { query: 'aurora' }, ground.deps)).items).toHaveLength(3);
    const reserved = ground.operations.reserve({
      idempotency_key: randomUUID(), tool: 'brain_review', action: 'resolve', project_id: null,
      payload_hash: 'a'.repeat(64), payload_json: '{}', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }, () => randomUUID());
    ground.operations.update(reserved.record.operation_id, {
      plan_json: JSON.stringify({
        kind: 'note', heads: [{ id, path: 'Knowledge/Pending head.md' }],
        effects: [{ kind: 'write', write: { path: 'Knowledge/Pending target.md' } }]
      })
    });
    const pending = await recallLocal(c, { query: 'aurora' }, ground.deps);
    expect(pending.items.map((item) => item.relative_path)).toEqual(['Knowledge/Free.md']);
    const status = await statusLocal(c, { operation_id: reserved.record.operation_id }, ground.deps);
    expect(status.pending_operations).toBe(1);
    expect(status.health.gateway).toBe('recovering');
  } finally {
    await ground.dispose();
  }
});

test('status reports real schemas, local index and worker health, pending work, projects, and operation receipts', async () => {
  const worker = new FakeWorker(async (candidates) => scored(candidates, () => 0.5));
  const ground = await openGround({ worker });
  try {
    await put(ground, 'Knowledge/One.md', doc('# One\n\nstatus one\n'));
    const c = ctx();
    const status = await statusLocal(c, { include_schemas: true }, ground.deps);
    expect(status.protocol).toBe(2);
    expect(status.protocol_version).toBe('2');
    expect(status.local?.index).toMatchObject({ state: 'ready', documents: 1, pending_index: 0 });
    expect(status.local?.worker).toEqual({ state: 'ready', model_fingerprint: FINGERPRINT });
    expect(status.features).toEqual({ reranking: true, text_search: true, fallback: true });
    expect(status.health.gateway).toBe('ready');
    expect(status.pending_operations).toBe(0);
    expect(JSON.stringify(status)).not.toMatch(/permission|can_read|can_write|can_review|read_scopes|write_scopes/);
    const schemas = status.schemas as Record<string, { input_schema: unknown; output_schema: unknown }>;
    expect(Object.keys(schemas).sort()).toEqual([...TOOL_NAMES].sort());
    for (const definition of toolDefinitions) {
      expect(schemas[definition.name].input_schema).toEqual(definition.inputSchema);
      expect(schemas[definition.name].output_schema).toEqual(definition.outputSchema);
      expect(Object.keys(schemas[definition.name].input_schema as object).length).toBeGreaterThan(0);
    }
    expect(status.projects?.map((project) => project.scope)).toEqual(expect.arrayContaining(['beta', 'gamma', 'shared']));

    const captured = await captureLocal(c, { idempotency_key: randomUUID(), project: 'beta', note: note('Status note', 'status marker') }, ground.deps);
    const lookup = await statusLocal(c, { operation_id: captured.operation_id }, ground.deps);
    expect(lookup.operation).toMatchObject({ operation_id: captured.operation_id, id: captured.id, revision_id: captured.revision_id });
    const scoped = await statusLocal(c, { project: 'beta', operation_id: captured.operation_id }, ground.deps);
    expect(scoped.operation).toMatchObject({ operation_id: captured.operation_id });
    expect(scoped.projects?.map((project) => project.scope)).toEqual(['beta']);
    await expect(statusLocal(c, { project: 'gamma', operation_id: captured.operation_id }, ground.deps))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(statusLocal(c, { operation_id: captured.revision_id }, ground.deps)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(statusLocal(c, { project: 'nowhere' }, ground.deps)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    await ground.dispose();
  }
});

test('status and recall report index lag from durable pending index work', async () => {
  const ground = await openGround();
  try {
    await put(ground, 'Knowledge/Indexed.md', doc('# Lag indexed\n\nlagword indexed\n'));
    const c = ctx();
    const baseline = await statusLocal(c, {}, ground.deps);
    expect(baseline.local?.index.pending_index).toBe(0);
    const raw = doc('# Lag pending\n\nlagword pending\n');
    await ground.store.put({ path: 'Knowledge/Pending.md', raw, expectedEtag: null, idempotencyKey: randomUUID(), source: 'test' });
    const indexState = ground.brain.index;
    const failing = Object.create(indexState) as typeof indexState;
    failing.upsert = () => { throw new Error('index offline'); };
    ground.deps = { ...ground.deps, index: failing };
    const lagging = await statusLocal(c, {}, ground.deps);
    expect(lagging.local?.index.pending_index).toBe(1);
    const recalled = await recallLocal(c, { query: 'lagword' }, ground.deps);
    expect(recalled.warnings).toContain('index_lag');
    expect(recalled.items.map((item) => item.relative_path)).toEqual(['Knowledge/Indexed.md']);
  } finally {
    await ground.dispose();
  }
});

test('the deleted local brain facade leaves the canonical handlers as the only implementation', async () => {
  const { access, readFile } = await import('node:fs/promises');
  await expect(access(new URL('../../src/features/local-brain.ts', import.meta.url))).rejects.toMatchObject({
    code: 'ENOENT'
  });
  const runtime = await readFile(new URL('../../src/runtime.ts', import.meta.url), 'utf8');
  expect(runtime).toMatch(/readLocal/);
  expect(runtime).toMatch(/recallLocal/);
  expect(runtime).toMatch(/statusLocal/);
});

test('a real recall and rerank path populates trace identifiers, positions, and reranker metadata', async () => {
  const worker = new FakeWorker((candidates) =>
    Promise.resolve(scored(candidates, () => 0.5))
  );
  const ground = await openGround({ worker });
  const disabled = await openGround({ worker: new FakeWorker((candidates) => Promise.resolve(scored(candidates, () => 0.5)), 'disabled') });
  try {
    await put(ground, 'Knowledge/Alpha.md', doc('# Alpha trace\n\nalphatrace body\n', { id: randomUUID() }));
    await put(ground, 'Knowledge/Beta.md', doc('# Beta trace\n\nalphatrace other\n', { id: randomUUID() }));
    await put(disabled, 'Knowledge/Gamma.md', doc('# Gamma trace\n\nalphatrace disabled\n', { id: randomUUID() }));
    const c = ctx();

    const lexical = await recallLocalTraced(c, { query: 'alphatrace', limit: 5 }, ground.deps);
    expect(lexical.result.items.length).toBeGreaterThan(0);
    expect(lexical.trace.query_id).toBe(retrievalQueryId({ query: 'alphatrace' }));
    expect(lexical.trace.question_id).toBe(LEXICAL_QUESTION_ID);
    expect(lexical.trace.question_version).toBe(LEXICAL_QUESTION_VERSION);
    expect(lexical.trace.candidate_positions).toHaveLength(lexical.result.items.length);
    expect(lexical.trace.model_fingerprint).toBeUndefined();

    const reranked = await recallLocalTraced(
      c,
      { query: 'alphatrace', limit: 5, mode: 'reranked' },
      ground.deps
    );
    expect(reranked.result.mode).toBe('reranked');
    expect(reranked.trace.question_id).toBe(RERANK_QUESTION_ID);
    expect(reranked.trace.question_version).toBe('relevance-2026-09-23.1');
    expect(reranked.trace.model_fingerprint).toBe(FINGERPRINT);
    expect(reranked.trace.candidate_positions).toHaveLength(reranked.result.items.length);
    expect(reranked.trace.fallback_reason).toBeUndefined();

    const fallback = await recallLocalTraced(c, { query: 'alphatrace', mode: 'reranked' }, disabled.deps);
    expect(fallback.trace.fallback_reason).toBe('disabled');

    const event = retrievalEventFromRecall(c, reranked.result, {
      filter: { mode: 'all' },
      searched_project_ids: [],
      primary_project_id: null,
      duration_ms: 1
    });
    ground.journal.recordRetrievalV2({
      ...event,
      query_id: reranked.trace.query_id,
      question_id: reranked.trace.question_id,
      question_version: reranked.trace.question_version,
      candidate_positions: reranked.trace.candidate_positions,
      ...(reranked.trace.model_fingerprint === undefined
        ? {}
        : { model_fingerprint: reranked.trace.model_fingerprint })
    });
    const stored = ground.journal.getRetrievalV2(event.retrieval_id);
    expect(stored).toMatchObject({
      query_id: reranked.trace.query_id,
      question_id: RERANK_QUESTION_ID,
      question_version: 'relevance-2026-09-23.1',
      model_fingerprint: FINGERPRINT,
      candidate_positions: reranked.trace.candidate_positions
    });
  } finally {
    await ground.dispose();
    await disabled.dispose();
  }
});
