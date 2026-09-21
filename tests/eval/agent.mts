import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpHarness } from '../support/harness.js';
import { makeLexicalSearch } from './lexical-backend.mjs';
import { seedCorpus, type CorpusFile, type SeedRegistry } from './seed.mjs';
import { REPO_ROOT, readJson, writeJson } from './io.mjs';
import { OPENCODE_BIN, mcpPreflight, runCommand } from './instruction.mjs';
import { MAX_PILOT_RUNS, disabledIsolationOk, pilotOutcome, planPilotRuns } from './plan.mjs';

export { MAX_PILOT_RUNS };
export const AGENT_TIMEOUT_MS = 420_000;

interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  expected_signal: string;
  memory_keys: string[];
}

interface TaskFile {
  version: number;
  tasks: AgentTask[];
}

function extractUsage(stdout: string): { input: number; output: number; total: number } | null {
  const matches = [
    ...stdout.matchAll(
      /"tokens"\s*:\s*\{[^}]*?"input"\s*:\s*(\d+)[^}]*?"output"\s*:\s*(\d+)/g
    )
  ];
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  const input = Number(last[1]);
  const output = Number(last[2]);
  return { input, output, total: input + output };
}

function collectItemIds(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectItemIds(entry, found);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  const items = record.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item === 'object' && item !== null) {
        const id = (item as Record<string, unknown>).id;
        if (typeof id === 'string') found.add(id);
      }
    }
  }
  for (const entry of Object.values(record)) collectItemIds(entry, found);
}

export function parseRetrievedIds(stdout: string): string[] {
  const found = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const part = (event as { part?: { tool?: unknown; state?: { output?: unknown } } }).part;
    if (typeof part?.tool !== 'string' || !part.tool.includes('brain_recall')) continue;
    const output = part.state?.output;
    let parsed: unknown = output;
    if (typeof output === 'string') {
      try {
        parsed = JSON.parse(output);
      } catch {
        parsed = output;
      }
    }
    collectItemIds(parsed, found);
  }
  return [...found];
}

interface PilotRunRecord {
  run_index: number;
  task_id: string;
  repeat: number;
  memory_condition: 'enabled' | 'disabled';
  model_identifier: string;
  client_version: string;
  tool_timeline: string[];
  retrieved_ids: string[];
  retrieved_memory: boolean;
  expected_signal_seen: boolean;
  isolation_ok: boolean;
  mcp_launched: boolean;
  preflight_servers: string[];
  outcome: 'matched' | 'missed' | 'error' | 'timeout' | 'invalid_isolation';
  elapsed_ms: number;
  token_usage: { input: number; output: number; total: number } | null;
  exit_code: number | null;
  stdout_sha256: string;
  stdout_chars: number;
}

export async function runAgentPilot(
  args: Map<string, string>
): Promise<{ summary: string; failed: boolean }> {
  const corpusPath = args.get('corpus') ?? join(REPO_ROOT, 'tests/eval/corpus.json');
  const tasksPath = args.get('tasks') ?? join(REPO_ROOT, 'tests/eval/tasks.json');
  const outPath = args.get('out') ?? join(REPO_ROOT, 'tests/eval/results/agent.json');
  const corpus = await readJson<CorpusFile>(corpusPath);
  const taskFile = await readJson<TaskFile>(tasksPath);
  const model = args.get('model');
  const allow = args.get('allow-model') === 'true';
  const repeats = Number(args.get('repeats') ?? '2');
  const budget = Number(args.get('budget') ?? String(MAX_PILOT_RUNS));
  const planned = taskFile.tasks.length * repeats * 2;
  const cap = planPilotRuns(taskFile.tasks.length, repeats, budget);
  const opencodeVersion = (await runCommand(OPENCODE_BIN, ['--version'], {
    cwd: REPO_ROOT,
    timeout_ms: 30_000
  })).stdout.trim();

  const record: Record<string, unknown> = {
    run_id: `agent-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`,
    mode: 'agent',
    generated_at: new Date().toISOString(),
    opencode_version: opencodeVersion,
    model_identifier: model ?? null,
    planned_runs: planned,
    capped_runs: cap,
    repeats,
    status: 'NOT RUN',
    blocker: null,
    summary: null,
    runs: [] as PilotRunRecord[]
  };

  if (!allow || model === undefined || model.length === 0) {
    record.blocker = 'the paired agent pilot requires an approved model and budget: pass --allow-model --model <provider/model> after approval';
    await writeJson(outPath, record);
    return {
      summary:
        'agent pilot: NOT RUN (requires --allow-model --model <provider/model>; the configured free provider rejects its API key and the paid provider is not approved)',
      failed: false
    };
  }

  const runs: PilotRunRecord[] = [];
  let index = 0;
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const task of taskFile.tasks) {
      const order: Array<'enabled' | 'disabled'> =
        (repeat + task.id.length) % 2 === 0 ? ['enabled', 'disabled'] : ['disabled', 'enabled'];
      for (const condition of order) {
        if (index >= cap) break;
        runs.push(await runOne(model, task, condition, repeat, index, corpus, opencodeVersion));
        index += 1;
      }
    }
  }

  const enabled = runs.filter((entry) => entry.memory_condition === 'enabled');
  const disabled = runs.filter((entry) => entry.memory_condition === 'disabled');
  const matched = (entries: PilotRunRecord[]): number =>
    entries.filter((entry) => entry.outcome === 'matched').length;
  const aggregate = pilotOutcome(runs);
  record.runs = runs;
  record.status = aggregate.status;
  record.failed = aggregate.failed;
  record.blocker = aggregate.reasons.length > 0 ? aggregate.reasons.join('; ') : null;
  record.summary = {
    enabled_matched: matched(enabled),
    enabled_total: enabled.length,
    disabled_matched: matched(disabled),
    disabled_total: disabled.length,
    errors: runs.filter(
      (entry) => entry.outcome === 'error' || entry.outcome === 'timeout'
    ).length,
    invalid_isolation: runs.filter((entry) => entry.outcome === 'invalid_isolation').length
  };
  await writeJson(outPath, record);
  const summaryRecord = record.summary as Record<string, number>;
  const invalidNote =
    aggregate.failed && record.blocker !== null ? `; ${String(record.blocker)}` : '';
  return {
    summary: `agent pilot: ${aggregate.status} (${runs.length} runs); enabled matched ${summaryRecord.enabled_matched}/${summaryRecord.enabled_total}; disabled matched ${summaryRecord.disabled_matched}/${summaryRecord.disabled_total}${invalidNote}`,
    failed: aggregate.failed
  };
}

async function runOne(
  model: string,
  task: AgentTask,
  condition: 'enabled' | 'disabled',
  repeat: number,
  runIndex: number,
  corpus: CorpusFile,
  opencodeVersion: string
): Promise<PilotRunRecord> {
  const harness = await startHttpHarness();
  const workDir = await mkdtemp(join(tmpdir(), 'brain-agent-'));
  try {
    harness.backend.search = makeLexicalSearch(harness.backend.root);
    if (condition === 'enabled') {
      const registry: SeedRegistry = { by_id: new Map(), by_key: new Map(), timeline: [] };
      await seedCorpus(harness, corpus, registry, { keys: task.memory_keys });
    }
    const writeConfig = async (servers: Record<string, unknown>): Promise<void> => {
      await writeFile(
        join(workDir, 'opencode.json'),
        `${JSON.stringify(
          { $schema: 'https://opencode.ai/config.json', mcp: { servers } },
          null,
          2
        )}\n`,
        'utf8'
      );
    };
    const ownServer: Record<string, unknown> = {
      type: 'remote',
      url: harness.url,
      oauth: false,
      codemode: false,
      headers: { Authorization: `Bearer ${harness.token}` }
    };
    await writeConfig(condition === 'enabled' ? { 'second-brain': ownServer } : {});
    await runCommand('git', ['init', '-q'], { cwd: workDir, timeout_ms: 30_000 });
    await runCommand('git', ['commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: workDir,
      timeout_ms: 30_000
    });
    const env: NodeJS.ProcessEnv = { ...process.env, PWD: workDir };
    const inherited = await mcpPreflight(workDir, env);
    if (condition === 'disabled') {
      const overrides: Record<string, unknown> = {};
      for (const server of inherited.servers) {
        overrides[server.name] = {
          type: 'remote',
          url: 'http://127.0.0.1:1/mcp',
          oauth: false,
          disabled: true
        };
      }
      if (Object.keys(overrides).length > 0) {
        await writeConfig(overrides);
      }
    }
    const preflight = await mcpPreflight(
      workDir,
      env,
      condition === 'enabled' ? 'second-brain' : undefined
    );
    const isolation =
      condition === 'enabled'
        ? { ok: preflight.ok, enabled: [] as string[] }
        : disabledIsolationOk(preflight.servers);
    const isolationOk = preflight.ok && isolation.ok;
    const preflightServers = preflight.servers.map(
      (server) => `${server.name}${server.disabled ? ' (disabled)' : ''}`
    );
    if (!isolationOk) {
      return {
        run_index: runIndex,
        task_id: task.id,
        repeat,
        memory_condition: condition,
        model_identifier: model,
        client_version: `opencode ${opencodeVersion}`,
        tool_timeline: [],
        retrieved_ids: [],
        retrieved_memory: false,
        expected_signal_seen: false,
        isolation_ok: false,
        mcp_launched: false,
        preflight_servers: preflightServers,
        outcome: 'invalid_isolation',
        elapsed_ms: 0,
        token_usage: null,
        exit_code: null,
        stdout_sha256: createHash('sha256').update('').digest('hex'),
        stdout_chars: 0
      };
    }
    const started = Date.now();
    const outcome = await runCommand(
      OPENCODE_BIN,
      ['run', '--standalone', '--model', model, '--format', 'json', '--auto', task.prompt],
      { cwd: workDir, env, timeout_ms: AGENT_TIMEOUT_MS }
    );
    const elapsed = Date.now() - started;
    const combined = `${outcome.stdout}\n${outcome.stderr}`;
    const signalSeen = combined.toLowerCase().includes(task.expected_signal.toLowerCase());
    const retrievedIds = parseRetrievedIds(outcome.stdout);
    const recallEvents = (outcome.stdout.match(/brain_recall/g) ?? []).length;
    const outcomeLabel: PilotRunRecord['outcome'] = outcome.timed_out
      ? 'timeout'
      : outcome.code !== 0
        ? 'error'
        : signalSeen
          ? 'matched'
          : 'missed';
    return {
      run_index: runIndex,
      task_id: task.id,
      repeat,
      memory_condition: condition,
      model_identifier: model,
      client_version: `opencode ${opencodeVersion}`,
      tool_timeline: recallEvents > 0 ? ['brain_recall'] : [],
      retrieved_ids: retrievedIds,
      retrieved_memory: retrievedIds.length > 0 || recallEvents > 0,
      expected_signal_seen: signalSeen,
      isolation_ok: true,
      mcp_launched: true,
      preflight_servers: preflightServers,
      outcome: outcomeLabel,
      elapsed_ms: elapsed,
      token_usage: extractUsage(combined),
      exit_code: outcome.code,
      stdout_sha256: createHash('sha256').update(outcome.stdout, 'utf8').digest('hex'),
      stdout_chars: outcome.stdout.length
    };
  } finally {
    await harness.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
