import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WORK_ROOT = '/tmp/opencode';

let workDir = '';
let fakeBin = '';
let fakeLog = '';
let vault = '';
let destination = '';

function runBackup(env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const result = spawnSync('bash', [join(workDir, 'scripts', 'backup.sh'), destination, '--yes'], {
    encoding: 'utf8',
    cwd: workDir,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      COMPOSE_PROJECT_NAME: 'backupfix',
      VAULT_PATH: vault,
      DOCKER_FAKE_LOG: fakeLog,
      ...env
    }
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

beforeAll(() => {
  workDir = mkdtempSync(join(WORK_ROOT, 'backup-script-stop-'));
  mkdirSync(join(workDir, 'scripts'));
  mkdirSync(join(workDir, 'config'));
  cpSync(join(REPO_ROOT, 'scripts', 'backup.sh'), join(workDir, 'scripts', 'backup.sh'));
  cpSync(join(REPO_ROOT, 'config', 'images.env'), join(workDir, 'config', 'images.env'));

  fakeBin = join(workDir, 'bin');
  mkdirSync(fakeBin);
  fakeLog = join(workDir, 'docker.log');
  writeFileSync(fakeLog, '', 'utf8');
  const fakeDocker = join(fakeBin, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "\$*" >> "\${DOCKER_FAKE_LOG:?}"
command="\${1:-}"
if [ "\$command" = "compose" ]; then
  shift
  while [ \$# -gt 0 ] && [ "\$1" != "config" ] && [ "\$1" != "ps" ] && [ "\$1" != "stop" ] && [ "\$1" != "up" ]; do
    shift
  done
  subcommand="\${1:-}"
  case "\$subcommand" in
    config) printf 'brain-state\\n'; exit 0 ;;
    ps) printf 'fixture-container\\n'; exit 0 ;;
    stop)
      shift
      for service in "\$@"; do
        if [ "\$service" = "memory" ]; then
          printf 'no such service: memory\\n' >&2
          exit 1
        fi
      done
      exit 0 ;;
    up) exit 0 ;;
  esac
  exit 0
fi
if [ "\$command" = "volume" ]; then
  printf 'fixture_brain-state\\n'
  exit 0
fi
if [ "\$command" = "image" ]; then
  exit 1
fi
exit 0
`,
    'utf8'
  );
  chmodSync(fakeDocker, 0o755);

  vault = join(workDir, 'vault');
  mkdirSync(vault);
  writeFileSync(join(vault, 'note.md'), '# Fixture note\n', 'utf8');
  destination = join(workDir, 'cold-backup');
});

afterAll(() => {
  if (workDir.length > 0) rmSync(workDir, { recursive: true, force: true });
});

describe('scripts/backup.sh single-container stop logic', () => {
  test('stops only the brain service and does not request the retired memory service', () => {
    const result = runBackup({});

    expect(result.output, result.output).toMatch(/stopping the brain service/);
    expect(result.output, result.output).toMatch(/the second-brain:local image is required/);
    expect(result.output, result.output).not.toMatch(/no such service/);

    const log = String(spawnSync('cat', [fakeLog], { encoding: 'utf8' }).stdout ?? '');
    expect(log).toMatch(/^compose -p backupfix stop brain$/m);
    expect(log).not.toMatch(/stop brain memory/);
    expect(log).not.toMatch(/\bmemory\b/);
    expect(log).toMatch(/^compose -p backupfix up -d$/m);

    expect(result.status, result.output).not.toBe(0);
    expect(existsSync(destination)).toBe(false);
  });
});
