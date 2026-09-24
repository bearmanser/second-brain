import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { assertTokenDigest } from './config/load.js';
import type { BrainConfig } from './config/schema.js';
import { BrainError, isBrainError } from './contracts/errors.js';
import type {
  AuthenticatedContext,
  BackendPort,
  CataloguePort,
  Clock,
  IdSource,
  MutationReceipt,
  ProjectEnsureResult,
  ReadResult,
  RecallResult,
  StatusResult,
  VaultPort
} from './core/types.js';
import { RECONCILE_INTERVAL_MS } from './core/limits.js';
import { capture } from './features/capture.js';
import { feedback, retrievalEventFromRecall } from './features/feedback.js';
import { ensureProject } from './features/project-ensure.js';
import { read } from './features/read.js';
import { recallTraced } from './features/recall.js';
import { review } from './features/review.js';
import { status } from './features/status.js';
import { createHttpApp } from './mcp/http.js';
import { createMcpServer, type BrainServices } from './mcp/server.js';
import { internalDiagnostic } from './mcp/tools.js';
import { RevisionCatalogue } from './notes/catalogue.js';
import {
  CurrentCatalogue,
  observeCurrentVault,
  reconcileCurrentVault,
  type CurrentVault,
  type CurrentVaultObserver,
  type ReconcileCurrentVaultReport
} from './notes/current-catalogue.js';
import { JournalApprovalProvenance, indexReconciledDocuments, reconcileVault } from './notes/reconcile.js';
import { recoverPending } from './operations/recovery.js';
import { ScopeRegistry } from './projects/scope-registry.js';
import { BasicMemoryBackend } from './storage/basic-memory.js';
import { Journal, LocalOperationJournal } from './storage/journal.js';
import { openRevisionStore, type RevisionStore } from './storage/revision-store.js';
import { openSearchIndex, type SearchIndex } from './storage/search-index.js';
import { FileVault } from './storage/vault.js';
import { openDocumentStore, type DocumentIndex } from './storage/document-store.js';
import type { RerankWorker } from './retrieval/reranker.js';
import {
  localCapture,
  localFeedback,
  localProjectEnsure,
  localRead,
  localRecall,
  localReview,
  localStatus,
  type LocalBrain
} from './features/local-brain.js';
import { InstanceLock, MutationCoordinator, type BrainDeps } from './core/mutation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export const MIN_CURSOR_SECRET_BYTES = 32;
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const SHUTDOWN_DRAIN_MS = 500;

export interface RuntimeOptions {
  backend?: BackendPort;
  vault?: VaultPort;
  clock?: Clock;
  ids?: IdSource;
  logger?: (line: string) => void;
  wrapServices?: (services: BrainServices, deps: BrainDeps) => BrainServices;
  token_digest: string;
  local?: { worker?: RerankWorker };
}

export interface BrainRuntime {
  readonly config: BrainConfig;
  readonly deps: BrainDeps;
  readonly services: BrainServices;
  readonly tokenDigest: string;
  readonly port: number;
  readonly url: string;
  readonly ready: boolean;
  readonly closing: boolean;
  readonly closed: boolean;
  readonly shutdownPending: boolean;
  readonly shutdownSignal: AbortSignal;
  readonly currentCatalogue: CurrentCatalogue | undefined;
  trackOperation<T>(work: Promise<T>): Promise<T>;
  rotateTokenDigest(digest: string): void;
  dispatch(
    ctx: AuthenticatedContext,
    req: Request,
    res: Response,
    parsedBody: unknown
  ): Promise<void>;
  close(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdSource = { next: () => randomUUID() };

const silentLogger = (): void => undefined;

class LocalOnlyBackend implements BackendPort {
  async connect(): Promise<void> {
    return;
  }

  async probe(): Promise<{ server_version: string; tools: string[] }> {
    return { server_version: 'local', tools: [] };
  }

  registerScope(): void {
    return;
  }

  async verifyProject(): Promise<boolean> {
    return true;
  }

  async ensureProject(): Promise<{ created: boolean }> {
    return { created: false };
  }

  async create(): Promise<{ permalink: string; relative_path?: string }> {
    throw new BrainError({
      code: 'BACKEND_UNAVAILABLE',
      message: 'the local document store owns writes'
    });
  }

  async search(): Promise<{ hits: never[]; has_more: boolean }> {
    return { hits: [], has_more: false };
  }

  async isIndexed(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    return;
  }
}

function recoveryRequired(message: string, cause?: unknown): BrainError {
  return new BrainError({ code: 'RECOVERY_REQUIRED', message, cause });
}

async function loadCursorSecret(config: BrainConfig): Promise<Uint8Array> {
  const path = config.cursor_secret_file;
  if (path === undefined || path.length === 0) {
    throw recoveryRequired(
      'the read-cursor signing secret is not configured; set cursor_secret_file'
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw recoveryRequired('the read-cursor signing secret cannot be read', cause);
  }
  if (bytes.length < MIN_CURSOR_SECRET_BYTES) {
    throw recoveryRequired(
      `the read-cursor signing secret must be at least ${MIN_CURSOR_SECRET_BYTES} bytes`
    );
  }
  return new Uint8Array(bytes);
}

function buildServices(
  deps: BrainDeps,
  delivery: BrainServices['result_delivery'],
  log: (line: string) => void,
  local?: LocalBrain
): BrainServices {
  if (local !== undefined) {
    return {
      contract_version: 2,
      result_delivery: delivery ?? 'structured',
      reportDiagnostic: log,
      capture: (ctx, request): Promise<MutationReceipt> => localCapture(ctx, request, local),
      review: (ctx, request) => localReview(ctx, request, local),
      read: (ctx, request): Promise<ReadResult> => localRead(ctx, request, local),
      status: (ctx, request): Promise<StatusResult> => localStatus(ctx, request, local),
      feedback: (ctx, request) => localFeedback(ctx, request, local),
      projectEnsure: (ctx, request): Promise<ProjectEnsureResult> =>
        localProjectEnsure(ctx, request, local),
      recall: async (ctx, request): Promise<RecallResult> => {
        const started = Date.now();
        const result = await localRecall(ctx, request, local);
        try {
          deps.journal.recordRetrievalV2(
            retrievalEventFromRecall(ctx, result, {
              filter:
                request.project === undefined && request.scope === undefined
                  ? { mode: 'all' }
                  : { mode: 'project', identifier: (request.project ?? request.scope) as string },
              searched_project_ids: [],
              primary_project_id: null,
              duration_ms: Math.max(0, Date.now() - started)
            })
          );
        } catch (error) {
          log(internalDiagnostic(error));
        }
        return result;
      }
    };
  }
  return {
    contract_version: 1,
    result_delivery: delivery ?? 'structured',
    reportDiagnostic: log,
    capture: (ctx, request): Promise<MutationReceipt> => capture(ctx, request, deps),
    review: (ctx, request) => review(ctx, request, deps),
    read: (ctx, request): Promise<ReadResult> => read(ctx, request, deps),
    status: (ctx, request): Promise<StatusResult> => status(ctx, request, deps),
    feedback: (ctx, request) => feedback(ctx, request, deps),
    projectEnsure: (ctx, request): Promise<ProjectEnsureResult> => ensureProject(ctx, request, deps),
    recall: async (ctx, request): Promise<RecallResult> => {
      const started = Date.now();
      const traced = await recallTraced(ctx, request, deps);
      const result = traced.result;
      try {
        deps.journal.recordRetrievalV2(
          retrievalEventFromRecall(ctx, result, {
            filter: traced.filter,
            searched_project_ids: traced.searched_project_ids,
            primary_project_id: traced.primary_project_id,
            duration_ms: Math.max(0, Date.now() - started)
          })
        );
      } catch (error) {
        log(internalDiagnostic(error));
      }
      return result;
    }
  };
}

function trackedServices(
  services: BrainServices,
  guard: <T>(work: () => Promise<T>) => Promise<T>,
  readGuard: <T>(signal: AbortSignal, work: () => Promise<T>) => Promise<T>
): BrainServices {
  return {
    ...services,
    capture: (ctx, request) => guard(() => services.capture(ctx, request)),
    review: (ctx, request) =>
      request.operation.action === 'list'
        ? readGuard(ctx.signal, () => services.review(ctx, request))
        : guard(() => services.review(ctx, request)),
    recall: (ctx, request) => readGuard(ctx.signal, () => services.recall(ctx, request)),
    read: (ctx, request) => readGuard(ctx.signal, () => services.read(ctx, request)),
    feedback: (ctx, request) => guard(() => services.feedback(ctx, request)),
    projectEnsure: (ctx, request) => guard(() => services.projectEnsure(ctx, request)),
    status: (ctx, request) => readGuard(ctx.signal, () => services.status(ctx, request))
  };
}

class ReadLimiter {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: {
    signal: AbortSignal;
    resolve: () => void;
    reject: (error: BrainError) => void;
    abort: () => void;
  }[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal.aborted) throw new BrainError({ code: 'CANCELLED', message: 'the read was cancelled' });
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new BrainError({ code: 'CANCELLED', message: 'the read was cancelled' }));
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        signal,
        resolve: (): void => {
          signal.removeEventListener('abort', entry.abort);
          this.active += 1;
          resolve();
        },
        reject,
        abort: (): void => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new BrainError({ code: 'CANCELLED', message: 'the read was cancelled' }));
        }
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.active < this.limit) {
      const next = this.waiting.shift();
      if (next === undefined) return;
      if (next.signal.aborted) {
        next.abort();
        continue;
      }
      next.resolve();
      return;
    }
  }
}

class BrainRuntimeImpl implements BrainRuntime {
  readonly config: BrainConfig;
  deps!: BrainDeps;
  services!: BrainServices;
  tokenDigest = '';
  port = 0;
  url = '';
  ready = false;
  closing = false;
  closed = false;
  shutdownPending = false;
  private readonly options: RuntimeOptions;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly log: (line: string) => void;
  private readonly shutdown = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private drainResolvers: (() => void)[] = [];
  private closePromise: Promise<void> | undefined;
  private cleaned = false;
  private lock: InstanceLock | undefined;
  private journal: Journal | undefined;
  private catalogue: RevisionCatalogue | undefined;
  private backend: BackendPort | undefined;
  private httpServer: HttpServer | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconciling = false;
  private currentIndex: CurrentCatalogue | undefined;
  private currentObserver: CurrentVaultObserver | undefined;
  private searchIndex: SearchIndex | undefined;
  private localBrain: LocalBrain | undefined;
  private readonly readLimiter: ReadLimiter;

  constructor(config: BrainConfig, options: RuntimeOptions) {
    this.config = config;
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? systemIds;
    this.log = options.logger ?? silentLogger;
    this.readLimiter = new ReadLimiter(config.limits.concurrent_reads);
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdown.signal;
  }

  get currentCatalogue(): CurrentCatalogue | undefined {
    return this.currentIndex;
  }

  async start(): Promise<void> {
    this.tokenDigest = assertTokenDigest(this.options.token_digest);
    await mkdir(this.config.mounts.state, { recursive: true });
    const lock = InstanceLock.acquire(this.config.mounts.state);
    this.lock = lock;
    let started = false;
    try {
      const vault: VaultPort =
        this.options.vault ?? new FileVault(this.config.mounts.vault, this.config.scopes);
      const journalPath = join(this.config.mounts.state, 'journal.db');
      const cataloguePath = join(this.config.mounts.state, 'catalogue.db');
      const knowledgeExists = await this.knowledgeExists(vault, cataloguePath);
      if (!existsSync(journalPath) && knowledgeExists) {
        throw recoveryRequired(
          'the operation journal is missing while managed knowledge exists; explicit recovery is required'
        );
      }
      const journal = Journal.open(journalPath, {
        clock: this.clock,
        ids: this.ids
      });
      this.journal = journal;
      const scopeRegistry = new ScopeRegistry(this.config.scopes, journal);
      if (knowledgeExists && !journal.hasOperationalHistory()) {
        if (!journal.hasOperationalLossAcknowledgement()) {
          throw recoveryRequired(
            'the operation journal is empty while managed knowledge exists; explicit recovery is required'
          );
        }
      }
      const backend =
        this.options.backend ??
        (this.useLocal()
          ? new LocalOnlyBackend()
          : new BasicMemoryBackend({
              url: this.config.backend_endpoint,
              projects: scopeRegistry.all().map((scope) => scope.backend_project),
              timeout_ms: this.config.limits.backend_timeout_ms
            }));
      this.backend = backend;
      await backend.connect();
      for (const scope of scopeRegistry.all()) backend.registerScope(scope);
      for (const project of journal.listReadyProjects()) {
        const binding = journal.getProjectBinding(project.project.id);
        if (binding === undefined) {
          journal.markProjectRecoveryRequired(
            project.project.id,
            'startup_verification',
            'MISSING_BINDING'
          );
          continue;
        }
        const scope = {
          id: project.project.id,
          backend_project: binding.backend_project,
          relative_root: project.project.relative_root,
          repository_aliases: []
        };
        try {
          vault.registerScope(scope);
          const verified = await backend.verifyProject(
            binding.backend_project,
            `/app/data/${binding.backend_relative_root}`
          );
          if (!verified) {
            throw new BrainError({
              code: 'BACKEND_PROTOCOL_ERROR',
              message: 'ready repository project is missing from the backend'
            });
          }
          backend.registerScope(scope);
          scopeRegistry.registerReadyProject(project, binding);
        } catch (error) {
          if (
            isBrainError(error) &&
            ['RECOVERY_REQUIRED', 'FORBIDDEN', 'CONFLICT', 'BACKEND_PROTOCOL_ERROR'].includes(error.code)
          ) {
            journal.markProjectRecoveryRequired(
              project.project.id,
              'startup_verification',
              error.code
            );
            scopeRegistry.quarantineProject(project.project.id);
            continue;
          }
          throw error;
        }
      }
      const catalogue = RevisionCatalogue.open(cataloguePath, {
        vault,
        scopes: scopeRegistry.all(),
        clock: this.clock,
        approval_provenance: new JournalApprovalProvenance(journal)
      });
      this.catalogue = catalogue;
      const mutations = new MutationCoordinator({
        config: this.config,
        scopeRegistry,
        backend,
        vault,
        catalogue,
        journal,
        clock: this.clock,
        ids: this.ids
      });
      const deps: BrainDeps = {
        config: this.config,
        scopeRegistry,
        backend,
        vault,
        catalogue: catalogue as CataloguePort,
        journal,
        clock: this.clock,
        ids: this.ids,
        mutations
      };
      this.deps = deps;

      await recoverPending(deps).then((report) => {
        this.logRecovery(report);
      });
      await this.startupReconcile();
      await this.startCurrentVault();
      await this.openLocalBrain(journal);
      await loadCursorSecret(this.config);

      const base = buildServices(
        deps,
        this.config.result_delivery,
        this.log,
        this.localBrain
      );
      const wrapped = this.options.wrapServices?.(base, deps) ?? base;
      this.services = trackedServices(
        { ...base, ...wrapped },
        (work) => this.guardOperation(work),
        (signal, work) => this.guardOperation(() => this.readLimiter.run(signal, work))
      );

      const app = createHttpApp(this);
      const httpServer = createServer(app);
      this.httpServer = httpServer;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          reject(error);
        };
        httpServer.once('error', onError);
        httpServer.listen(this.config.port, '0.0.0.0', () => {
          httpServer.off('error', onError);
          resolve();
        });
      });
      const address = httpServer.address() as AddressInfo | null;
      this.port = address !== null && typeof address === 'object' ? address.port : this.config.port;
      this.url = `http://127.0.0.1:${this.port}/mcp`;

      this.prune();
      this.pruneTimer = setInterval(() => {
        this.prune();
      }, PRUNE_INTERVAL_MS);
      this.pruneTimer.unref?.();

      const reconcileInterval =
        this.config.limits.reconcile_interval_ms ?? RECONCILE_INTERVAL_MS;
      this.reconcileTimer = setInterval(() => {
        this.periodicReconcile();
      }, reconcileInterval);
      this.reconcileTimer.unref?.();

      this.ready = true;
      started = true;
    } finally {
      if (!started) {
        await this.cleanup();
      }
    }
  }

  private async knowledgeExists(vault: VaultPort, cataloguePath: string): Promise<boolean> {
    if (RevisionCatalogue.hasPersistedRevisions(cataloguePath)) return true;
    for (const scope of this.config.scopes) {
      const paths = await vault.list(scope.id);
      if (paths.length > 0) return true;
    }
    return this.dynamicProjectStorageExists();
  }

  private dynamicProjectStorageExists(): boolean {
    const projectsRoot = join(this.config.mounts.vault, 'Projects');
    if (!existsSync(projectsRoot)) return false;
    const configured = new Set(
      this.config.scopes
        .map((scope) => scope.relative_root.split('/'))
        .filter((segments) => segments.length === 2 && segments[0] === 'Projects')
        .map((segments) => segments[1])
    );
    try {
      return readdirSync(projectsRoot, { withFileTypes: true }).some(
        (entry) => !configured.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())
      );
    } catch (cause) {
      throw recoveryRequired('dynamic project storage cannot be inspected', cause);
    }
  }

  trackOperation<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<T> = work.finally(() => {
      this.settle(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }

  private guardOperation<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(
        new BrainError({ code: 'CANCELLED', message: 'the gateway is shutting down' })
      );
    }
    return this.trackOperation(work());
  }

  private settle(tracked: Promise<unknown>): void {
    this.inFlight.delete(tracked);
    if (this.inFlight.size > 0) return;
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private waitForDrain(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      this.drainResolvers.push(() => done(true));
      if (Number.isFinite(timeoutMs)) {
        const timer = setTimeout(() => done(false), timeoutMs);
        timer.unref?.();
      }
    });
  }

  rotateTokenDigest(digest: string): void {
    this.tokenDigest = assertTokenDigest(digest);
  }

  async dispatch(
    ctx: AuthenticatedContext,
    req: Request,
    res: Response,
    parsedBody: unknown
  ): Promise<void> {
    const server = createMcpServer(this.services, ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    res.on('close', () => {
      void cleanup();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      this.services.reportDiagnostic?.(internalDiagnostic(error));
      if (!res.headersSent) {
        res.status(500).type('application/json').send(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'the gateway could not complete the request' },
            id: null
          })
        );
      } else {
        try {
          res.end();
        } catch {}
      }
      await cleanup();
    }
  }

  private prune(): void {
    const journal = this.journal;
    if (journal === undefined) return;
    try {
      const now = this.clock.now();
      journal.pruneRetrievalEvents(now);
      journal.pruneAuditEvents(now);
      journal.pruneTerminalPayloads(now);
      journal.pruneReadCursors(now);
    } catch (error) {
      this.log(internalDiagnostic(error));
    }
  }

  private async startupReconcile(): Promise<void> {
    const report = await this.deps.mutations.serialize(() => reconcileVault(this.deps));
    this.logReconcile(report);
  }

  private async startCurrentVault(): Promise<void> {
    const vault = this.deps.vault as VaultPort & Partial<CurrentVault>;
    if (typeof vault.listMarkdown !== 'function' || typeof vault.readMarkdown !== 'function') {
      return;
    }
    let revisions: RevisionStore;
    try {
      revisions = await openRevisionStore(this.config.mounts.state);
    } catch (error) {
      this.log(internalDiagnostic(error));
      return;
    }
    const current = CurrentCatalogue.open({ revisions, ids: this.ids });
    this.currentIndex = current;
    let index: SearchIndex | undefined;
    try {
      const indexPath = join(this.config.mounts.state, 'index', 'search.sqlite');
      mkdirSync(dirname(indexPath), { recursive: true });
      index = openSearchIndex(indexPath);
      this.searchIndex = index;
    } catch (error) {
      this.log(internalDiagnostic(error));
    }
    const syncIndex = (report: ReconcileCurrentVaultReport): void => {
      if (index === undefined) return;
      try {
        indexReconciledDocuments({ catalogue: current, index, report });
      } catch (error) {
        this.log(internalDiagnostic(error));
      }
    };
    const observer = observeCurrentVault({
      root: this.config.mounts.vault,
      vault: vault as CurrentVault,
      catalogue: current,
      signal: this.shutdown.signal,
      interval_ms: this.config.limits.reconcile_interval_ms ?? RECONCILE_INTERVAL_MS,
      onReconcile: (report) => {
        syncIndex(report);
        this.logCurrentReconcile(report);
      },
      onError: (error) => this.log(internalDiagnostic(error))
    });
    this.currentObserver = observer;
    try {
      const report = await reconcileCurrentVault({
        vault: vault as CurrentVault,
        catalogue: current,
        signal: this.shutdown.signal
      });
      syncIndex(report);
      this.logCurrentReconcile(report);
    } catch (error) {
      if (!(isBrainError(error) && error.code === 'CANCELLED')) {
        this.log(internalDiagnostic(error));
      }
    }
  }

  private useLocal(): boolean {
    return this.options.local !== undefined || this.options.backend === undefined;
  }

  private async openLocalBrain(journal: Journal): Promise<void> {
    if (!this.useLocal()) return;
    const catalogue = this.currentIndex;
    const index = this.searchIndex;
    const vault = this.deps.vault as VaultPort & CurrentVault;
    if (
      catalogue === undefined ||
      index === undefined ||
      typeof vault.listMarkdown !== 'function' ||
      typeof vault.readMarkdown !== 'function'
    ) {
      throw recoveryRequired('the local document store requires a readable vault');
    }
    const documents = await openDocumentStore({
      vault: this.config.mounts.vault,
      state: this.config.mounts.state,
      index: index as unknown as DocumentIndex,
      clock: this.clock,
      ids: this.ids
    });
    const operations = LocalOperationJournal.open(join(this.config.mounts.state, 'operations.sqlite'));
    this.localBrain = {
      config: this.config,
      clock: this.clock,
      ids: this.ids,
      documents,
      operations,
      catalogue,
      index,
      journal,
      vault,
      vaultRoot: this.config.mounts.vault,
      ...(this.options.local?.worker === undefined ? {} : { worker: this.options.local.worker }),
      close: async () => {
        operations.close();
        await documents.close();
      }
    };
  }

  private logCurrentReconcile(report: ReconcileCurrentVaultReport): void {
    this.log(
      `current vault reconcile scanned ${report.scanned} files (${report.complete ? 'complete' : 'partial'}); ` +
        `${report.added.length} added, ${report.changed.length} changed, ` +
        `${report.moved.length} moved, ${report.removed.length} removed, ` +
        `${report.malformed.length} malformed, ${report.duplicate_ids.length} duplicate_ids, ` +
        `${report.identity_conflicts?.length ?? 0} identity_conflicts, ` +
        `${report.unresolved_links.length} unresolved_links`
    );
  }

  private periodicReconcile(): void {
    if (this.reconciling || this.closing) return;
    this.reconciling = true;
    const work = async (): Promise<void> => {
      try {
        const recovery = await recoverPending(this.deps);
        this.logRecovery(recovery);
        const report = await this.deps.mutations.serialize(() => reconcileVault(this.deps));
        this.logReconcile(report);
      } catch (error) {
        this.log(internalDiagnostic(error));
      } finally {
        this.reconciling = false;
      }
    };
    void this.trackOperation(work());
  }

  private logRecovery(report: {
    inspected: number;
    finalized: number;
    conflicted: number;
    failed: number;
    released: number;
    pending: number;
    blocking_operations: string[];
  }): void {
    this.log(
      `recovery inspected ${report.inspected} operations; finalized ${report.finalized}, ` +
        `conflicted ${report.conflicted}, failed ${report.failed}, released ${report.released}, ` +
        `pending ${report.pending}, blocking ${report.blocking_operations.length}`
    );
  }

  private logReconcile(report: {
    scanned: number;
    updated: number;
    unmanaged: number;
    malformed: number;
    conflicted: number;
    manual_unreviewed: number;
    unsupported_schema: number;
    scopes: string[];
  }): void {
    this.log(
      `reconciled ${report.scanned} files in ${report.scopes.length} scopes; ` +
        `${report.updated} updated, ${report.unmanaged} unmanaged, ${report.malformed} malformed, ` +
        `${report.conflicted} conflicted, ${report.manual_unreviewed} manual_unreviewed, ` +
        `${report.unsupported_schema} unsupported_schema`
    );
  }

  private async stopListening(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server === undefined || !server.listening) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
      }, SHUTDOWN_DRAIN_MS);
      timer.unref?.();
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      server.close(() => done());
    });
  }

  private async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    if (this.reconcileTimer !== undefined) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    this.ready = false;
    await this.currentObserver?.close().catch(() => undefined);
    this.currentObserver = undefined;
    await this.localBrain?.close().catch(() => undefined);
    this.localBrain = undefined;
    this.currentIndex?.close();
    this.currentIndex = undefined;
    this.searchIndex?.close();
    this.searchIndex = undefined;
    await this.backend?.close().catch(() => undefined);
    this.backend = undefined;
    this.catalogue?.close();
    this.catalogue = undefined;
    this.journal?.close();
    this.journal = undefined;
    this.lock?.release();
    this.lock = undefined;
  }

  private async performClose(): Promise<void> {
    this.closing = true;
    this.ready = false;
    this.shutdown.abort();
    await this.stopListening();
    const drained = await this.waitForDrain(SHUTDOWN_DRAIN_MS);
    if (!drained) this.shutdownPending = true;
    await this.waitForDrain(Number.POSITIVE_INFINITY);
    await this.cleanup();
    this.shutdownPending = false;
    this.closed = true;
  }

  async close(): Promise<void> {
    if (this.closePromise === undefined) this.closePromise = this.performClose();
    return this.closePromise;
  }
}

export async function createRuntime(
  config: BrainConfig,
  options: RuntimeOptions
): Promise<BrainRuntime> {
  const runtime = new BrainRuntimeImpl(config, options);
  await runtime.start();
  return runtime;
}
