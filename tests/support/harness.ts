import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainConfig } from '../../src/config/schema.js';
import {
  BACKEND_TIMEOUT_MS,
  CONCURRENT_READS,
  INPUT_BODY_MAX_BYTES,
  RECONCILE_INTERVAL_MS,
  RENDERED_NOTE_MAX_BYTES,
  TOOL_RESULT_MAX_BYTES
} from '../../src/core/limits.js';
import {
  InstanceLock,
  MutationCoordinator,
  type BrainDeps,
  type ExpectedHead,
  type MutationIntent,
  type RevisionBuilder
} from '../../src/core/mutation.js';
import type {
  Clock,
  Head,
  IdSource,
  Lifecycle,
  NoteInput,
  StoredRevision
} from '../../src/core/types.js';
import { RevisionCatalogue } from '../../src/notes/catalogue.js';
import { payloadHash, renderRevision } from '../../src/notes/codec.js';
import { relativePathFor } from '../../src/notes/identity.js';
import { Journal } from '../../src/storage/journal.js';
import { FileVault } from '../../src/storage/vault.js';
import { fixtureIds } from '../fixtures/content.js';
import { reviewerPrincipal, scopeFixtures } from '../fixtures/principals.js';
import { FakeBackend } from './fake-backend.js';
import { FaultScheduler, wrapJournal, type FaultOptions, type FaultPoint } from './fault-scheduler.js';

const MATERIALIZATION_TIMEOUT_MS = 200;
export const VAULT_LOCK_NAME = '.brain-instance.lock';

export interface MemoryHarness {
  deps: BrainDeps;
  backend: FakeBackend;
  seed(note: NoteInput, options?: { scope?: string; status?: Lifecycle }): Promise<Head>;
  externalEdit(head: Head, transform: (raw: string) => string): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface CandidateOptions {
  idempotency_key?: string;
  scope?: string;
  status?: Lifecycle;
  expected_heads?: ExpectedHead[];
  approved_by?: string;
  rationale?: string;
}

export interface CandidateRequest {
  intent: MutationIntent;
  build: RevisionBuilder;
}

export function createCandidateIntent(note: NoteInput, options: CandidateOptions = {}): CandidateRequest {
  const scope = options.scope ?? 'freellmapi';
  const status = options.status ?? 'candidate';
  const intent: MutationIntent = {
    tool: 'brain_capture',
    scope,
    idempotency_key: options.idempotency_key ?? fixtureIds.idempotencyKey,
    payload: { note },
    expected_heads: options.expected_heads ?? []
  };
  const build: RevisionBuilder = (identities, heads) => {
    const base: StoredRevision = {
      id: identities.note_id,
      revision_id: identities.revision_id,
      parents: heads.map((head) => ({
        revision_id: head.revision.revision_id,
        raw_hash: head.raw_hash
      })),
      scope,
      status,
      note,
      created_at: identities.timestamp,
      modified_at: identities.timestamp,
      operation_id: identities.operation_id,
      extra_frontmatter: {},
      extra_markdown: ''
    };
    if (status === 'candidate') return base;
    return {
      ...base,
      approval: {
        principal_id: options.approved_by ?? reviewerPrincipal.id,
        rationale: options.rationale ?? 'seeded approval for tests',
        payload_hash: payloadHash(base)
      }
    };
  };
  return { intent, build };
}

class MemoryHarnessImpl implements MemoryHarness {
  deps!: BrainDeps;
  readonly backend: FakeBackend;
  readonly scheduler = new FaultScheduler();
  private readonly root: string;
  private readonly vaultRoot: string;
  private readonly stateDir: string;
  private readonly config: BrainConfig;
  private readonly clock: Clock = { now: () => new Date() };
  private readonly ids: IdSource = { next: () => randomUUID() };
  private lock: InstanceLock | undefined;
  private vaultLock: InstanceLock | undefined;
  private journal!: Journal;
  private catalogue!: RevisionCatalogue;
  private closed = false;

  constructor(root: string) {
    this.root = root;
    this.vaultRoot = join(root, 'vault');
    this.stateDir = join(root, 'state');
    const scopes = scopeFixtures.map((scope) => ({ ...scope }));
    this.config = {
      endpoint: 'http://127.0.0.1:7331/mcp',
      backend_endpoint: 'http://memory:8000/mcp',
      port: 7331,
      mounts: { vault: this.vaultRoot, state: this.stateDir },
      credentials_file: join(root, 'credentials.json'),
      scopes,
      limits: {
        input_body_max_bytes: INPUT_BODY_MAX_BYTES,
        rendered_note_max_bytes: RENDERED_NOTE_MAX_BYTES,
        tool_result_max_bytes: TOOL_RESULT_MAX_BYTES,
        backend_timeout_ms: BACKEND_TIMEOUT_MS,
        materialization_timeout_ms: MATERIALIZATION_TIMEOUT_MS,
        reconcile_interval_ms: RECONCILE_INTERVAL_MS,
        concurrent_reads: CONCURRENT_READS
      },
      allowed_hosts: ['127.0.0.1'],
      allowed_origins: []
    };
    this.backend = new FakeBackend({
      root: this.vaultRoot,
      projects: scopes.map((scope) => scope.backend_project)
    });
  }

  async start(): Promise<void> {
    try {
      await mkdir(this.vaultRoot, { recursive: true });
      for (const scope of this.config.scopes) {
        await mkdir(join(this.vaultRoot, scope.relative_root), { recursive: true });
      }
      this.lock = InstanceLock.acquire(this.stateDir);
      this.vaultLock = InstanceLock.acquire(this.vaultRoot, VAULT_LOCK_NAME);
      await this.backend.connect();
      this.openServices();
    } catch (error) {
      this.vaultLock?.release();
      this.lock?.release();
      await this.backend.close().catch(() => undefined);
      await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private openServices(): void {
    this.journal = Journal.open(join(this.stateDir, 'journal.db'), {
      clock: this.clock,
      ids: this.ids
    });
    const vault = new FileVault(this.vaultRoot, this.config.scopes);
    this.catalogue = RevisionCatalogue.open(join(this.stateDir, 'catalogue.db'), {
      vault,
      scopes: this.config.scopes,
      clock: this.clock
    });
    const journal = wrapJournal(this.journal, this.scheduler);
    const mutations = new MutationCoordinator({
      config: this.config,
      backend: this.backend,
      vault,
      catalogue: this.catalogue,
      journal,
      clock: this.clock,
      ids: this.ids
    });
    this.deps = {
      config: this.config,
      backend: this.backend,
      vault,
      catalogue: this.catalogue,
      journal,
      clock: this.clock,
      ids: this.ids,
      mutations
    };
  }

  async seed(note: NoteInput, options: { scope?: string; status?: Lifecycle } = {}): Promise<Head> {
    const scopeId = options.scope ?? 'freellmapi';
    const status = options.status ?? 'candidate';
    const scope = this.config.scopes.find((candidate) => candidate.id === scopeId);
    if (scope === undefined) throw new Error(`unknown scope ${scopeId}`);
    const id = this.ids.next();
    const revisionId = this.ids.next();
    const operationId = this.ids.next();
    const timestamp = this.clock.now().toISOString();
    const base: StoredRevision = {
      id,
      revision_id: revisionId,
      parents: [],
      scope: scopeId,
      status,
      note,
      created_at: timestamp,
      modified_at: timestamp,
      operation_id: operationId,
      extra_frontmatter: {},
      extra_markdown: ''
    };
    const revision: StoredRevision =
      status === 'candidate'
        ? base
        : {
            ...base,
            approval: {
              principal_id: reviewerPrincipal.id,
              rationale: 'seeded approval for tests',
              payload_hash: payloadHash(base)
            }
          };
    const relativePath = relativePathFor(scope.relative_root, note.content.kind, id, note.title, revisionId);
    const absolute = join(this.vaultRoot, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, renderRevision(revision, scope), 'utf8');
    await this.catalogue.reconcile(scopeId);
    return this.catalogue.get(scopeId, id);
  }

  async externalEdit(head: Head, transform: (raw: string) => string): Promise<void> {
    const absolute = join(this.vaultRoot, head.source.relative_path);
    const raw = await readFile(absolute, 'utf8');
    await writeFile(absolute, transform(raw), 'utf8');
  }

  async restart(): Promise<void> {
    this.journal.close();
    this.catalogue.close();
    this.vaultLock?.release();
    this.lock?.release();
    try {
      this.lock = InstanceLock.acquire(this.stateDir);
      this.vaultLock = InstanceLock.acquire(this.vaultRoot, VAULT_LOCK_NAME);
      this.openServices();
    } catch (error) {
      this.vaultLock?.release();
      this.lock?.release();
      throw error;
    }
    await this.deps.mutations.recover();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.catalogue.close();
    this.journal.close();
    await this.backend.close();
    this.vaultLock?.release();
    this.lock?.release();
    await rm(this.root, { recursive: true, force: true });
  }
}

export async function createHarness(): Promise<MemoryHarness> {
  const root = await mkdtemp(join(tmpdir(), 'brain-harness-'));
  const harness = new MemoryHarnessImpl(root);
  await harness.start();
  return harness;
}

export function armFault(harness: MemoryHarness, point: FaultPoint, options?: FaultOptions): void {
  (harness as unknown as MemoryHarnessImpl).scheduler.arm(point, options);
}
