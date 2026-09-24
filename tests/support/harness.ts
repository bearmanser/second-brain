import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrainConfig, ResultDelivery } from '../../src/config/schema.js';
import {
  BACKEND_TIMEOUT_MS,
  CONCURRENT_READS,
  DYNAMIC_PROJECTS_MAX,
  INPUT_BODY_MAX_BYTES,
  PROJECT_PROVISION_GLOBAL_PER_MINUTE,
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
import {
  SYSTEM_ACTOR,
  type AuthenticatedContext,
  type Clock,
  type Head,
  type IdSource,
  type Lifecycle,
  type NoteInput,
  type StoredRevision,
  type VaultPort
} from '../../src/core/types.js';
import type { BrainServices } from '../../src/mcp/server.js';
import type { RerankWorker } from '../../src/retrieval/reranker.js';
import { ScopeRegistry } from '../../src/projects/scope-registry.js';
import {
  buildManifest,
  resolveBackupPath,
  type BackupManifest,
  type ManifestFile
} from '../../src/operations/backup.js';
import { RevisionCatalogue } from '../../src/notes/catalogue.js';
import { encodeRevision, payloadHash, renderRevision } from '../../src/notes/codec.js';
import { hashRaw, relativePathFor } from '../../src/notes/identity.js';
import { JournalApprovalProvenance } from '../../src/notes/reconcile.js';
import { createRuntime, type BrainRuntime } from '../../src/runtime.js';
import { Journal, type AuditEventRecord } from '../../src/storage/journal.js';
import { FileVault } from '../../src/storage/vault.js';
import { fixtureIds } from '../fixtures/content.js';
import { scopeFixtures } from '../fixtures/principals.js';
import { FakeBackend, createLegacyBackend } from './fake-backend.js';
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
        principal_id: options.approved_by ?? SYSTEM_ACTOR.id,
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
      scopes,
      limits: {
        input_body_max_bytes: INPUT_BODY_MAX_BYTES,
        rendered_note_max_bytes: RENDERED_NOTE_MAX_BYTES,
        tool_result_max_bytes: TOOL_RESULT_MAX_BYTES,
        backend_timeout_ms: BACKEND_TIMEOUT_MS,
        materialization_timeout_ms: MATERIALIZATION_TIMEOUT_MS,
        reconcile_interval_ms: RECONCILE_INTERVAL_MS,
        concurrent_reads: CONCURRENT_READS,
        project_provision_global_per_minute: PROJECT_PROVISION_GLOBAL_PER_MINUTE,
        dynamic_projects_max: DYNAMIC_PROJECTS_MAX
      },
      allowed_hosts: ['127.0.0.1'],
      allowed_origins: [],
      result_delivery: 'structured'
    };
    this.backend = createLegacyBackend({
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
    const scopeRegistry = new ScopeRegistry(this.config.scopes, this.journal);
    for (const scope of scopeRegistry.all()) {
      vault.registerScope(scope);
      this.backend.registerScope(scope);
    }
    this.catalogue = RevisionCatalogue.open(join(this.stateDir, 'catalogue.db'), {
      vault,
      scopes: scopeRegistry.all(),
      clock: this.clock,
      approval_provenance: new JournalApprovalProvenance(this.journal)
    });
    const journal = wrapJournal(this.journal, this.scheduler);
    const mutations = new MutationCoordinator({
      config: this.config,
      scopeRegistry,
      backend: this.backend,
      vault,
      catalogue: this.catalogue,
      journal,
      clock: this.clock,
      ids: this.ids
    });
    this.deps = {
      config: this.config,
      scopeRegistry,
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
    const timestamp = this.clock.now().toISOString();
    const operationId =
      status === 'candidate'
        ? this.ids.next()
        : this.journal.reserve({
            principal_id: SYSTEM_ACTOR.id,
            idempotency_key: randomUUID(),
            tool: 'brain_review',
            scope: scopeId,
            payload_hash: hashRaw(JSON.stringify(note)),
            payload_json: JSON.stringify({ note })
          }).record.operation_id;
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
              principal_id: SYSTEM_ACTOR.id,
              rationale: 'seeded approval for tests',
              payload_hash: payloadHash(base)
            }
          };
    const relativePath = relativePathFor(scope.relative_root, note.content.kind, id, note.title, revisionId);
    const absolute = join(this.vaultRoot, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, renderRevision(revision, scope), 'utf8');
    if (status !== 'candidate') {
      this.journal.savePlan(operationId, encodeRevision(revision, scope));
      this.journal.mark(operationId, 'submitted');
      this.journal.mark(operationId, 'complete', {
        operation_id: operationId,
        id,
        revision_id: revisionId,
        outcome: 'stored',
        materialized: true,
        indexed: true,
        possible_duplicates: [],
        warnings: []
      });
    }
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

export async function createLegacyHarness(): Promise<MemoryHarness> {
  const root = await mkdtemp(join(tmpdir(), 'brain-harness-'));
  const harness = new MemoryHarnessImpl(root);
  await harness.start();
  return harness;
}

export interface BackupFixture {
  root: string;
  manifest: BackupManifest;
  corrupt(relativePath: string): Promise<void>;
  close(): Promise<void>;
}

export async function makeBackupFixture(): Promise<BackupFixture> {
  const root = await mkdtemp(join(tmpdir(), 'brain-backup-'));
  const notePath = join(root, 'vault', 'Projects', 'freellmapi', 'Notes', 'test.md');
  await mkdir(dirname(notePath), { recursive: true });
  await writeFile(
    notePath,
    [
      '---',
      'brain_schema_version: 1',
      'brain_id: 0b8f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      'brain_revision_id: 1c9f2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
      'brain_scope: freellmapi',
      '---',
      '',
      '# Synthetic backup note',
      ''
    ].join('\n'),
    'utf8'
  );
  const statePath = join(root, 'state', 'journal.db');
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, 'synthetic-operational-database', 'utf8');
  const files: ManifestFile[] = [];
  for (const relativePath of [
    'vault/Projects/freellmapi/Notes/test.md',
    'state/journal.db'
  ]) {
    const buffer = await readFile(join(root, relativePath));
    files.push({
      path: relativePath,
      size: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex')
    });
  }
  const manifest = buildManifest(files, {
    application: 'second-brain',
    schema: 1,
    images: { brain: 'second-brain:test', memory: 'basic-memory:test' },
    stores: ['vault', 'brain-state'],
    created_at: '2026-09-20T00:00:00.000Z'
  });
  let closed = false;
  return {
    root,
    manifest,
    corrupt: async (relativePath: string) => {
      const absolute = resolveBackupPath(root, relativePath);
      const existing = await readFile(absolute);
      await writeFile(absolute, Buffer.concat([existing, Buffer.from('\ncorrupted\n')]));
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await rm(root, { recursive: true, force: true });
    }
  };
}

export function armFault(harness: MemoryHarness, point: FaultPoint, options?: FaultOptions): void {
  (harness as unknown as MemoryHarnessImpl).scheduler.arm(point, options);
}

export interface RecordedToolCall {
  tool: string;
  actor_id: string;
  request_id: string;
}

export interface HttpHarnessOptions {
  result_delivery?: ResultDelivery;
  allowed_hosts?: string[];
  allowed_origins?: string[];
  reconcile_interval_ms?: number;
  concurrent_reads?: number;
  vault?: VaultPort;
  token_digest?: string;
}

export interface HttpHarness {
  url: string;
  origin: string;
  port: number;
  token: string;
  rotatedToken: string;
  reviewerToken: string;
  ownerToken: string;
  credentialsFile: string;
  config: BrainConfig;
  runtime: BrainRuntime;
  backend: FakeBackend;
  recordedToolCalls(): RecordedToolCall[];
  auditedEvents(): AuditEventRecord[];
  loggedDiagnostics(): string[];
  connect(token: string, name?: string): Promise<Client>;
  close(): Promise<void>;
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function recordingServices(
  services: BrainServices,
  calls: RecordedToolCall[]
): BrainServices {
  const track =
    <A, R>(tool: string, invoke: (ctx: AuthenticatedContext, argument: A) => Promise<R>) =>
    (ctx: AuthenticatedContext, argument: A): Promise<R> => {
      calls.push({
        tool,
        actor_id: ctx.actor.id,
        request_id: ctx.request_id
      });
      return invoke(ctx, argument);
    };
  return {
    ...services,
    capture: track('brain_capture', services.capture),
    review: track('brain_review', services.review),
    recall: track('brain_recall', services.recall),
    read: track('brain_read', services.read),
    feedback: track('brain_feedback', services.feedback),
    projectEnsure: track('brain_project_ensure', services.projectEnsure),
    status: track('brain_status', services.status)
  };
}

export async function startLegacyHttpHarness(options: HttpHarnessOptions = {}): Promise<HttpHarness> {
  const root = await mkdtemp(join(tmpdir(), 'brain-http-'));
  const vaultRoot = join(root, 'vault');
  const stateDir = join(root, 'state');
  await mkdir(vaultRoot, { recursive: true });
  for (const scope of scopeFixtures) {
    await mkdir(join(vaultRoot, scope.relative_root), { recursive: true });
  }
  await mkdir(stateDir, { recursive: true });

  const tokens = {
    worker: newToken(),
    rotated: newToken(),
    reviewer: newToken(),
    owner: newToken()
  };
  const credentialsFile = join(root, 'credentials.json');
  const cursorSecretFile = join(root, 'cursor.key');
  await writeFile(cursorSecretFile, randomBytes(48));

  const config: BrainConfig = {
    endpoint: 'http://127.0.0.1:7331/mcp',
    backend_endpoint: 'http://127.0.0.1:1/mcp',
    port: 0,
    mounts: { vault: vaultRoot, state: stateDir },
    cursor_secret_file: cursorSecretFile,
    scopes: scopeFixtures.map((scope) => ({ ...scope })),
    limits: {
      input_body_max_bytes: INPUT_BODY_MAX_BYTES,
      rendered_note_max_bytes: RENDERED_NOTE_MAX_BYTES,
      tool_result_max_bytes: TOOL_RESULT_MAX_BYTES,
      backend_timeout_ms: BACKEND_TIMEOUT_MS,
      materialization_timeout_ms: MATERIALIZATION_TIMEOUT_MS,
      reconcile_interval_ms: options.reconcile_interval_ms ?? RECONCILE_INTERVAL_MS,
      concurrent_reads: options.concurrent_reads ?? CONCURRENT_READS,
      project_provision_global_per_minute: PROJECT_PROVISION_GLOBAL_PER_MINUTE,
      dynamic_projects_max: DYNAMIC_PROJECTS_MAX
    },
    allowed_hosts: options.allowed_hosts ?? ['127.0.0.1', 'localhost'],
    allowed_origins: options.allowed_origins ?? [],
    result_delivery: options.result_delivery ?? 'structured'
  };

  const backend = createLegacyBackend({
    root: vaultRoot,
    projects: scopeFixtures.map((scope) => scope.backend_project)
  });
  const calls: RecordedToolCall[] = [];
  const diagnostics: string[] = [];

  let runtime: BrainRuntime;
  try {
    runtime = await createRuntime(config, {
      backend,
      ...(options.vault === undefined ? {} : { vault: options.vault }),
      token_digest: options.token_digest ?? tokenDigest(tokens.worker),
      logger: (line) => {
        diagnostics.push(line);
      },
      wrapServices: (services) => recordingServices(services, calls)
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    url: runtime.url,
    origin: `http://127.0.0.1:${runtime.port}`,
    port: runtime.port,
    token: tokens.worker,
    rotatedToken: tokens.rotated,
    reviewerToken: tokens.worker,
    ownerToken: tokens.worker,
    credentialsFile,
    config,
    runtime,
    backend,
    recordedToolCalls: () => calls.map((call) => ({ ...call })),
    auditedEvents: () => runtime.deps!.journal.listAudit(),
    loggedDiagnostics: () => [...diagnostics],
    connect: async (token: string, name = 'brain-http-test') => {
      const client = new Client({ name, version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(runtime.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }
        })
      );
      return client;
    },
    close: async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export interface LocalHttpHarness {
  url: string;
  origin: string;
  port: number;
  token: string;
  config: BrainConfig;
  runtime: BrainRuntime;
  connect(token: string, name?: string): Promise<Client>;
  close(): Promise<void>;
}

export interface LocalHttpHarnessOptions {
  token?: string;
  result_delivery?: ResultDelivery;
  allowed_hosts?: string[];
  allowed_origins?: string[];
  concurrent_reads?: number;
  reconcile_interval_ms?: number;
  worker?: RerankWorker;
}

export async function startLocalHttpHarness(
  options: LocalHttpHarnessOptions = {}
): Promise<LocalHttpHarness> {
  const root = await mkdtemp(join(tmpdir(), 'brain-local-http-'));
  const vaultRoot = join(root, 'vault');
  const stateDir = join(root, 'state');
  await mkdir(vaultRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  for (const scope of scopeFixtures) {
    await mkdir(join(vaultRoot, scope.relative_root), { recursive: true });
  }
  const token = options.token ?? newToken();
  const cursorSecretFile = join(root, 'cursor.key');
  await writeFile(cursorSecretFile, randomBytes(48));
  const config: BrainConfig = {
    endpoint: 'http://127.0.0.1:7331/mcp',
    backend_endpoint: 'http://127.0.0.1:1/mcp',
    port: 0,
    mounts: { vault: vaultRoot, state: stateDir },
    cursor_secret_file: cursorSecretFile,
    scopes: scopeFixtures.map((scope) => ({ ...scope })),
    limits: {
      input_body_max_bytes: INPUT_BODY_MAX_BYTES,
      rendered_note_max_bytes: RENDERED_NOTE_MAX_BYTES,
      tool_result_max_bytes: TOOL_RESULT_MAX_BYTES,
      backend_timeout_ms: BACKEND_TIMEOUT_MS,
      materialization_timeout_ms: MATERIALIZATION_TIMEOUT_MS,
      reconcile_interval_ms: options.reconcile_interval_ms ?? RECONCILE_INTERVAL_MS,
      concurrent_reads: options.concurrent_reads ?? CONCURRENT_READS,
      project_provision_global_per_minute: PROJECT_PROVISION_GLOBAL_PER_MINUTE,
      dynamic_projects_max: DYNAMIC_PROJECTS_MAX
    },
    allowed_hosts: options.allowed_hosts ?? ['127.0.0.1', 'localhost'],
    allowed_origins: options.allowed_origins ?? [],
    result_delivery: options.result_delivery ?? 'structured'
  };
  const runtime = await createRuntime(config, {
    token_digest: tokenDigest(token),
    logger: () => undefined,
    ...(options.worker === undefined ? {} : { local: { worker: options.worker } })
  });
  return {
    url: runtime.url,
    origin: `http://127.0.0.1:${runtime.port}`,
    port: runtime.port,
    token,
    config,
    runtime,
    connect: async (value: string, name = 'brain-local-http-test') => {
      const client = new Client({ name, version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(runtime.url), {
          requestInit: { headers: { Authorization: `Bearer ${value}` } }
        })
      );
      return client;
    },
    close: async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

const DOCKER_REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCKER_WORK_ROOT = '/tmp/opencode';
const DOCKER_SUITE_TIMEOUT_MS = 2_400_000;
const DOCKER_PRINCIPAL_IDS = ['owner', 'project-worker', 'project-reviewer'] as const;
const DOCKER_FORBIDDEN_QUERY = 'private project marker';

const DOCKER_COPY_ITEMS = [
  'Dockerfile',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'compose.yaml',
  '.env.example',
  'src',
  'scripts',
  'config'
] as const;

export interface DockerToolResponse {
  isError: boolean;
  structured: unknown;
  text: string | undefined;
  error?: { code?: number; message: string };
}

export interface DockerFixtureReceipt {
  id: string;
  revision_id: string;
  etag?: string;
  warnings: string[];
}

export interface DockerProjectState {
  projects: Array<{ repository_identity: string; scope: string; state: string }>;
  grants: Array<{ principal_id: string; scope: string; can_read: number; can_write: number; can_review: number }>;
}

export interface DockerHarness {
  workDir: string;
  project: string;
  port: number;
  url: string;
  vaultPath: string;
  principalIds: readonly string[];
  timeoutMs: number;
  callAs(principalId: string, tool: string, args: unknown): Promise<DockerToolResponse>;
  ensureAs(principalId: string, remoteUrl: string, idempotencyKey?: string): Promise<DockerToolResponse>;
  projectState(): DockerProjectState;
  connect(principalId: string, name?: string): Promise<Client>;
  listToolsAs(principalId: string): Promise<string[]>;
  captureAs(
    principalId: string,
    scope: string,
    note: unknown,
    idempotencyKey?: string
  ): Promise<DockerToolResponse>;
  approveAs(
    principalId: string,
    scope: string,
    id: string,
    expectedEtag: string,
    rationale: string
  ): Promise<DockerToolResponse>;
  recallAs(
    principalId: string,
    scope: string,
    query: string,
    extra?: Record<string, unknown>
  ): Promise<DockerToolResponse>;
  seedNote(principalId: string, scope: string, note: unknown): Promise<DockerFixtureReceipt>;
  seedForbiddenMarker(marker: string): Promise<DockerFixtureReceipt>;
  vaultFiles(relativeDir?: string): Promise<string[]>;
  readVaultFile(relativePath: string): Promise<string>;
  writeVaultFile(relativePath: string, content: string): Promise<void>;
  symlinkInVault(linkRelativePath: string, target: string): Promise<void>;
  compose(
    args: string[],
    allowFailure?: boolean
  ): { status: number | null; stdout: string; stderr: string };
  docker(
    args: string[],
    allowFailure?: boolean
  ): { status: number | null; stdout: string; stderr: string };
  restartBrain(): Promise<void>;
  waitForHealth(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function dockerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function dockerFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not allocate a free port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function normalizeDockerToolResult(result: unknown): DockerToolResponse {
  const record =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { type?: unknown }).type === 'text' &&
        typeof (entry as { text?: unknown }).text === 'string'
    )
    .map((entry) => (entry as { text: string }).text)
    .join('\n');
  return {
    isError: record.isError === true,
    structured: record.structuredContent,
    text: text.length > 0 ? text : undefined
  };
}

function structuredReceipt(response: DockerToolResponse): DockerFixtureReceipt | undefined {
  const structured = response.structured;
  if (typeof structured !== 'object' || structured === null) return undefined;
  const record = structured as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.revision_id !== 'string') return undefined;
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    id: record.id,
    revision_id: record.revision_id,
    ...(typeof record.etag === 'string' ? { etag: record.etag } : {}),
    warnings
  };
}

function readImagesEnv(): { node: string; memory: string } {
  const text = readFileSync(join(DOCKER_REPO_ROOT, 'config/images.env'), 'utf8');
  let node = '';
  let memory = '';
  for (const line of text.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key === 'NODE_IMAGE') node = rest.join('=');
    if (key === 'BASIC_MEMORY_IMAGE') memory = rest.join('=');
  }
  if (!node.includes('@sha256:') || !memory.includes('@sha256:')) {
    throw new Error('config/images.env does not contain digest-pinned images');
  }
  return { node, memory };
}

export async function startDockerHarness(): Promise<DockerHarness> {
  if (process.env.BRAIN_SKIP_DOCKER_E2E === '1') {
    throw new Error('BRAIN_SKIP_DOCKER_E2E is set; the Docker e2e suite must run as an explicit job');
  }
  const images = readImagesEnv();
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8'
  });
  if (probe.status !== 0) {
    throw new Error(`Docker is unavailable: ${probe.stdout ?? ''}${probe.stderr ?? ''}`);
  }

  const workDir = mkdtempSync(join(DOCKER_WORK_ROOT, 'brain-docker-'));
  const project = `braindocker${process.pid}${Math.floor(Math.random() * 1000)}`;
  const port = await dockerFreePort();
  const vaultPath = join(workDir, 'docker-vault');
  const modelCacheSeed = process.env.BRAIN_E2E_MODEL_CACHE;

  const runDocker = (
    args: string[],
    allowFailure = false
  ): { status: number | null; stdout: string; stderr: string } => {
    const options: SpawnSyncOptions = {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      cwd: workDir,
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: project,
        NODE_IMAGE: images.node,
        BASIC_MEMORY_IMAGE: images.memory,
        VAULT_PATH: vaultPath,
        BRAIN_PORT: String(port),
        BRAIN_UID: '1000',
        BRAIN_GID: '1000'
      }
    };
    const result = spawnSync('docker', args, options);
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0 && !allowFailure) {
      throw new Error(`docker ${args.join(' ')} exited ${String(result.status)}\n${stdout}\n${stderr}`);
    }
    return { status: result.status, stdout, stderr };
  };

  const compose = (args: string[], allowFailure = false) =>
    runDocker(['compose', '-p', project, '-f', 'compose.yaml', ...args], allowFailure);

  const principalNames = [...DOCKER_PRINCIPAL_IDS] as string[];
  const tokens = new Map<string, string>();
  const credentials = principalNames.map((name) => {
    const token = newToken();
    tokens.set(name, token);
    const scopes = ['shared', 'profile'];
    const principal =
      name === 'owner'
        ? {
            id: randomUUID(),
            role: 'owner' as const,
            read_scopes: [...scopes],
            write_scopes: [...scopes],
            review_scopes: [...scopes]
          }
        : name === 'project-worker'
          ? {
              id: randomUUID(),
              role: 'worker' as const,
              read_scopes: ['shared'],
              write_scopes: [] as string[],
              review_scopes: [] as string[]
            }
          : {
              id: randomUUID(),
              role: 'reviewer' as const,
              read_scopes: ['shared'],
              write_scopes: [] as string[],
              review_scopes: [] as string[]
            };
    return { token_sha256: tokenDigest(token), principal };
  });

  const tokenFor = (principalId: string): string => {
    const token = tokens.get(principalId);
    if (token === undefined) {
      throw new Error(`unknown docker principal: ${principalId}`);
    }
    return token;
  };

  let closed = false;

  const connectAs = async (
    principalId: string,
    name = 'second-brain-docker-client'
  ): Promise<Client> => {
    const token = tokenFor(principalId);
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    return client;
  };

  const callAs = async (
    principalId: string,
    tool: string,
    args: unknown
  ): Promise<DockerToolResponse> => {
    const token = tokenFor(principalId);
    const client = new Client({ name: 'second-brain-docker-e2e', version: '1.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }
        })
      );
    } catch (error) {
      await client.close().catch(() => undefined);
      return {
        isError: true,
        structured: undefined,
        text: undefined,
        error: { message: error instanceof Error ? error.message : String(error) }
      };
    }
    try {
      const result = await client.callTool({
        name: tool,
        arguments: (args ?? {}) as Record<string, unknown>
      });
      return normalizeDockerToolResult(result);
    } catch (error) {
      return {
        isError: true,
        structured: undefined,
        text: undefined,
        error: {
          ...(typeof (error as { code?: unknown }).code === 'number'
            ? { code: (error as { code: number }).code }
            : {}),
          message: error instanceof Error ? error.message : String(error)
        }
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  const recallAs = (
    principalId: string,
    scope: string,
    query: string,
    extra: Record<string, unknown> = {}
  ): Promise<DockerToolResponse> =>
    callAs(principalId, 'brain_recall', { scope, query, ...extra });

  const ensureAs = (
    principalId: string,
    remoteUrl: string,
    idempotencyKey = randomUUID()
  ): Promise<DockerToolResponse> =>
    callAs(principalId, 'brain_project_ensure', {
      idempotency_key: idempotencyKey,
      remote_url: remoteUrl
    });

  const statusOperation = async (
    principalId: string,
    operationId: string
  ): Promise<DockerToolResponse> =>
    callAs(principalId, 'brain_status', { operation_id: operationId });

  const resolveReceipt = async (
    principalId: string,
    response: DockerToolResponse
  ): Promise<DockerFixtureReceipt> => {
    if (response.isError) {
      throw new Error(`capture failed: ${JSON.stringify(response)}`);
    }
    const receipt = structuredReceipt(response);
    if (receipt === undefined) {
      throw new Error(`capture did not return a receipt: ${JSON.stringify(response.structured)}`);
    }
    if (receipt.etag !== undefined) return receipt;
    const structured = response.structured as { operation_id?: unknown };
    const operationId =
      typeof structured.operation_id === 'string' ? structured.operation_id : undefined;
    if (operationId === undefined) return receipt;
    const deadline = Date.now() + 60_000;
    let etag: string | undefined = receipt.etag;
    while (Date.now() < deadline && etag === undefined) {
      const status = await statusOperation(principalId, operationId);
      const operation = (status.structured as { operation?: { etag?: unknown } } | undefined)
        ?.operation;
      if (typeof operation?.etag === 'string') etag = operation.etag;
      else await dockerSleep(1_000);
    }
    return { ...receipt, ...(etag === undefined ? {} : { etag }) };
  };

  const captureAs = (
    principalId: string,
    scope: string,
    note: unknown,
    idempotencyKey?: string
  ): Promise<DockerToolResponse> =>
    callAs(principalId, 'brain_capture', {
      idempotency_key: idempotencyKey ?? randomUUID(),
      scope,
      note
    });

  const approveAs = (
    principalId: string,
    scope: string,
    id: string,
    expectedEtag: string,
    rationale: string
  ): Promise<DockerToolResponse> =>
    callAs(principalId, 'brain_review', {
      scope,
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id,
        expected_etag: expectedEtag,
        rationale
      }
    });

  const seedNote = async (
    principalId: string,
    scope: string,
    note: unknown
  ): Promise<DockerFixtureReceipt> => resolveReceipt(principalId, await captureAs(principalId, scope, note));

  const seedForbiddenMarker = async (marker: string): Promise<DockerFixtureReceipt> => {
    const note = {
      title: `Private project marker ${marker}`,
      tags: ['synthetic', 'profile-marker'],
      content: {
        kind: 'note',
        summary: `Private project marker ${marker}`,
        body_markdown: `This owner-only profile note is a private project marker: ${marker}.`
      },
      evidence: [],
      related_ids: []
    };
    const receipt = await seedNote('owner', 'profile', note);
    if (receipt.etag === undefined) {
      throw new Error('the forbidden marker fixture did not expose an etag for approval');
    }
    const approved = await approveAs(
      'owner',
      'profile',
      receipt.id,
      receipt.etag,
      'synthetic forbidden-marker fixture approval'
    );
    if (approved.isError) {
      throw new Error(`the forbidden marker fixture could not be approved: ${JSON.stringify(approved)}`);
    }
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      const recalled = await recallAs('owner', 'profile', DOCKER_FORBIDDEN_QUERY);
      ready = !recalled.isError && JSON.stringify(recalled.structured).includes(marker);
      if (!ready) await dockerSleep(2_000);
    }
    if (!ready) {
      throw new Error('the forbidden marker fixture never became recallable by its owner');
    }
    return receipt;
  };

  const vaultFiles = async (relativeDir = ''): Promise<string[]> => {
    const base = relativeDir.length === 0 ? vaultPath : join(vaultPath, relativeDir);
    const found: string[] = [];
    const walk = (directory: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else found.push(relative(vaultPath, absolute).split(sep).join('/'));
      }
    };
    walk(base);
    return found.sort();
  };

  const waitForHealth = async (timeoutMs = 900_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const result = compose(
        ['exec', '-T', 'brain', 'node', 'dist/cli.js', 'health'],
        true
      );
      if (result.status === 0) return;
      last = `${result.stdout}${result.stderr}`;
      await dockerSleep(5_000);
    }
    throw new Error(`the Docker gateway never reported healthy: ${last}`);
  };

  try {
    for (const item of DOCKER_COPY_ITEMS) {
      cpSync(join(DOCKER_REPO_ROOT, item), join(workDir, item), { recursive: true });
    }
    rmSync(join(workDir, 'config', 'brain.yaml'), { force: true });
    if (existsSync(join(workDir, 'config', 'brain.yaml'))) {
      throw new Error('the Docker fixture copied operator-generated config/brain.yaml');
    }

    const setup = spawnSync('bash', ['scripts/setup.sh'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      cwd: workDir,
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: project,
        NODE_IMAGE: images.node,
        BASIC_MEMORY_IMAGE: images.memory,
        VAULT_PATH: vaultPath,
        BRAIN_PORT: String(port),
        BRAIN_UID: '1000',
        BRAIN_GID: '1000',
        BRAIN_SETUP_OWNER_CREDENTIAL: '1'
      }
    });
    if (setup.status !== 0) {
      throw new Error(`setup.sh failed: ${setup.stdout ?? ''}${setup.stderr ?? ''}`);
    }

    writeFileSync(
      join(workDir, 'secrets', 'credentials.json'),
      `${JSON.stringify({ credentials }, null, 2)}\n`,
      'utf8'
    );
    writeFileSync(join(workDir, 'secrets', 'brain-token'), `${tokenFor('owner')}\n`, 'utf8');
    runDocker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '-v',
      `${join(workDir, 'secrets')}:/secrets`,
      images.node,
      'sh',
      '-c',
      'chown -R 1000:1000 /secrets && chmod 700 /secrets && chmod 600 /secrets/*'
    ]);

    if (modelCacheSeed !== undefined && modelCacheSeed.length > 0 && existsSync(modelCacheSeed)) {
      runDocker([
        'run',
        '--rm',
        '--user',
        '0:0',
        '-v',
        `${project}_model-cache:/cache`,
        '-v',
        `${modelCacheSeed}:/seed:ro`,
        images.node,
        'sh',
        '-c',
        'cp -a /seed/. /cache/ 2>/dev/null || true; chown -R 1000:1000 /cache'
      ]);
    }

    compose(['up', '-d', '--build']);
    await waitForHealth();
    for (const principalId of ['project-worker', 'project-reviewer', 'owner']) {
      const ensured = await ensureAs(principalId, 'https://github.com/example/freellmapi.git');
      if (ensured.isError || (ensured.structured as { scope?: unknown } | undefined)?.scope !== 'freellmapi') {
        throw new Error(`automatic project setup failed for ${principalId}: ${JSON.stringify(ensured)}`);
      }
    }
  } catch (error) {
    try {
      compose(['down', '-v', '--remove-orphans'], true);
    } catch {
      undefined;
    }
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }

  return {
    workDir,
    project,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    vaultPath,
    principalIds: principalNames,
    timeoutMs: DOCKER_SUITE_TIMEOUT_MS,
    callAs,
    ensureAs,
    projectState(): DockerProjectState {
      const script = [
        "const fs=require('node:fs')",
        "fs.mkdirSync('/tmp/journal-copy',{recursive:true})",
        "for(const name of ['journal.db','journal.db-wal','journal.db-shm']){const source='/state/'+name;if(fs.existsSync(source))fs.copyFileSync(source,'/tmp/journal-copy/'+name)}",
        "const Database=require('/app/node_modules/better-sqlite3')",
        "const db=new Database('/tmp/journal-copy/journal.db',{readonly:true})",
        "const projects=db.prepare('SELECT repository_identity,scope,state FROM repository_projects ORDER BY scope').all()",
        "const grants=db.prepare('SELECT principal_id,scope,can_read,can_write,can_review FROM dynamic_project_grants ORDER BY scope,principal_id').all()",
        "process.stdout.write(JSON.stringify({projects,grants}))"
      ].join(';');
      const result = runDocker([
        'run', '--rm', '--user', '0:0', '-v', `${project}_brain-state:/state:ro`,
        '--entrypoint', 'node', 'second-brain:local', '-e', script
      ]);
      return JSON.parse(result.stdout) as DockerProjectState;
    },
    connect: (principalId, name) => connectAs(principalId, name),
    async listToolsAs(principalId: string): Promise<string[]> {
      const client = await connectAs(principalId, 'second-brain-docker-tools');
      try {
        const listed = await client.listTools();
        return listed.tools.map((tool) => tool.name);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    captureAs,
    approveAs,
    recallAs,
    seedNote,
    seedForbiddenMarker,
    vaultFiles,
    async readVaultFile(relativePath: string): Promise<string> {
      return readFile(join(vaultPath, relativePath), 'utf8');
    },
    async writeVaultFile(relativePath: string, content: string): Promise<void> {
      writeFileSync(join(vaultPath, relativePath), content, 'utf8');
    },
    async symlinkInVault(linkRelativePath: string, target: string): Promise<void> {
      const absolute = join(vaultPath, linkRelativePath);
      await mkdir(dirname(absolute), { recursive: true });
      symlinkSync(target, absolute);
    },
    compose,
    docker: runDocker,
    async restartBrain(): Promise<void> {
      compose(['restart', 'brain']);
      await waitForHealth();
    },
    waitForHealth,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (modelCacheSeed !== undefined && modelCacheSeed.length > 0) {
        try {
          mkdirSync(modelCacheSeed, { recursive: true });
          runDocker(
            [
              'run',
              '--rm',
              '--user',
              '0:0',
              '-v',
              `${project}_model-cache:/cache`,
              '-v',
              `${modelCacheSeed}:/seed`,
              images.node,
              'sh',
              '-c',
              'cp -a /cache/. /seed/ 2>/dev/null || true'
            ],
            true
          );
        } catch {
          undefined;
        }
      }
      try {
        compose(['down', '-v', '--remove-orphans'], true);
      } catch {
        undefined;
      }
      for (const name of ['brain-state', 'memory-state', 'model-cache']) {
        spawnSync('docker', ['volume', 'rm', '-f', `${project}_${name}`], { encoding: 'utf8' });
      }
      spawnSync('docker', ['image', 'rm', '-f', `${project}-brain`], { encoding: 'utf8' });
      rmSync(workDir, { recursive: true, force: true });
    }
  };
}
