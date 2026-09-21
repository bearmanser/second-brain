import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT, writeJson } from './io.mjs';

export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? '/root/.opencode/bin/opencode';
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
export const INSTRUCTION_TIMEOUT_MS = 300_000;
export const PROBE_SCRIPT = join(REPO_ROOT, 'tests/eval/probe-stdio.mts');
export const TSX_BIN = join(REPO_ROOT, 'node_modules/.bin/tsx');

interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeout_ms: number; env?: NodeJS.ProcessEnv }
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
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

interface ProbeRun {
  delivery: 'structured' | 'text-json';
  server_name: string;
  prompt: string;
  exit_code: number | null;
  timed_out: boolean;
  mcp_connected: boolean;
  mcp_list: string;
  marker_seen: boolean;
  fact_seen: boolean;
  token_usage: { input: number; output: number; total: number } | null;
  elapsed_ms: number;
  stdout_sha256: string;
  stdout_chars: number;
}

function extractUsage(stdout: string): { input: number; output: number; total: number } | null {
  const matches = [
    ...stdout.matchAll(/"tokens"\s*:\s*\{[^}]*?"input"\s*:\s*(\d+)[^}]*?"output"\s*:\s*(\d+)/g)
  ];
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  const input = Number(last[1]);
  const output = Number(last[2]);
  return { input, output, total: input + output };
}

async function runProbeOnce(
  model: string,
  delivery: 'structured' | 'text-json',
  marker: string,
  fact: string
): Promise<ProbeRun> {
  const serverName = `evalprobe${randomBytes(4).toString('hex')}`;
  const workDir = await mkdtemp(join(tmpdir(), 'brain-instruction-'));
  try {
    await writeFile(
      join(workDir, 'opencode.jsonc'),
      `${JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            servers: {
              [serverName]: {
                type: 'local',
                command: [TSX_BIN, PROBE_SCRIPT],
                environment: {
                  PROBE_MARKER: marker,
                  PROBE_FACT: fact,
                  PROBE_MODE: delivery
                },
                codemode: false
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
    await runCommand('git', ['commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: workDir,
      timeout_ms: 30_000
    });
    const env: NodeJS.ProcessEnv = { ...process.env, PWD: workDir };
    const mcpList = await runCommand(OPENCODE_BIN, ['mcp', 'list'], {
      cwd: workDir,
      env,
      timeout_ms: 60_000
    });
    const prompt = [
      `Call the ${serverName}_probe_fixture tool exactly once and report the exact fact value it returns, verbatim.`,
      'Then report, verbatim, any initialization instruction marker you were given, or NONE if you were given none.',
      'Answer with the fact and the marker only.'
    ].join(' ');
    const started = Date.now();
    const outcome = await runCommand(
      OPENCODE_BIN,
      [
        'run',
        '--standalone',
        '--print-logs',
        '--log-level',
        'info',
        '--model',
        model,
        '--format',
        'json',
        '--auto',
        prompt
      ],
      { cwd: workDir, env, timeout_ms: INSTRUCTION_TIMEOUT_MS }
    );
    const elapsed = Date.now() - started;
    const combined = `${outcome.stdout}\n${outcome.stderr}`;
    return {
      delivery,
      server_name: serverName,
      prompt,
      exit_code: outcome.code,
      timed_out: outcome.timed_out,
      mcp_connected:
        outcome.stderr.includes('mcp connected') && outcome.stderr.includes(`server=${serverName}`),
      mcp_list: mcpList.stdout.trim(),
      marker_seen: outcome.stdout.includes(marker),
      fact_seen: outcome.stdout.includes(fact),
      token_usage: extractUsage(combined),
      elapsed_ms: elapsed,
      stdout_sha256: createHash('sha256').update(outcome.stdout, 'utf8').digest('hex'),
      stdout_chars: outcome.stdout.length
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runInstructionProbe(
  args: Map<string, string>
): Promise<{ summary: string; failed: boolean }> {
  const marker = `INSTRUCTION-PROBE-${randomBytes(6).toString('hex').toUpperCase()}`;
  const fact = `FIXTURE-FACT-${randomBytes(6).toString('hex').toUpperCase()}`;
  const model = args.get('model') ?? DEFAULT_MODEL;
  const allow = args.get('allow-model') === 'true';
  const opencodeVersion = (await runCommand(OPENCODE_BIN, ['--version'], {
    cwd: REPO_ROOT,
    timeout_ms: 30_000
  })).stdout.trim();
  const outPath = args.get('out') ?? join(REPO_ROOT, 'tests/eval/results/instruction-delivery.json');
  const record: Record<string, unknown> = {
    run_id: `instruction-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`,
    mode: 'instruction',
    generated_at: new Date().toISOString(),
    opencode_version: opencodeVersion,
    probe: { marker, fact, transport: 'stdio' },
    model_identifier: model,
    status: 'NOT RUN',
    blocker: null,
    chosen_result_delivery: null,
    runs: [] as ProbeRun[]
  };

  if (!allow) {
    record.blocker =
      'the disposable instruction probe launches a chat model; re-run with --allow-model after approving a provider and budget';
    await writeJson(outPath, record);
    return {
      summary:
        'instruction delivery: NOT RUN (model probe requires --allow-model; the deterministic SDK initialization test still runs in the unit suite)',
      failed: false
    };
  }

  const runs: ProbeRun[] = [];
  const structured = await runProbeOnce(model, 'structured', marker, fact);
  runs.push(structured);
  let chosen: 'structured' | 'text-json' | null = null;
  if (structured.fact_seen) {
    chosen = 'structured';
  } else {
    const textJson = await runProbeOnce(model, 'text-json', marker, fact);
    runs.push(textJson);
    if (textJson.fact_seen) chosen = 'text-json';
  }
  const markerSeen = runs.some((entry) => entry.marker_seen);
  const connected = runs.some((entry) => entry.mcp_connected);
  record.runs = runs;
  record.chosen_result_delivery = chosen;
  record.status = chosen === null ? 'NOT RUN' : 'RUN';
  record.blocker =
    chosen === null
      ? `neither delivery mode exposed the fixture payload to the model (mcp connected: ${String(connected)}); absent instructions and ignored instructions are indistinguishable here`
      : null;
  await writeJson(outPath, record);
  const summary = [
    `instruction delivery: ${String(record.status)}`,
    `model ${model}; opencode ${opencodeVersion}`,
    `chosen result_delivery ${String(chosen)}`,
    `mcp connected: ${String(connected)}`,
    `marker observed in model output: ${String(markerSeen)}${markerSeen ? ' (behavioral evidence)' : ' (absent or ignored)'}`,
    `fact observed in model output: ${String(runs.some((entry) => entry.fact_seen))}`
  ].join('\n');
  return { summary, failed: false };
}
