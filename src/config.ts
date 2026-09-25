export interface Config {
  tokenSha256: string;
  vaultDir: string;
  stateDir: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  scanIntervalMs: number;
}

const DIGEST = /^[a-f0-9]{64}$/;

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === '') return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function integer(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

function origins(value: string | undefined): string[] {
  const entries = list(value, []);
  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(`BRAIN_ALLOWED_ORIGINS entry is not a URL: ${entry}`);
    }
    if (parsed.origin !== entry) throw new Error(`BRAIN_ALLOWED_ORIGINS entry must be a bare origin: ${entry}`);
  }
  return entries;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const token = env.BRAIN_TOKEN_SHA256 ?? '';
  if (!DIGEST.test(token)) {
    throw new Error('BRAIN_TOKEN_SHA256 must be the lowercase hex SHA-256 of the bearer token');
  }
  return {
    tokenSha256: token,
    vaultDir: env.BRAIN_VAULT_DIR || '/vault',
    stateDir: env.BRAIN_STATE_DIR || '/var/lib/second-brain',
    port: integer('BRAIN_PORT', env.BRAIN_PORT, 7331, 0, 65535),
    allowedHosts: list(env.BRAIN_ALLOWED_HOSTS, ['127.0.0.1', 'localhost']).map((host) => host.toLowerCase()),
    allowedOrigins: origins(env.BRAIN_ALLOWED_ORIGINS),
    scanIntervalMs: integer('BRAIN_SCAN_INTERVAL_MS', env.BRAIN_SCAN_INTERVAL_MS, 30000, 100, 86_400_000)
  };
}
