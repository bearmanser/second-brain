import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync, unwatchFile, watchFile, type StatWatcher } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadCredentials } from './config/load.js';
import type { BrainConfig, CredentialRecord } from './config/schema.js';
import { BrainError } from './contracts/errors.js';
import type {
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
import { recall } from './features/recall.js';
import { review } from './features/review.js';
import { status } from './features/status.js';
import { createHttpApp } from './mcp/http.js';
import type { BrainServices } from './mcp/server.js';
import { internalDiagnostic } from './mcp/tools.js';
import { RevisionCatalogue } from './notes/catalogue.js';
import { JournalApprovalProvenance, reconcileVault } from './notes/reconcile.js';
import { recoverPending } from './operations/recovery.js';
import { ScopeRegistry } from './projects/scope-registry.js';
import { resolveScopes } from './security/authorise.js';
import { BasicMemoryBackend } from './storage/basic-memory.js';
import { Journal } from './storage/journal.js';
import { FileVault } from './storage/vault.js';
import { InstanceLock, MutationCoordinator, type BrainDeps } from './core/mutation.js';

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
}

export interface BrainRuntime {
  readonly config: BrainConfig;
  readonly deps: BrainDeps;
  readonly services: BrainServices;
  readonly credentials: CredentialRecord[];
  readonly port: number;
  readonly url: string;
  readonly ready: boolean;
  readonly closing: boolean;
  readonly closed: boolean;
  readonly shutdownPending: boolean;
  readonly shutdownSignal: AbortSignal;
  trackOperation<T>(work: Promise<T>): Promise<T>;
  reloadCredentials(): void;
  close(): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };
const systemIds: IdSource = { next: () => randomUUID() };

const silentLogger = (): void => undefined;

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
  log: (line: string) => void
): BrainServices {
  return {
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
      const result = await recall(ctx, request, deps);
      try {
        const [primary] = resolveScopes(
          ctx.principal,
          request.scope,
          request.include_shared === true,
          'read',
          deps.scopeRegistry
        );
        deps.journal.recordRetrieval(
          retrievalEventFromRecall(ctx, result, {
            scope: primary.id,
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
  credentials: CredentialRecord[] = [];
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
  private credentialsWatcher: StatWatcher | undefined;
  private credentialsListener: (() => void) | undefined;
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

  async start(): Promise<void> {
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
      for (const scope of scopeRegistry.all()) vault.registerScope(scope);
      if (knowledgeExists && !journal.hasOperationalHistory()) {
        if (!journal.hasOperationalLossAcknowledgement()) {
          throw recoveryRequired(
            'the operation journal is empty while managed knowledge exists; explicit recovery is required'
          );
        }
      }
      const catalogue = RevisionCatalogue.open(cataloguePath, {
        vault,
        scopes: scopeRegistry.all(),
        clock: this.clock,
        approval_provenance: new JournalApprovalProvenance(journal)
      });
      this.catalogue = catalogue;
      const backend =
        this.options.backend ??
        new BasicMemoryBackend({
          url: this.config.backend_endpoint,
          projects: scopeRegistry.all().map((scope) => scope.backend_project),
          timeout_ms: this.config.limits.backend_timeout_ms
        });
      this.backend = backend;
      await backend.connect();
      for (const scope of scopeRegistry.all()) backend.registerScope(scope);
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
      this.credentials = loadCredentials(this.config.credentials_file);
      await loadCursorSecret(this.config);
      this.startCredentialWatch();

      const base = buildServices(deps, this.config.result_delivery, this.log);
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
    return false;
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

  reloadCredentials(): void {
    this.credentials = loadCredentials(this.config.credentials_file);
  }

  private startCredentialWatch(): void {
    const path = this.config.credentials_file;
    const listener = (): void => {
      try {
        this.reloadCredentials();
      } catch (error) {
        this.log(internalDiagnostic(error));
      }
    };
    try {
      const watcher = watchFile(path, { interval: 200, persistent: false }, listener);
      watcher.unref?.();
      this.credentialsWatcher = watcher;
      this.credentialsListener = listener;
    } catch (error) {
      this.log(internalDiagnostic(error));
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
    if (this.credentialsWatcher !== undefined && this.credentialsListener !== undefined) {
      unwatchFile(this.config.credentials_file, this.credentialsListener);
    }
    this.credentialsWatcher = undefined;
    this.credentialsListener = undefined;
    this.ready = false;
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
  options: RuntimeOptions = {}
): Promise<BrainRuntime> {
  const runtime = new BrainRuntimeImpl(config, options);
  await runtime.start();
  return runtime;
}
