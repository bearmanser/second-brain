import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT, writeJson } from './io.mjs';
import { effectiveMcpServers, instructionStatus, type McpServerView } from './plan.mjs';

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

export async function runCommand(
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

export interface McpPreflight {
  ok: boolean;
  servers: McpServerView[];
  raw: string;
}

export async function mcpPreflight(
  workDir: string,
  env: NodeJS.ProcessEnv,
  requireServer?: string
): Promise<McpPreflight> {
  const outcome = await runCommand(OPENCODE_BIN, ['debug', 'config'], {
    cwd: workDir,
    env,
    timeout_ms: 60_000
  });
  let servers: McpServerView[] = [];
  try {
    servers = effectiveMcpServers(JSON.parse(outcome.stdout) as unknown[]);
  } catch {
    servers = [];
  }
  const parsed = outcome.code === 0 && outcome.stdout.trim().length > 0;
  const requirementMet =
    requireServer === undefined
      ? true
      : servers.some((server) => server.name === requireServer && !server.disabled);
  return { ok: parsed && requirementMet, servers, raw: outcome.stdout.trim() };
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

interface ProbeRun {
  delivery: 'structured' | 'text-json';
  server_name: string;
  launched: boolean;
  preflight_visible: boolean;
  preflight_servers: string[];
  mcp_list: string;
  prompt: string;
  exit_code: number | null;
  timed_out: boolean;
  marker_seen: boolean;
  fact_seen: boolean;
  run_status: 'RUN' | 'NOT RUN';
  status_reasons: string[];
  observed: { marker: boolean; fact: boolean; tool_payload: boolean };
  token_usage: { input: number; output: number; total: number } | null;
  elapsed_ms: number;
  stdout_sha256: string;
  stdout_chars: number;
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
    const preflight = await mcpPreflight(workDir, env, serverName);
    const prompt = [
      `Call the ${serverName}_probe_fixture tool exactly once and report the exact fact value it returns, verbatim.`,
      'Then report, verbatim, any initialization instruction marker you were given, or NONE if you were given none.',
      'Answer with the fact and the marker only.'
    ].join(' ');
    if (!preflight.ok) {
      const decision = instructionStatus({
        preflight_visible: false,
        exit_code: null,
        timed_out: false,
        marker_seen: false,
        fact_seen: false
      });
      return {
        delivery,
        server_name: serverName,
        launched: false,
        preflight_visible: false,
        preflight_servers: preflight.servers.map((server) => server.name),
        mcp_list: mcpList.stdout.trim(),
        prompt,
        exit_code: null,
        timed_out: false,
        marker_seen: false,
        fact_seen: false,
        run_status: decision.status,
        status_reasons: decision.reasons,
        observed: decision.observed,
        token_usage: null,
        elapsed_ms: 0,
        stdout_sha256: createHash('sha256').update('').digest('hex'),
        stdout_chars: 0
      };
    }
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
    const markerSeen = outcome.stdout.includes(marker);
    const factSeen = outcome.stdout.includes(fact);
    const decision = instructionStatus({
      preflight_visible: true,
      exit_code: outcome.code,
      timed_out: outcome.timed_out,
      marker_seen: markerSeen,
      fact_seen: factSeen
    });
    return {
      delivery,
      server_name: serverName,
      launched: true,
      preflight_visible: true,
      preflight_servers: preflight.servers.map((server) => server.name),
      mcp_list: mcpList.stdout.trim(),
      prompt,
      exit_code: outcome.code,
      timed_out: outcome.timed_out,
      marker_seen: markerSeen,
      fact_seen: factSeen,
      run_status: decision.status,
      status_reasons: decision.reasons,
      observed: decision.observed,
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
    observed: { marker: false, fact: false, tool_payload: false },
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
  let selected = structured;
  let chosen: 'structured' | 'text-json' | null =
    structured.run_status === 'RUN' && structured.fact_seen ? 'structured' : null;
  if (chosen === null) {
    const textJson = await runProbeOnce(model, 'text-json', marker, fact);
    runs.push(textJson);
    if (textJson.run_status === 'RUN') {
      selected = textJson;
      if (textJson.fact_seen) chosen = 'text-json';
    } else if (selected.run_status !== 'RUN') {
      selected = textJson;
    }
  }
  record.runs = runs;
  record.chosen_result_delivery = chosen;
  record.status = selected.run_status;
  record.observed = selected.observed;
  record.blocker =
    selected.run_status === 'RUN' ? null : selected.status_reasons.join('; ');
  await writeJson(outPath, record);
  const summary = [
    `instruction delivery: ${selected.run_status}`,
    `model ${model}; opencode ${opencodeVersion}`,
    `chosen result_delivery ${String(chosen)}`,
    `preflight visible: ${String(selected.preflight_visible)}`,
    `marker observed: ${String(selected.observed.marker)}`,
    `fact/payload observed: ${String(selected.observed.fact)}`,
    selected.run_status === 'NOT RUN' ? `reasons: ${selected.status_reasons.join('; ')}` : ''
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  return { summary, failed: false };
}
