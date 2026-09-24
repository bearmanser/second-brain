import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveLayaSettings } from '../../src/config/load.js';
import { brainConfigSchema } from '../../src/config/schema.js';
import {
  LAYA_MAX_BATCH_ITEMS,
  LAYA_MAX_CANDIDATES,
  LAYA_MAX_LINE_BYTES,
  LayaProtocolError,
  encodeScoreBatch,
  normalizeProbabilities,
  parseWorkerMessage,
  validateBatchScores
} from '../../src/retrieval/laya-protocol.js';
import {
  LayaWorker,
  LayaWorkerError,
  layaWorkerLaunch,
  restrictedLayaEnvironment,
  type LayaDiagnostic,
  type LayaWorkerOptions
} from '../../src/retrieval/laya-worker.js';

const FAKE_WORKER = String.raw`
const scenario = process.argv[process.argv.length - 1];
const write = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
let busy = false;
if (scenario === 'stderr-noise') {
  process.stderr.write('Traceback: secret query text leaked by a library\n');
  process.stderr.write(JSON.stringify({ v: 1, type: 'diagnostic', event: 'model_loading' }) + '\n');
  process.stderr.write(JSON.stringify({ v: 1, type: 'diagnostic', event: 'bad event with query text' }) + '\n');
}
if (scenario !== 'never-ready') {
  const readyDelay = scenario === 'slow-ready' ? 150 : 0;
  setTimeout(() => write({
    v: 1,
    type: 'ready',
    model_fingerprint: 'f'.repeat(64),
    question_version: 'relevance-test',
    runtime: { laya: '0.3.11', python: '3.12.3', torch: '2.14.0+cpu', device: 'cpu', threads: 2, max_len: 1024, head_max_len: 256 }
  }), readyDelay);
}
const scoresFor = (items) => items.map((item, index) => ({
  chunk_key: item.chunk_key,
  probabilities: { A: 0.5, B: 0.25, C: 0.25 },
  input_tokens: 100 + items.length,
  truncated: item.excerpt.length > 50
}));
const allowed = new Set(['v', 'id', 'action', 'payload']);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const request = JSON.parse(line);
    if (Object.keys(request).some((key) => !allowed.has(key)) || request.action !== 'score' || request.v !== 1) process.exit(3);
    if (request.payload.items.length > 8) process.exit(5);
    if (busy) process.exit(4);
    const items = request.payload.items;
    const respond = () => {
      busy = false;
      switch (scenario) {
        case 'mismatched-id': return write({ v: 1, type: 'result', id: 'other', scores: scoresFor(items) });
        case 'missing-key': return write({ v: 1, type: 'result', id: request.id, scores: scoresFor(items).slice(1) });
        case 'duplicate-key': { const s = scoresFor(items); return write({ v: 1, type: 'result', id: request.id, scores: [s[0], ...s] }); }
        case 'nan': return write('{"v":1,"type":"result","id":"' + request.id + '","scores":[{"chunk_key":"' + items[0].chunk_key + '","probabilities":{"A":NaN,"B":0,"C":1},"input_tokens":3,"truncated":false}]}\n');
        case 'infinite': return write('{"v":1,"type":"result","id":"' + request.id + '","scores":[{"chunk_key":"' + items[0].chunk_key + '","probabilities":{"A":1e999,"B":0,"C":0},"input_tokens":3,"truncated":false}]}\n');
        case 'out-of-range': return write({ v: 1, type: 'result', id: request.id, scores: scoresFor(items).map((s) => ({ ...s, probabilities: { A: 1.5, B: -0.25, C: -0.25 } })) });
        case 'bad-sum': return write({ v: 1, type: 'result', id: request.id, scores: scoresFor(items).map((s) => ({ ...s, probabilities: { A: 0.5, B: 0.2, C: 0.2 } })) });
        case 'extra-field': return write({ v: 1, type: 'result', id: request.id, scores: scoresFor(items), note_text: 'x' });
        case 'invalid-json': return write('{oops\n');
        case 'huge-line': return write('x'.repeat(300 * 1024) + '\n');
        case 'exit-mid-request': return process.exit(9);
        case 'hang': return undefined;
        case 'input-too-long': return write({ v: 1, type: 'error', id: request.id, code: 'input_too_long' });
        default: return write({ v: 1, type: 'result', id: request.id, scores: scoresFor(items) });
      }
    };
    busy = true;
    if (scenario === 'slow') setTimeout(respond, 60); else respond();
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const workers: LayaWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
});

function fakeWorker(scenario: string, overrides: Partial<LayaWorkerOptions> = {}): LayaWorker {
  const worker = new LayaWorker({
    enabled: true,
    command: process.execPath,
    args: ['-e', FAKE_WORKER, scenario],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    timeoutMs: 1500,
    startupTimeoutMs: 3000,
    backoffBaseMs: 10,
    backoffMaxMs: 20,
    circuitCooldownMs: 60_000,
    shutdownGraceMs: 500,
    ...overrides
  });
  workers.push(worker);
  return worker;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readyWorker(scenario: string, overrides: Partial<LayaWorkerOptions> = {}): Promise<LayaWorker> {
  const worker = fakeWorker(scenario, overrides);
  worker.start();
  await waitFor(() => worker.health().state === 'ready');
  return worker;
}

function candidates(count: number, prefix = 'note'): Array<{ chunk_key: string; title: string; heading?: string | null; excerpt: string }> {
  return Array.from({ length: count }, (_, index) => ({
    chunk_key: `${prefix}-${index}#0-10`,
    title: `Title ${index}`,
    heading: index % 2 === 0 ? null : 'Heading',
    excerpt: `Excerpt ${index}`
  }));
}

async function rejection(promise: Promise<unknown>): Promise<LayaWorkerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LayaWorkerError);
    return error as LayaWorkerError;
  }
  throw new Error('expected rejection');
}

describe('Laya protocol validation', () => {
  test('preserves a valid distribution and normalizes only rounding error', () => {
    expect(normalizeProbabilities({ A: 0.7, B: 0.2, C: 0.1 })).toEqual({ A: 0.7, B: 0.2, C: 0.1 });
    const rounded = normalizeProbabilities({ A: 0.3333, B: 0.3333, C: 0.3333 });
    expect(rounded.A + rounded.B + rounded.C).toBeCloseTo(1, 12);
  });

  test('rejects NaN, infinite, out-of-range, non-numeric, and badly summed distributions', () => {
    const invalid: unknown[] = [
      { A: Number.NaN, B: 0.2, C: 0.8 },
      { A: Number.POSITIVE_INFINITY, B: 0, C: 0 },
      { A: 1.2, B: -0.1, C: -0.1 },
      { A: '0.5', B: 0.25, C: 0.25 },
      { A: true, B: false, C: false },
      { A: 0.5, B: 0.2, C: 0.2 },
      { A: 0, B: 0, C: 0 },
      { A: 0.5, B: 0.5 },
      { A: 0.5, B: 0.25, C: 0.25, D: 0 }
    ];
    for (const value of invalid) {
      expect(() => normalizeProbabilities(value)).toThrow(LayaProtocolError);
    }
  });

  test('bounds encoded request lines', () => {
    const line = encodeScoreBatch('b-1', 'query', [{ chunk_key: 'k', title: 't', heading: null, excerpt: 'e' }]);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      v: 1,
      id: 'b-1',
      action: 'score',
      payload: { query: 'query', items: [{ chunk_key: 'k', title: 't', heading: null, excerpt: 'e' }] }
    });
    const huge = Array.from({ length: 8 }, (_, index) => ({
      chunk_key: `k${index}`,
      title: 't',
      heading: null,
      excerpt: '\u0001'.repeat(8000)
    }));
    expect(() => encodeScoreBatch('b-2', 'query', huge)).toThrow(LayaProtocolError);
    expect(() => encodeScoreBatch('b-3', 'query', candidates(LAYA_MAX_BATCH_ITEMS + 1).map((c) => ({ ...c, heading: c.heading ?? null })))).toThrow(
      LayaProtocolError
    );
  });

  test('rejects invalid JSON, huge lines, unknown fields, and unknown message types', () => {
    expect(() => parseWorkerMessage('{oops')).toThrow(LayaProtocolError);
    expect(() => parseWorkerMessage('x'.repeat(LAYA_MAX_LINE_BYTES + 1))).toThrow(LayaProtocolError);
    expect(() => parseWorkerMessage(JSON.stringify({ v: 1, type: 'result', id: 'a', scores: [], extra: 1 }))).toThrow(LayaProtocolError);
    expect(() => parseWorkerMessage(JSON.stringify({ v: 1, type: 'log', message: 'hi' }))).toThrow(LayaProtocolError);
    expect(() => parseWorkerMessage(JSON.stringify({ v: 2, type: 'error', id: 'a', code: 'input_too_long' }))).toThrow(LayaProtocolError);
    expect(parseWorkerMessage(JSON.stringify({ v: 1, type: 'error', id: 'a', code: 'input_too_long' }))).toEqual({
      v: 1,
      type: 'error',
      id: 'a',
      code: 'input_too_long'
    });
  });

  test('requires every requested chunk exactly once', () => {
    const score = (chunk_key: string) => ({ chunk_key, probabilities: { A: 0.6, B: 0.3, C: 0.1 }, input_tokens: 10, truncated: false });
    expect(validateBatchScores(['a', 'b'], [score('b'), score('a')]).map((item) => item.chunk_key)).toEqual(['a', 'b']);
    expect(() => validateBatchScores(['a', 'b'], [score('a')])).toThrow(LayaProtocolError);
    expect(() => validateBatchScores(['a', 'b'], [score('a'), score('a')])).toThrow(LayaProtocolError);
    expect(() => validateBatchScores(['a'], [score('a'), score('z')])).toThrow(LayaProtocolError);
    expect(() => validateBatchScores(['a'], [{ ...score('a'), input_tokens: 0 }])).toThrow(LayaProtocolError);
    expect(() => validateBatchScores(['a'], [{ ...score('a'), extra: true }])).toThrow(LayaProtocolError);
  });
});

describe('Laya worker input validation', () => {
  test('rejects unknown fields, unbounded arrays, duplicate keys, and malformed request IDs', async () => {
    const worker = await readyWorker('normal');
    const cases: unknown[] = [
      { request_id: 'r1', query: 'q', candidates: [{ ...candidates(1)[0], score: 1 }] },
      { request_id: 'r1', query: 'q', candidates: candidates(LAYA_MAX_CANDIDATES + 1) },
      { request_id: 'r1', query: 'q', candidates: [candidates(1)[0], candidates(1)[0]] },
      { request_id: 'bad id', query: 'q', candidates: candidates(1) },
      { request_id: 'r1', query: '   ', candidates: candidates(1) },
      { request_id: 'r1', query: 'q', candidates: candidates(1), extra: true }
    ];
    for (const input of cases) {
      const error = await rejection(worker.score(input as never));
      expect(error.reason).toBe('invalid_request');
    }
    expect(worker.health().state).toBe('ready');
  });
});

describe('Laya worker supervision', () => {
  test('scores the maximum candidate set in bounded batches and keeps candidate order', async () => {
    const worker = await readyWorker('normal');
    const input = candidates(LAYA_MAX_CANDIDATES);
    const result = await worker.score({ request_id: 'r-30', query: 'find the note', candidates: input });
    expect(result.model_fingerprint).toBe('f'.repeat(64));
    expect(result.question_version).toBe('relevance-test');
    expect(result.scores.map((score) => score.chunk_key)).toEqual(input.map((candidate) => candidate.chunk_key));
    for (const score of result.scores) {
      expect(score.input_tokens - 100).toBeLessThanOrEqual(LAYA_MAX_BATCH_ITEMS);
      expect(Object.keys(score).sort()).toEqual(['chunk_key', 'input_tokens', 'probabilities', 'truncated']);
    }
    const health = worker.health();
    expect(health.state).toBe('ready');
    expect(health.model_fingerprint).toBe('f'.repeat(64));
    expect(health.runtime).toMatchObject({ laya: '0.3.11', device: 'cpu' });
  });

  test('returns an empty score list without contacting the worker', async () => {
    const worker = await readyWorker('hang');
    const result = await worker.score({ request_id: 'empty', query: 'q', candidates: [] });
    expect(result.scores).toEqual([]);
  });

  test.each([
    ['mismatched-id'],
    ['missing-key'],
    ['duplicate-key'],
    ['nan'],
    ['infinite'],
    ['out-of-range'],
    ['bad-sum'],
    ['extra-field'],
    ['invalid-json'],
    ['huge-line']
  ])('treats a %s response as a protocol failure and restarts the worker', async (scenario) => {
    const worker = await readyWorker(scenario);
    const error = await rejection(worker.score({ request_id: 'r', query: 'q', candidates: candidates(3) }));
    expect(error.reason).toBe('protocol_error');
    expect(error.code).toBe('LAYA_UNAVAILABLE');
    expect(worker.health().state).not.toBe('ready');
    await waitFor(() => worker.health().state === 'ready');
    expect(worker.health().restarts_in_window).toBe(1);
  });

  test('rejects work when the worker exits mid-request and then restarts it', async () => {
    const worker = await readyWorker('exit-mid-request');
    const first = worker.score({ request_id: 'r1', query: 'q', candidates: candidates(12) });
    const second = worker.score({ request_id: 'r2', query: 'q', candidates: candidates(4, 'other') });
    expect((await rejection(first)).reason).toBe('crashed');
    expect((await rejection(second)).reason).toBe('crashed');
    await waitFor(() => worker.health().state === 'ready');
  });

  test('kills a hung worker at the deadline and rejects queued work with a typed reason', async () => {
    const worker = await readyWorker('hang', { timeoutMs: 250 });
    const pid = worker.health().pid;
    expect(pid).toBeGreaterThan(0);
    const started = Date.now();
    const first = worker.score({ request_id: 'r1', query: 'q', candidates: candidates(3) });
    const queued = new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
      worker.score({ request_id: 'r2', query: 'q', candidates: candidates(3, 'late') })
    );
    expect((await rejection(first)).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await rejection(queued)).reason).toBe('timeout');
    await waitFor(() => !processAlive(pid as number));
    await waitFor(() => worker.health().state === 'ready');
  });

  test('serves simultaneous calls one active batch at a time', async () => {
    const worker = await readyWorker('slow');
    const results = await Promise.all([
      worker.score({ request_id: 'a', query: 'first', candidates: candidates(9, 'a') }),
      worker.score({ request_id: 'b', query: 'second', candidates: candidates(2, 'b') })
    ]);
    expect(results[0].scores.map((score) => score.chunk_key)).toEqual(candidates(9, 'a').map((c) => c.chunk_key));
    expect(results[1].scores.map((score) => score.chunk_key)).toEqual(candidates(2, 'b').map((c) => c.chunk_key));
    expect(worker.health().state).toBe('ready');
  });

  test('rejects work beyond the waiting-batch bound as overloaded', async () => {
    const worker = await readyWorker('slow');
    const first = worker.score({ request_id: 'a', query: 'q', candidates: candidates(30, 'a') });
    const overflow = await rejection(worker.score({ request_id: 'b', query: 'q', candidates: candidates(9, 'b') }));
    expect(overflow.reason).toBe('overloaded');
    const fits = worker.score({ request_id: 'c', query: 'q', candidates: candidates(8, 'c') });
    await expect(first).resolves.toMatchObject({ question_version: 'relevance-test' });
    await expect(fits).resolves.toMatchObject({ question_version: 'relevance-test' });
  });

  test('opens the circuit after three restarts in the window until the cooldown elapses', async () => {
    let clock = 1_000_000;
    const worker = await readyWorker('exit-mid-request', { now: () => clock, circuitCooldownMs: 10_000 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await rejection(worker.score({ request_id: `r${attempt}`, query: 'q', candidates: candidates(1) }));
      await waitFor(() => worker.health().state === 'ready');
      expect(worker.health().restarts_in_window).toBe(attempt);
    }
    await rejection(worker.score({ request_id: 'r4', query: 'q', candidates: candidates(1) }));
    await waitFor(() => worker.health().reason === 'circuit_open');
    expect(worker.health().state).toBe('unavailable');
    expect(worker.health().pid).toBeUndefined();
    expect((await rejection(worker.score({ request_id: 'r5', query: 'q', candidates: candidates(1) }))).reason).toBe('circuit_open');
    clock += 10_001;
    expect((await rejection(worker.score({ request_id: 'r6', query: 'q', candidates: candidates(1) }))).reason).toBe('starting');
    await waitFor(() => worker.health().state === 'ready');
  });

  test('reports startup timeouts as unavailable and retries with backoff', async () => {
    const worker = fakeWorker('never-ready', { startupTimeoutMs: 100 });
    worker.start();
    expect(worker.health().state).toBe('starting');
    await waitFor(() => worker.health().restarts_in_window >= 1);
    expect(['starting', 'unavailable']).toContain(worker.health().state);
  });

  test('passes typed input_too_long failures through without restarting', async () => {
    const worker = await readyWorker('input-too-long');
    const error = await rejection(worker.score({ request_id: 'r', query: 'q', candidates: candidates(10) }));
    expect(error.reason).toBe('input_too_long');
    expect(worker.health().state).toBe('ready');
    expect(worker.health().restarts_in_window).toBe(0);
  });

  test('honours caller cancellation', async () => {
    const worker = await readyWorker('slow');
    const controller = new AbortController();
    const pending = worker.score({ request_id: 'r', query: 'q', candidates: candidates(20), signal: controller.signal });
    controller.abort();
    expect((await rejection(pending)).reason).toBe('cancelled');
    const aborted = new AbortController();
    aborted.abort();
    expect((await rejection(worker.score({ request_id: 's', query: 'q', candidates: candidates(1), signal: aborted.signal }))).reason).toBe(
      'cancelled'
    );
    await expect(worker.score({ request_id: 't', query: 'q', candidates: candidates(1) })).resolves.toBeDefined();
  });

  test('close terminates the child and rejects pending work', async () => {
    const worker = await readyWorker('hang');
    const pid = worker.health().pid as number;
    const pending = rejection(worker.score({ request_id: 'r', query: 'q', candidates: candidates(3) }));
    await worker.close();
    expect((await pending).reason).toBe('closed');
    expect(processAlive(pid)).toBe(false);
    expect(worker.health()).toMatchObject({ state: 'unavailable', reason: 'closed' });
    expect((await rejection(worker.score({ request_id: 's', query: 'q', candidates: candidates(1) }))).reason).toBe('closed');
  });

  test('a disabled worker never spawns and rejects scoring', async () => {
    let spawned = 0;
    const worker = fakeWorker('normal', {
      enabled: false,
      spawn: ((...args: Parameters<typeof spawn>) => {
        spawned += 1;
        return spawn(...args);
      }) as typeof spawn
    });
    worker.start();
    expect(worker.health()).toMatchObject({ state: 'disabled' });
    expect((await rejection(worker.score({ request_id: 'r', query: 'q', candidates: candidates(1) }))).reason).toBe('disabled');
    expect(spawned).toBe(0);
  });

  test('an unstarted worker is unavailable and starts on first use', async () => {
    const worker = fakeWorker('slow-ready');
    expect(worker.health()).toMatchObject({ state: 'unavailable', reason: 'not_started' });
    expect((await rejection(worker.score({ request_id: 'r', query: 'q', candidates: candidates(1) }))).reason).toBe('starting');
    expect(worker.health().state).toBe('starting');
    await waitFor(() => worker.health().state === 'ready');
  });

  test('forwards only structured diagnostics and never raw stderr text', async () => {
    const diagnostics: LayaDiagnostic[] = [];
    const worker = await readyWorker('stderr-noise', { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
    await worker.score({ request_id: 'r', query: 'q', candidates: candidates(1) });
    await waitFor(() => diagnostics.some((diagnostic) => diagnostic.event === 'model_loading'));
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('query text');
    expect(diagnostics.some((diagnostic) => diagnostic.event === 'stderr_discarded')).toBe(true);
  });

  test('spawns without a shell and with a restricted environment', async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const source = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/root',
      BRAIN_TOKEN_SHA256: 'a'.repeat(64),
      HF_TOKEN: 'hf_secret',
      HUGGING_FACE_HUB_TOKEN: 'hf_other',
      GITHUB_TOKEN: 'ghp_secret',
      GIT_ASKPASS: '/usr/bin/askpass',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      AWS_SECRET_ACCESS_KEY: 'aws',
      BRAIN_CURSOR_SECRET: '/run/secrets/brain_cursor'
    };
    const env = restrictedLayaEnvironment(source, { threads: 3 });
    for (const key of Object.keys(env)) {
      expect(['BRAIN_TOKEN_SHA256', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'BRAIN_CURSOR_SECRET', 'HOME']).not.toContain(key);
    }
    expect(Object.values(env).join('\n')).not.toMatch(/secret|hf_|ghp_|aaaa/);
    expect(env).toMatchObject({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      OMP_NUM_THREADS: '3',
      MKL_NUM_THREADS: '3'
    });

    const settings = resolveLayaSettings(brainConfigSchema.parse(baseConfig()), {});
    const launch = layaWorkerLaunch({ ...settings, enabled: true, threads: 3 }, '/app', source);
    expect(launch.command).toBe('python3');
    expect(launch.cwd).toBe('/app');
    expect(launch.args).toEqual([
      '-E',
      '-s',
      '-B',
      '-m',
      'workers.laya.worker',
      '--model-dir',
      '/var/lib/second-brain/models/laya/runtime',
      '--lock',
      '/app/config/laya-model.lock.json',
      '--questions',
      '/app/workers/laya/questions.json',
      '--threads',
      '3'
    ]);
    expect(launch.env).toEqual(env);

    const worker = fakeWorker('normal', {
      env,
      spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return spawn(command, args, options);
      }) as unknown as typeof spawn
    });
    worker.start();
    await waitFor(() => worker.health().state === 'ready');
    expect(calls).toHaveLength(1);
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].options.env).toEqual(env);
    expect(calls[0].options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  test('refuses options above the fixed batch, queue, and deadline bounds', () => {
    expect(() => fakeWorker('normal', { batchSize: 9 })).toThrow();
    expect(() => fakeWorker('normal', { queueBatches: 5 })).toThrow();
    expect(() => fakeWorker('normal', { timeoutMs: 4001 })).toThrow();
    expect(() => fakeWorker('normal', { maxRestarts: 4 })).toThrow();
    workers.splice(0);
  });
});

function baseConfig(): Record<string, unknown> {
  return {
    endpoint: 'http://127.0.0.1:7331/mcp',
    backend_endpoint: 'http://memory:8000/mcp',
    port: 7331,
    mounts: { vault: '/vault', state: '/var/lib/second-brain' },
    scopes: [{ id: 'shared', backend_project: 'shared', relative_root: 'Shared', repository_aliases: [] }],
    allowed_hosts: ['127.0.0.1:7331']
  };
}

describe('Laya configuration', () => {
  test('defaults to a disabled worker with the fixed bounds', () => {
    const config = brainConfigSchema.parse(baseConfig());
    expect(config.laya).toEqual({ enabled: false, python: 'python3', batch_size: 8, queue_batches: 4, timeout_ms: 4000, threads: 2 });
    expect(resolveLayaSettings(config, {})).toEqual({
      enabled: false,
      python: 'python3',
      model_dir: '/var/lib/second-brain/models/laya/runtime',
      lock_file: 'config/laya-model.lock.json',
      batch_size: 8,
      queue_batches: 4,
      timeout_ms: 4000,
      threads: 2
    });
  });

  test('rejects values above the bounds and unknown fields', () => {
    for (const laya of [{ batch_size: 9 }, { queue_batches: 5 }, { timeout_ms: 4001 }, { threads: 0 }, { unknown: true }, { python: 'python3 -c x' }]) {
      expect(brainConfigSchema.safeParse({ ...baseConfig(), laya }).success).toBe(false);
    }
  });

  test('applies bounded environment overrides', () => {
    const config = brainConfigSchema.parse(baseConfig());
    expect(
      resolveLayaSettings(config, {
        BRAIN_LAYA_ENABLED: 'true',
        BRAIN_LAYA_MODEL_DIR: '/models/laya/runtime',
        BRAIN_LAYA_BATCH_SIZE: '4',
        BRAIN_LAYA_QUEUE_BATCHES: '2',
        BRAIN_LAYA_TIMEOUT_MS: '3000',
        BRAIN_LAYA_THREADS: '1',
        BRAIN_LAYA_PYTHON: '/opt/laya/bin/python'
      })
    ).toMatchObject({
      enabled: true,
      model_dir: '/models/laya/runtime',
      batch_size: 4,
      queue_batches: 2,
      timeout_ms: 3000,
      threads: 1,
      python: '/opt/laya/bin/python'
    });
    expect(() => resolveLayaSettings(config, { BRAIN_LAYA_BATCH_SIZE: '16' })).toThrow();
    expect(() => resolveLayaSettings(config, { BRAIN_LAYA_ENABLED: 'yes please' })).toThrow();
    expect(() => resolveLayaSettings(config, { BRAIN_LAYA_TIMEOUT_MS: '9000' })).toThrow();
  });
});
