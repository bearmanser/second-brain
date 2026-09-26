#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { generateBearerToken, sha256Hex } from './auth.js';
import { loadConfig } from './config.js';
import { startGateway } from './http.js';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [command, ...args] = argv;
  if (command === 'token') {
    if (args[0] === 'digest') {
      const token = readFileSync(0, 'utf8').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
      if (token === undefined) {
        console.error('pass the token on stdin: printf %s "$TOKEN" | second-brain token digest');
        process.exitCode = 1;
        return;
      }
      console.log(sha256Hex(token));
      return;
    }
    const { token, token_sha256 } = generateBearerToken();
    console.log(`token:         ${token}`);
    console.log(`token_sha256:  ${token_sha256}`);
    return;
  }
  if (command !== undefined && command !== 'serve') {
    console.error(`unknown command: ${command}`);
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(env);
  const gateway = await startGateway(config);
  console.log(JSON.stringify({ event: 'ready', url: gateway.url, state: config.stateDir, scan_interval_ms: config.scanIntervalMs }));
  const shutdown = (): void => {
    void gateway.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
