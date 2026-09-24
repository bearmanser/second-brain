import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { resolveLayaSettings } from '../../src/config/load.js';
import { brainConfigSchema, type LayaSettings } from '../../src/config/schema.js';
import { LAYA_MAX_CANDIDATES, type LayaCandidate } from '../../src/retrieval/laya-protocol.js';
import { LayaWorker, LayaWorkerError, layaWorkerOptions } from '../../src/retrieval/laya-worker.js';

const APP_ROOT = process.cwd();
const LOCK_PATH = join(APP_ROOT, 'config', 'laya-model.lock.json');
const COLD_START_MS = 180_000;

interface Lock {
  revision: string;
  runtime: { fingerprint: string };
  checkpoint: { max_len: number; head_max_len: number };
  sdk: { version: string };
}

function requiredArtifacts(): { python: string; modelDir: string; lock: Lock } {
  const python = process.env.BRAIN_LAYA_PYTHON;
  const modelDir = process.env.BRAIN_LAYA_MODEL_DIR;
  if (python === undefined || python.length === 0) {
    throw new Error('BRAIN_LAYA_PYTHON must name the Python runtime installed from workers/laya/requirements.lock');
  }
  if (modelDir === undefined || modelDir.length === 0 || !existsSync(modelDir) || !statSync(modelDir).isDirectory()) {
    throw new Error('BRAIN_LAYA_MODEL_DIR must point to the verified runtime copy produced by scripts/prepare-laya.py');
  }
  if (!existsSync(LOCK_PATH)) throw new Error('config/laya-model.lock.json is missing');
  return { python, modelDir, lock: JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as Lock };
}

function settings(python: string, modelDir: string): LayaSettings {
  const config = brainConfigSchema.parse({
    endpoint: 'http://127.0.0.1:7331/mcp',
    backend_endpoint: 'http://memory:8000/mcp',
    port: 7331,
    mounts: { vault: '/vault', state: '/var/lib/second-brain' },
    scopes: [{ id: 'shared', backend_project: 'shared', relative_root: 'Shared', repository_aliases: [] }],
    allowed_hosts: ['127.0.0.1:7331'],
    laya: { enabled: true }
  });
  return resolveLayaSettings(config, { BRAIN_LAYA_PYTHON: python, BRAIN_LAYA_MODEL_DIR: modelDir });
}

function memory(pid: number | undefined): { rss_mib: number | null; hwm_mib: number | null } {
  if (pid === undefined) return { rss_mib: null, hwm_mib: null };
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const field = (name: string): number | null => {
      const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(status);
      return match === null ? null : Math.round((Number(match[1]) / 1024) * 10) / 10;
    };
    return { rss_mib: field('VmRSS'), hwm_mib: field('VmHWM') };
  } catch {
    return { rss_mib: null, hwm_mib: null };
  }
}

function log(label: string, values: Record<string, unknown>): void {
  console.log(`[laya-smoke] ${label} ${JSON.stringify(values)}`);
}

async function waitForReady(worker: LayaWorker, timeoutMs = COLD_START_MS): Promise<number> {
  const started = Date.now();
  while (worker.health().state !== 'ready') {
    if (Date.now() - started > timeoutMs) throw new Error(`worker did not become ready: ${JSON.stringify(worker.health())}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Date.now() - started;
}

function assertFinite(result: Awaited<ReturnType<LayaWorker['score']>>, keys: string[], maxLen: number): void {
  expect(result.scores.map((score) => score.chunk_key)).toEqual(keys);
  for (const score of result.scores) {
    const { A, B, C } = score.probabilities;
    for (const value of [A, B, C]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(A + B + C - 1)).toBeLessThanOrEqual(0.002);
    expect(score.input_tokens).toBeGreaterThan(0);
    expect(score.input_tokens).toBeLessThanOrEqual(maxLen);
  }
}

const english: LayaCandidate[] = [
  { chunk_key: 'en-direct#0-1', title: 'Search index', heading: 'Rebuild', excerpt: 'The search index is disposable. Rebuild it from the current Markdown files with the rebuild command.' },
  { chunk_key: 'en-context#0-1', title: 'Storage layout', heading: null, excerpt: 'State lives in /var/lib/second-brain, including the journal, history, and index directories.' },
  { chunk_key: 'en-unrelated#0-1', title: 'Coffee', heading: null, excerpt: 'Grind beans coarsely and steep them for four minutes before pressing.' }
];

const norwegian: LayaCandidate[] = [
  { chunk_key: 'no-direct#0-1', title: 'Søkeindeks', heading: 'Gjenoppbygging', excerpt: 'Søkeindeksen kan slettes. Bygg den på nytt fra gjeldende Markdown-filer med gjenoppbyggingskommandoen.' },
  { chunk_key: 'no-context#0-1', title: 'Lagring', heading: null, excerpt: 'Tilstand lagres i /var/lib/second-brain, inkludert journal, historikk og indeks.' },
  { chunk_key: 'no-unrelated#0-1', title: 'Fiskesuppe', heading: null, excerpt: 'Kok opp kraften, tilsett fisk og fløte, og la suppen trekke i fem minutter.' }
];

describe('local Laya worker with the prepared checkpoint', () => {
  let worker: LayaWorker | null = null;

  afterAll(async () => {
    await worker?.close();
  });

  test('prepared artifacts are present and match the locked SDK', () => {
    const { python, lock } = requiredArtifacts();
    const probe = spawnSync(python, ['-E', '-s', '-c', 'import laya; print(laya.__version__)'], { encoding: 'utf8' });
    expect(probe.status).toBe(0);
    expect(probe.stdout.trim()).toBe(lock.sdk.version);
    expect(lock.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  test('the real-checkpoint fitting contract runs without skips', () => {
    const { python, modelDir } = requiredArtifacts();
    const started = Date.now();
    const run = spawnSync(python, ['-m', 'unittest', '-v', 'workers.laya.tests.test_fitting'], {
      cwd: APP_ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', BRAIN_LAYA_MODEL_DIR: modelDir, BRAIN_LAYA_REQUIRE_MODEL: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
      timeout: COLD_START_MS
    });
    log('python-fitting-contract', { status: run.status, ms: Date.now() - started });
    expect(run.status, run.stderr.slice(-4000)).toBe(0);
    expect(run.stderr).toContain('RealCheckpointFittingContractTest');
    expect(run.stderr).not.toMatch(/skipped/);
  }, COLD_START_MS);

  test('starts offline from the verified runtime copy', async () => {
    const { python, modelDir, lock } = requiredArtifacts();
    const resolved = settings(python, modelDir);
    worker = new LayaWorker({ ...layaWorkerOptions(resolved, APP_ROOT, process.env), startupTimeoutMs: COLD_START_MS });
    worker.start();
    const coldStartMs = await waitForReady(worker);
    const health = worker.health();
    log('cold-start', { ms: coldStartMs, ...memory(health.pid), runtime: health.runtime });
    expect(health.state).toBe('ready');
    expect(health.model_fingerprint).toBe(lock.runtime.fingerprint);
    expect(health.question_version).toBe('relevance-2026-09-23.1');
    expect(health.runtime).toMatchObject({ laya: lock.sdk.version, device: 'cpu', max_len: lock.checkpoint.max_len, head_max_len: lock.checkpoint.head_max_len });
  }, COLD_START_MS);

  test('scores an English smoke query', async () => {
    const active = worker as LayaWorker;
    await waitForReady(active);
    const started = Date.now();
    const result = await active.score({ request_id: 'smoke-en', query: 'How do I rebuild the search index?', candidates: english });
    log('english', { ms: Date.now() - started, ...memory(active.health().pid), scores: result.scores });
    assertFinite(result, english.map((candidate) => candidate.chunk_key), 1024);
    expect(result.scores.every((score) => !score.truncated)).toBe(true);
  }, COLD_START_MS);

  test('scores a Norwegian smoke query', async () => {
    const active = worker as LayaWorker;
    await waitForReady(active);
    const started = Date.now();
    const result = await active.score({ request_id: 'smoke-no', query: 'Hvordan bygger jeg søkeindeksen på nytt?', candidates: norwegian });
    log('norwegian', { ms: Date.now() - started, ...memory(active.health().pid), scores: result.scores });
    assertFinite(result, norwegian.map((candidate) => candidate.chunk_key), 1024);
    expect(result.scores.every((score) => !score.truncated)).toBe(true);
  }, COLD_START_MS);

  test('shortens title and context through the worker and rejects an overlong query', async () => {
    const active = worker as LayaWorker;
    await waitForReady(active);
    const title = Array.from({ length: 120 }, (_, index) => `Driftsnotat ${index}`).join(' ').slice(0, 1024);
    const heading = Array.from({ length: 120 }, (_, index) => `Seksjon ${index}`).join(' ').slice(0, 1024);
    const excerpt = Array.from({ length: 40 }, (_, index) => `Avsnitt ${index} beskriver sikkerhetskopi og gjenoppretting.`).join(' ').slice(0, 1800);
    const started = Date.now();
    const result = await active.score({
      request_id: 'fit-title',
      query: 'Hvordan gjenoppretter jeg en sikkerhetskopi?',
      candidates: [{ chunk_key: 'title#0-1800', title, heading, excerpt }]
    });
    log('title-shortening', { ms: Date.now() - started, scores: result.scores });
    assertFinite(result, ['title#0-1800'], 1024);
    expect(result.scores[0].truncated).toBe(true);
    const query = Array.from({ length: 1500 }, (_, index) => `term${index}`).join(' ').slice(0, 8000);
    const error = await active.score({ request_id: 'fit-query', query, candidates: english.slice(0, 1) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LayaWorkerError);
    expect((error as LayaWorkerError).reason).toBe('input_too_long');
    expect(active.health().state).toBe('ready');
  }, COLD_START_MS);

  test('records rechunking of an overlong excerpt against the reranker deadline', async () => {
    const active = worker as LayaWorker;
    await waitForReady(active);
    const excerpt = Array.from({ length: 200 }, (_, index) => `Avsnitt ${index} beskriver sikkerhetskopi og gjenoppretting.`).join(' ').slice(0, 3000);
    const started = Date.now();
    const outcome = await active
      .score({
        request_id: 'fit-long',
        query: 'Hvordan gjenoppretter jeg en sikkerhetskopi?',
        candidates: [{ chunk_key: 'long#0-3000', title: 'Drift', heading: 'Sikkerhetskopi', excerpt }]
      })
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const elapsed = Date.now() - started;
    if (outcome.ok) {
      log('rechunked-excerpt', { ms: elapsed, outcome: 'scored', scores: outcome.result.scores });
      assertFinite(outcome.result, ['long#0-3000'], 1024);
      expect(outcome.result.scores[0].truncated).toBe(true);
    } else {
      log('rechunked-excerpt', { ms: elapsed, outcome: 'deadline_exceeded', reason: (outcome.error as LayaWorkerError).reason });
      expect(outcome.error).toBeInstanceOf(LayaWorkerError);
      expect((outcome.error as LayaWorkerError).reason).toBe('timeout');
    }
  }, COLD_START_MS);

  test('returns normal outputs for a full model batch', async () => {
    const active = worker as LayaWorker;
    await waitForReady(active);
    const batch = Array.from({ length: 8 }, (_, index) => ({ ...english[index % 3], chunk_key: `batch-${index}#0-1` }));
    const started = Date.now();
    const result = await active.score({ request_id: 'batch-8', query: 'How do I rebuild the search index?', candidates: batch });
    log('batch-8', { ms: Date.now() - started, ...memory(active.health().pid) });
    assertFinite(result, batch.map((candidate) => candidate.chunk_key), 1024);
  }, COLD_START_MS);

  test('records the maximum candidate set against the reranker deadline', async () => {
    const active = worker as LayaWorker;
    await waitForReady(active);
    const all = Array.from({ length: LAYA_MAX_CANDIDATES }, (_, index) => ({ ...norwegian[index % 3], chunk_key: `max-${index}#0-1` }));
    const started = Date.now();
    const outcome = await active
      .score({ request_id: 'max-30', query: 'Hvordan bygger jeg søkeindeksen på nytt?', candidates: all })
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const elapsed = Date.now() - started;
    if (outcome.ok) {
      log('max-30', { ms: elapsed, outcome: 'scored', ...memory(active.health().pid) });
      assertFinite(outcome.result, all.map((candidate) => candidate.chunk_key), 1024);
    } else {
      log('max-30', { ms: elapsed, outcome: 'deadline_exceeded', reason: (outcome.error as LayaWorkerError).reason });
      expect(outcome.error).toBeInstanceOf(LayaWorkerError);
      expect((outcome.error as LayaWorkerError).reason).toBe('timeout');
      await waitForReady(active);
    }
  }, COLD_START_MS);

  test('rejects work when the worker crashes and restarts it', async () => {
    const active = worker as LayaWorker;
    await waitForReady(active);
    const pid = active.health().pid as number;
    const pending = active.score({ request_id: 'crash', query: 'How do I rebuild the search index?', candidates: english }).catch((caught: unknown) => caught);
    process.kill(pid, 'SIGKILL');
    const error = await pending;
    expect(error).toBeInstanceOf(LayaWorkerError);
    expect((error as LayaWorkerError).reason).toBe('crashed');
    expect(active.health().state).not.toBe('ready');
    const restartMs = await waitForReady(active);
    log('restart-after-crash', { ms: restartMs, restarts_in_window: active.health().restarts_in_window, ...memory(active.health().pid) });
    expect(active.health().pid).not.toBe(pid);
    const result = await active.score({ request_id: 'after-crash', query: 'How do I rebuild the search index?', candidates: english });
    assertFinite(result, english.map((candidate) => candidate.chunk_key), 1024);
  }, COLD_START_MS);

  test('close terminates the worker and rejects pending requests', async () => {
    const active = worker as LayaWorker;
    await waitForReady(active);
    const pid = active.health().pid as number;
    const pending = active.score({ request_id: 'closing', query: 'How do I rebuild the search index?', candidates: english }).catch((caught: unknown) => caught);
    await active.close();
    const error = await pending;
    expect((error as LayaWorkerError).reason).toBe('closed');
    expect(() => process.kill(pid, 0)).toThrow();
  }, COLD_START_MS);
});
