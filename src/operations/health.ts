import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrainConfig } from '../config/schema.js';
import { BACKEND_TIMEOUT_MS } from '../core/limits.js';

export interface HealthOptions {
  token?: string;
  token_file?: string;
  timeout_ms?: number;
  onDiagnostic?: (message: string) => void;
}

const HEALTH_TOKEN_ENV = 'BRAIN_HEALTH_TOKEN';
const LITERAL_TOKEN_ENV = 'BRAIN_TOKEN';

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

export function resolveHealthToken(options: HealthOptions = {}): string | undefined {
  if (options.token !== undefined && options.token.length > 0) return options.token.trim();
  const configured = options.token_file ?? process.env[HEALTH_TOKEN_ENV];
  if (configured !== undefined && configured.length > 0) {
    if (looksLikePath(configured)) {
      try {
        const value = readFileSync(configured, 'utf8').trim();
        if (value.length > 0) return value;
      } catch {
        return undefined;
      }
    } else {
      return configured.trim();
    }
  }
  const literal = process.env[LITERAL_TOKEN_ENV];
  if (literal !== undefined && literal.length > 0) return literal.trim();
  return undefined;
}

interface StatusEnvelope {
  health?: { gateway?: unknown; backend?: unknown; index?: unknown; worker?: unknown };
  local?: { worker?: { state?: unknown }; index?: { state?: unknown } };
}

function readStatus(result: unknown): StatusEnvelope | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const record = result as { structuredContent?: unknown; content?: unknown };
  if (typeof record.structuredContent === 'object' && record.structuredContent !== null) {
    return record.structuredContent as StatusEnvelope;
  }
  if (Array.isArray(record.content)) {
    for (const entry of record.content) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { type?: unknown }).type === 'text' &&
        typeof (entry as { text?: unknown }).text === 'string'
      ) {
        try {
          return JSON.parse((entry as { text: string }).text) as StatusEnvelope;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export async function health(
  config: BrainConfig,
  options: HealthOptions = {}
): Promise<boolean> {
  const diagnostic = options.onDiagnostic ?? ((): void => undefined);
  const token = resolveHealthToken(options);
  if (token === undefined) {
    diagnostic('no health token is configured');
    return false;
  }
  const timeout = options.timeout_ms ?? BACKEND_TIMEOUT_MS;
  const client = new Client({ name: 'second-brain-health', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  try {
    await client.connect(transport, { timeout });
    const result = await client.callTool(
      { name: 'brain_status', arguments: {} },
      undefined,
      { timeout }
    );
    if ((result as { isError?: unknown }).isError === true) {
      diagnostic('the gateway reported a tool error for brain_status');
      return false;
    }
    const status = readStatus(result);
    const gateway = status?.health?.gateway;
    const backend = status?.health?.backend;
    const localIndex = status?.health?.index;
    if (gateway !== 'ready') {
      diagnostic(`the gateway is not ready (${String(gateway ?? 'unknown')})`);
      return false;
    }
    if (localIndex !== undefined) {
      if (localIndex !== 'ready') {
        diagnostic(`the local index is not ready (${String(localIndex)})`);
        return false;
      }
      return true;
    }
    if (status?.local !== undefined) {
      const index = status.local.index?.state;
      if (index !== undefined && index !== 'ready') {
        diagnostic(`the local index is not ready (${String(index)})`);
        return false;
      }
      return true;
    }
    if (backend !== 'ready') {
      diagnostic(`the backend is not ready (${String(backend ?? 'unknown')})`);
      return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostic(`the health check failed: ${message}`);
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}
