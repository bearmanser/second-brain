import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll } from 'vitest';
import type { Config } from '../src/config.js';
import { startGateway, type Gateway } from '../src/http.js';

export const TEST_TOKEN = 'test-token-0123456789';
export const TEST_TOKEN_SHA256 = createHash('sha256').update(TEST_TOKEN, 'utf8').digest('hex');

const created: string[] = [];
const gateways: Gateway[] = [];

afterAll(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `brain-${prefix}-`));
  created.push(dir);
  return dir;
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
    return poll();
  };
  return poll();
}

export function rawPost(
  port: number,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: { 'content-type': 'application/json', host: '127.0.0.1', ...headers }
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

export async function startTestGateway(
  vaultDir: string,
  stateDir: string,
  overrides: Partial<Config> = {}
): Promise<Gateway> {
  const gateway = await startGateway({
    tokenSha256: TEST_TOKEN_SHA256,
    vaultDir,
    stateDir,
    port: 0,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: [],
    scanIntervalMs: 100,
    ...overrides
  });
  gateways.push(gateway);
  return gateway;
}

export interface TestClient {
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  raw(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

export async function mcpClient(gateway: Gateway): Promise<TestClient> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } }
  });
  await client.connect(transport);
  const raw = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[];
    return { isError: result.isError === true, text: content.map((entry) => entry.text ?? '').join('') };
  };
  return {
    raw,
    async call(name, args = {}) {
      const result = await raw(name, args);
      if (result.isError) throw new Error(result.text);
      return JSON.parse(result.text) as Record<string, unknown>;
    },
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name).sort();
    },
    close: () => client.close()
  };
}
