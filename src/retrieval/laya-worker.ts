import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import type { LayaSettings } from '../config/schema.js';
import {
  LAYA_DEADLINE_MS,
  LAYA_MAX_BATCH_ITEMS,
  LAYA_MAX_LINE_BYTES,
  LAYA_MAX_RESTARTS,
  LAYA_MAX_WAITING_BATCHES,
  LAYA_RESTART_WINDOW_MS,
  LayaProtocolError,
  encodeScoreBatch,
  layaScoreInputSchema,
  parseDiagnosticLine,
  parseWorkerMessage,
  validateBatchScores,
  type LayaRuntimeIdentifiers,
  type LayaScore,
  type LayaScoreInput,
  type LayaScoreResult,
  type LayaWireItem,
  type LayaWorkerMessage
} from './laya-protocol.js';

export type LayaHealthState = 'disabled' | 'starting' | 'ready' | 'unavailable';

export type LayaUnavailableReason =
  | 'disabled'
  | 'not_started'
  | 'starting'
  | 'restarting'
  | 'circuit_open'
  | 'overloaded'
  | 'timeout'
  | 'crashed'
  | 'protocol_error'
  | 'spawn_failed'
  | 'startup_timeout'
  | 'input_too_long'
  | 'invalid_request'
  | 'inference_failed'
  | 'cancelled'
  | 'closed';

export class LayaWorkerError extends Error {
  readonly code = 'LAYA_UNAVAILABLE' as const;
  readonly reason: LayaUnavailableReason;

  constructor(reason: LayaUnavailableReason) {
    super(`laya reranker unavailable: ${reason}`);
    this.name = 'LayaWorkerError';
    this.reason = reason;
  }
}

export interface LayaHealth {
  state: LayaHealthState;
  reason?: LayaUnavailableReason;
  model_fingerprint?: string;
  question_version?: string;
  runtime?: LayaRuntimeIdentifiers;
  pid?: number;
  restarts_in_window: number;
  circuit_open_until?: string;
}

export interface LayaDiagnostic {
  event: string;
  error_class?: string;
  exit_code?: number | null;
  signal?: string | null;
  count?: number;
}

export interface LayaWorkerOptions {
  enabled: boolean;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
  timeoutMs?: number;
  batchSize?: number;
  queueBatches?: number;
  startupTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  circuitCooldownMs?: number;
  shutdownGraceMs?: number;
  onDiagnostic?: (diagnostic: LayaDiagnostic) => void;
  spawn?: typeof spawnProcess;
  now?: () => number;
}

export interface LayaWorkerLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface PendingRequest {
  settled: boolean;
  batches: Batch[];
  remaining: number;
  results: LayaScore[][];
  resolve: (result: LayaScoreResult) => void;
  reject: (error: LayaWorkerError) => void;
  timer: NodeJS.Timeout;
  deadlineAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Batch {
  id: string;
  index: number;
  line: string;
  keys: string[];
  owner: PendingRequest;
}

type Phase = 'idle' | 'starting' | 'ready' | 'backoff' | 'circuit_open' | 'closed';

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const STDERR_LINE_MAX_BYTES = 16 * 1024;
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

const bounded = (name: string, value: number | undefined, fallback: number, min: number, max: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
  }
  return resolved;
};

export function restrictedLayaEnvironment(
  source: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  options: { threads: number }
): Record<string, string> {
  const threads = String(options.threads);
  const path = source.PATH !== undefined && source.PATH.length > 0 ? source.PATH : DEFAULT_PATH;
  return {
    PATH: path,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    TOKENIZERS_PARALLELISM: 'false',
    OMP_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads
  };
}

export function layaWorkerLaunch(
  settings: LayaSettings,
  appRoot: string,
  source: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env
): LayaWorkerLaunch {
  const resolve = (value: string): string => (isAbsolute(value) ? value : join(appRoot, value));
  return {
    command: settings.python,
    args: [
      '-E',
      '-s',
      '-B',
      '-m',
      'workers.laya.worker',
      '--model-dir',
      resolve(settings.model_dir),
      '--lock',
      resolve(settings.lock_file),
      '--questions',
      join(appRoot, 'workers', 'laya', 'questions.json'),
      '--threads',
      String(settings.threads)
    ],
    cwd: appRoot,
    env: restrictedLayaEnvironment(source, { threads: settings.threads })
  };
}

export function layaWorkerOptions(
  settings: LayaSettings,
  appRoot: string,
  source: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env
): LayaWorkerOptions {
  const launch = layaWorkerLaunch(settings, appRoot, source);
  return {
    enabled: settings.enabled,
    command: launch.command,
    args: launch.args,
    env: launch.env,
    cwd: launch.cwd,
    timeoutMs: settings.timeout_ms,
    batchSize: settings.batch_size,
    queueBatches: settings.queue_batches
  };
}

export class LayaWorker {
  private readonly options: LayaWorkerOptions;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private readonly queueBatches: number;
  private readonly startupTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly circuitCooldownMs: number;
  private readonly shutdownGraceMs: number;
  private readonly spawnChild: typeof spawnProcess;
  private readonly now: () => number;
  private phase: Phase = 'idle';
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly exits = new Set<Promise<void>>();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private discardedStderr = 0;
  private active: Batch | null = null;
  private activeWatchdog: NodeJS.Timeout | null = null;
  private waiting: Batch[] = [];
  private restarts: number[] = [];
  private circuitOpenUntil = 0;
  private startupTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private batchCounter = 0;
  private ready: { model_fingerprint: string; question_version: string; runtime: LayaRuntimeIdentifiers } | null = null;

  constructor(options: LayaWorkerOptions) {
    this.options = options;
    this.timeoutMs = bounded('timeoutMs', options.timeoutMs, LAYA_DEADLINE_MS, 1, LAYA_DEADLINE_MS);
    this.batchSize = bounded('batchSize', options.batchSize, LAYA_MAX_BATCH_ITEMS, 1, LAYA_MAX_BATCH_ITEMS);
    this.queueBatches = bounded('queueBatches', options.queueBatches, LAYA_MAX_WAITING_BATCHES, 1, LAYA_MAX_WAITING_BATCHES);
    this.startupTimeoutMs = bounded('startupTimeoutMs', options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 1, 3_600_000);
    this.maxRestarts = bounded('maxRestarts', options.maxRestarts, LAYA_MAX_RESTARTS, 0, LAYA_MAX_RESTARTS);
    this.restartWindowMs = bounded('restartWindowMs', options.restartWindowMs, LAYA_RESTART_WINDOW_MS, 1, 86_400_000);
    this.backoffBaseMs = bounded('backoffBaseMs', options.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS, 1, 3_600_000);
    this.backoffMaxMs = bounded('backoffMaxMs', options.backoffMaxMs, DEFAULT_BACKOFF_MAX_MS, 1, 3_600_000);
    this.circuitCooldownMs = bounded('circuitCooldownMs', options.circuitCooldownMs, DEFAULT_CIRCUIT_COOLDOWN_MS, 1, 86_400_000);
    this.shutdownGraceMs = bounded('shutdownGraceMs', options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS, 1, 60_000);
    this.spawnChild = options.spawn ?? spawnProcess;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.options.enabled || this.phase === 'closed') return;
    if (this.phase === 'starting' || this.phase === 'ready' || this.phase === 'backoff') return;
    if (this.phase === 'circuit_open' && this.now() < this.circuitOpenUntil) return;
    if (this.phase === 'circuit_open') this.restarts = [];
    this.launch();
  }

  health(): LayaHealth {
    const restarts = this.restartsInWindow();
    if (!this.options.enabled) return { state: 'disabled', reason: 'disabled', restarts_in_window: restarts };
    const pid = this.child?.pid;
    const identity = this.ready === null ? {} : { ...this.ready, runtime: { ...this.ready.runtime } };
    switch (this.phase) {
      case 'ready':
        return { state: 'ready', ...identity, ...(pid === undefined ? {} : { pid }), restarts_in_window: restarts };
      case 'starting':
        return { state: 'starting', reason: 'starting', ...(pid === undefined ? {} : { pid }), restarts_in_window: restarts };
      case 'idle':
        return { state: 'unavailable', reason: 'not_started', restarts_in_window: restarts };
      case 'backoff':
        return { state: 'unavailable', reason: 'restarting', restarts_in_window: restarts };
      case 'circuit_open':
        return {
          state: 'unavailable',
          reason: 'circuit_open',
          restarts_in_window: restarts,
          circuit_open_until: new Date(this.circuitOpenUntil).toISOString()
        };
      case 'closed':
        return { state: 'unavailable', reason: 'closed', restarts_in_window: restarts };
    }
  }

  score(input: LayaScoreInput): Promise<LayaScoreResult> {
    const parsed = layaScoreInputSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new LayaWorkerError('invalid_request'));
    if (!this.options.enabled) return Promise.reject(new LayaWorkerError('disabled'));
    if (this.phase === 'closed') return Promise.reject(new LayaWorkerError('closed'));
    if (input.signal?.aborted === true) return Promise.reject(new LayaWorkerError('cancelled'));
    const unavailable = this.unavailableReason();
    if (unavailable !== null) return Promise.reject(new LayaWorkerError(unavailable));
    const identity = this.ready;
    if (identity === null) return Promise.reject(new LayaWorkerError('starting'));
    if (parsed.data.candidates.length === 0) {
      return Promise.resolve({
        scores: [],
        model_fingerprint: identity.model_fingerprint,
        question_version: identity.question_version
      });
    }
    let groups: LayaWireItem[][];
    try {
      groups = this.split(parsed.data.query, parsed.data.candidates);
    } catch {
      return Promise.reject(new LayaWorkerError('invalid_request'));
    }
    const waitingAfter = this.waiting.length + groups.length - (this.active === null ? 1 : 0);
    if (waitingAfter > this.queueBatches) return Promise.reject(new LayaWorkerError('overloaded'));
    return new Promise<LayaScoreResult>((resolve, reject) => {
      const request: PendingRequest = {
        settled: false,
        batches: [],
        remaining: groups.length,
        results: groups.map(() => []),
        resolve,
        reject,
        timer: setTimeout(() => this.expire(request), this.timeoutMs),
        deadlineAt: performance.now() + this.timeoutMs,
        signal: input.signal
      };
      request.batches = groups.map((items, index) => {
        this.batchCounter += 1;
        const id = `b${this.batchCounter}`;
        return { id, index, owner: request, keys: items.map((item) => item.chunk_key), line: encodeScoreBatch(id, parsed.data.query, items) };
      });
      if (input.signal !== undefined) {
        request.onAbort = () => this.cancel(request);
        input.signal.addEventListener('abort', request.onAbort, { once: true });
      }
      this.waiting.push(...request.batches);
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.phase !== 'closed') {
      this.phase = 'closed';
      this.clearTimers();
      this.rejectAll('closed');
    }
    const child = this.child;
    let term: NodeJS.Timeout | undefined;
    let hard: NodeJS.Timeout | undefined;
    if (child !== null) {
      child.stdin.end();
      const kill = (signal: NodeJS.Signals) => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      };
      term = setTimeout(() => kill('SIGTERM'), this.shutdownGraceMs);
      hard = setTimeout(() => kill('SIGKILL'), this.shutdownGraceMs * 2);
    }
    try {
      await Promise.all([...this.exits]);
    } finally {
      clearTimeout(term);
      clearTimeout(hard);
    }
  }

  private unavailableReason(): LayaUnavailableReason | null {
    switch (this.phase) {
      case 'ready':
        return null;
      case 'idle':
        this.start();
        return 'starting';
      case 'starting':
        return 'starting';
      case 'backoff':
        return 'restarting';
      case 'circuit_open':
        if (this.now() >= this.circuitOpenUntil) {
          this.start();
          return 'starting';
        }
        return 'circuit_open';
      case 'closed':
        return 'closed';
    }
  }

  private split(query: string, candidates: readonly { chunk_key: string; title: string; heading?: string | null; excerpt: string }[]): LayaWireItem[][] {
    const groups: LayaWireItem[][] = [];
    let current: LayaWireItem[] = [];
    for (const candidate of candidates) {
      const item: LayaWireItem = {
        chunk_key: candidate.chunk_key,
        title: candidate.title,
        heading: candidate.heading ?? null,
        excerpt: candidate.excerpt
      };
      encodeScoreBatch('b0', query, [item]);
      const next = [...current, item];
      let fits = next.length <= this.batchSize;
      if (fits) {
        try {
          encodeScoreBatch('b0', query, next);
        } catch (error) {
          if (!(error instanceof LayaProtocolError) || error.code !== 'line_too_long') throw error;
          fits = false;
        }
      }
      if (fits) {
        current = next;
      } else {
        groups.push(current);
        current = [item];
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  private launch(): void {
    this.phase = 'starting';
    this.ready = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnChild(this.options.command, [...this.options.args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...this.options.env },
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        windowsHide: true
      }) as ChildProcessWithoutNullStreams;
    } catch {
      this.child = null;
      this.fail('spawn_failed');
      return;
    }
    this.child = child;
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    this.exits.add(exited);
    void exited.then(() => this.exits.delete(exited));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child === child) this.onStdout(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      if (this.child === child) this.onStderr(chunk);
    });
    child.stdin.on('error', () => undefined);
    child.once('error', () => {
      if (this.child === child) this.fail('spawn_failed');
    });
    child.once('exit', (code, signal) => {
      this.diagnose({ event: 'worker_exit', exit_code: code, signal });
      if (this.child === child) {
        this.flushDiscarded();
        this.fail('crashed');
      }
    });
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.child === child && this.phase === 'starting') this.fail('startup_timeout');
    }, this.startupTimeoutMs);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0 && this.child !== null) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.onMessage(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
    if (this.child !== null && Buffer.byteLength(this.stdoutBuffer, 'utf8') > LAYA_MAX_LINE_BYTES) this.fail('protocol_error');
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let newline = this.stderrBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stderrBuffer.slice(0, newline);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      const diagnostic = parseDiagnosticLine(line);
      if (diagnostic === null) {
        this.discardedStderr += 1;
      } else {
        this.diagnose({ event: diagnostic.event, ...(diagnostic.error_class === undefined ? {} : { error_class: diagnostic.error_class }) });
      }
      newline = this.stderrBuffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.stderrBuffer, 'utf8') > STDERR_LINE_MAX_BYTES) {
      this.stderrBuffer = '';
      this.discardedStderr += 1;
    }
    this.flushDiscarded();
  }

  private flushDiscarded(): void {
    if (this.discardedStderr === 0) return;
    const count = this.discardedStderr;
    this.discardedStderr = 0;
    this.diagnose({ event: 'stderr_discarded', count });
  }

  private diagnose(diagnostic: LayaDiagnostic): void {
    try {
      this.options.onDiagnostic?.(diagnostic);
    } catch {
      return;
    }
  }

  private onMessage(line: string): void {
    let message: LayaWorkerMessage;
    try {
      message = parseWorkerMessage(line);
    } catch {
      this.fail('protocol_error');
      return;
    }
    if (message.type === 'ready') {
      if (this.phase !== 'starting') {
        this.fail('protocol_error');
        return;
      }
      if (this.startupTimer !== null) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.ready = {
        model_fingerprint: message.model_fingerprint,
        question_version: message.question_version,
        runtime: message.runtime
      };
      this.phase = 'ready';
      this.pump();
      return;
    }
    const batch = this.active;
    if (this.phase !== 'ready' || batch === null || message.id !== batch.id) {
      this.fail('protocol_error');
      return;
    }
    if (message.type === 'error') {
      this.clearActive();
      const reason: LayaUnavailableReason =
        message.code === 'input_too_long' ? 'input_too_long' : message.code === 'inference_failed' ? 'inference_failed' : 'invalid_request';
      this.settle(batch.owner, new LayaWorkerError(reason));
      this.pump();
      return;
    }
    let scores: LayaScore[];
    try {
      scores = validateBatchScores(batch.keys, message.scores);
    } catch {
      this.fail('protocol_error');
      return;
    }
    this.clearActive();
    this.complete(batch, scores);
    this.pump();
  }

  private complete(batch: Batch, scores: LayaScore[]): void {
    const request = batch.owner;
    if (request.settled) return;
    request.results[batch.index] = scores;
    request.remaining -= 1;
    if (request.remaining === 0 && this.ready !== null) {
      this.settle(request, {
        scores: request.results.flat(),
        model_fingerprint: this.ready.model_fingerprint,
        question_version: this.ready.question_version
      });
    }
  }

  private settle(request: PendingRequest, outcome: LayaScoreResult | LayaWorkerError): void {
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    if (request.signal !== undefined && request.onAbort !== undefined) {
      request.signal.removeEventListener('abort', request.onAbort);
    }
    this.waiting = this.waiting.filter((batch) => batch.owner !== request);
    if (outcome instanceof LayaWorkerError) request.reject(outcome);
    else request.resolve(outcome);
  }

  private pump(): void {
    if (this.phase !== 'ready' || this.active !== null || this.child === null) return;
    const next = this.waiting.shift();
    if (next === undefined) return;
    this.active = next;
    this.activeWatchdog = setTimeout(() => {
      this.activeWatchdog = null;
      if (this.active === next) this.fail('timeout');
    }, Math.max(0, next.owner.deadlineAt - performance.now()));
    this.child.stdin.write(next.line);
  }

  private clearActive(): void {
    if (this.activeWatchdog !== null) clearTimeout(this.activeWatchdog);
    this.activeWatchdog = null;
    this.active = null;
  }

  private expire(request: PendingRequest): void {
    if (request.settled) return;
    if (this.active !== null && this.active.owner === request) {
      this.fail('timeout');
      return;
    }
    this.settle(request, new LayaWorkerError('timeout'));
  }

  private cancel(request: PendingRequest): void {
    this.settle(request, new LayaWorkerError('cancelled'));
  }

  private rejectAll(reason: LayaUnavailableReason): void {
    const owners = new Set<PendingRequest>();
    if (this.active !== null) owners.add(this.active.owner);
    for (const batch of this.waiting) owners.add(batch.owner);
    this.clearActive();
    this.waiting = [];
    for (const owner of owners) this.settle(owner, new LayaWorkerError(reason));
  }

  private restartsInWindow(): number {
    const cutoff = this.now() - this.restartWindowMs;
    this.restarts = this.restarts.filter((time) => time > cutoff);
    return this.restarts.length;
  }

  private clearTimers(): void {
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.startupTimer = null;
    this.restartTimer = null;
  }

  private fail(reason: LayaUnavailableReason): void {
    if (this.phase === 'closed' || this.phase === 'backoff' || this.phase === 'circuit_open') return;
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.clearTimers();
    if (child !== null && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    this.diagnose({ event: 'worker_failed', error_class: reason });
    this.rejectAll(reason);
    const recent = this.restartsInWindow();
    if (recent >= this.maxRestarts) {
      this.phase = 'circuit_open';
      this.circuitOpenUntil = this.now() + this.circuitCooldownMs;
      this.diagnose({ event: 'circuit_open' });
      return;
    }
    this.phase = 'backoff';
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** recent);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.phase !== 'backoff') return;
      this.restarts.push(this.now());
      this.launch();
    }, delay);
  }
}
