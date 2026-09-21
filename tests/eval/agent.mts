import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpHarness } from '../support/harness.js';
import { makeLexicalSearch } from './lexical-backend.mjs';
import { seedCorpus, type CorpusFile, type SeedRegistry } from './seed.mjs';
import { REPO_ROOT, readJson, writeJson } from './io.mjs';
import { OPENCODE_BIN } from './instruction.mjs';

export const MAX_PILOT_RUNS = 24;
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

interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeout_ms: number }
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeout_ms);
    timer.unref?.();
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}\n`, timed_out: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timed_out: timedOut });
    });
  });
}

function extractUsage(stdout: string): { input: number; output: number; total: number } | null {
  const matches = [
    ...stdout.matchAll(
      /"(?:input|prompt)_tokens"\s*:\s*(\d+)[^}]*?"(?:output|completion)_tokens"\s*:\s*(\d+)/g
    )
  ];
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  const input = Number(last[1]);
  const output = Number(last[2]);
  return { input, output, total: input + output };
}

interface PilotRunRecord {
  run_index: number;
  task_id: string;
  repeat: number;
  memory_condition: 'enabled' | 'disabled';
  model_identifier: string;
  client_version: string;
  tool_timeline: string[];
  retrieved_memory: boolean;
  expected_signal_seen: boolean;
  outcome: 'matched' | 'missed' | 'error' | 'timeout';
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
  const cap = Math.max(0, Math.min(planned, MAX_PILOT_RUNS, budget));
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
  record.runs = runs;
  record.status = 'RUN';
  record.summary = {
    enabled_matched: matched(enabled),
    enabled_total: enabled.length,
    disabled_matched: matched(disabled),
    disabled_total: disabled.length,
    errors: runs.filter((entry) => entry.outcome === 'error' || entry.outcome === 'timeout').length
  };
  await writeJson(outPath, record);
  const summaryRecord = record.summary as Record<string, number>;
  return {
    summary: `agent pilot: RUN (${runs.length} runs); enabled matched ${summaryRecord.enabled_matched}/${summaryRecord.enabled_total}; disabled matched ${summaryRecord.disabled_matched}/${summaryRecord.disabled_total}`,
    failed: false
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
    await writeFile(
      join(workDir, 'opencode.json'),
      `${JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            servers: {
              'second-brain': {
                type: 'remote',
                url: harness.url,
                oauth: false,
                codemode: false,
                headers: { Authorization: `Bearer ${harness.token}` }
              }
            }
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await runCommand('git', ['init', '-q'], { cwd: workDir, timeout_ms: 30_000 });
    const started = Date.now();
    const outcome = await runCommand(
      OPENCODE_BIN,
      ['run', '--model', model, '--format', 'json', '--auto', task.prompt],
      { cwd: workDir, timeout_ms: AGENT_TIMEOUT_MS }
    );
    const elapsed = Date.now() - started;
    const combined = `${outcome.stdout}\n${outcome.stderr}`;
    const signalSeen = combined.toLowerCase().includes(task.expected_signal.toLowerCase());
    const recallEvents = (combined.match(/brain_recall/g) ?? []).length;
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
      retrieved_memory: recallEvents > 0,
      expected_signal_seen: signalSeen,
      outcome: outcomeLabel,
      elapsed_ms: elapsed,
      token_usage: extractUsage(combined),
      exit_code: outcome.code,
      stdout_sha256: createHash('sha256').update(combined, 'utf8').digest('hex'),
      stdout_chars: combined.length
    };
  } finally {
    await harness.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
