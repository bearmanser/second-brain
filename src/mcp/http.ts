import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import express from 'express';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { assertTokenDigest } from '../config/load.js';
import { isBrainError } from '../contracts/errors.js';
import { INPUT_BODY_MAX_BYTES } from '../core/limits.js';
import {
  SYSTEM_ACTOR,
  type AuthenticatedContext,
  type Principal,
  type RequestContext
} from '../core/types.js';
import { authenticate, verifyBearer } from '../security/authenticate.js';
import type { BrainRuntime } from '../runtime.js';
import { createMcpServer } from './server.js';
import { internalDiagnostic } from './tools.js';

export const MCP_PATH = '/mcp';
export const OVERFLOW_DRAIN_MS = 1000;
export const MAX_AUTHORIZATION_HEADER_CHARS = 1024;

const HOST_NAME = /^[A-Za-z0-9.-]+$/;
const HOST_PORT = /^[1-9]\d{0,4}$/;
const MAX_HOST_LENGTH = 255;
const MAX_PORT = 65535;

interface Authority {
  hostname: string;
  port?: number;
}

function parseAuthority(header: string): Authority | undefined {
  if (header.length === 0 || header.length > MAX_HOST_LENGTH) return undefined;
  if (/[@/?#\s]/.test(header)) return undefined;
  const separator = header.lastIndexOf(':');
  let hostname = header;
  let port: number | undefined;
  if (separator !== -1) {
    if (header.indexOf(':') !== separator) return undefined;
    const portText = header.slice(separator + 1);
    if (!HOST_PORT.test(portText)) return undefined;
    const parsedPort = Number.parseInt(portText, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > MAX_PORT) return undefined;
    port = parsedPort;
    hostname = header.slice(0, separator);
  }
  if (hostname.length === 0 || !HOST_NAME.test(hostname)) return undefined;
  return port === undefined ? { hostname: hostname.toLowerCase() } : { hostname: hostname.toLowerCase(), port };
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  error: { code: number; message: string };
  id: null;
}

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body: JsonRpcErrorBody = { jsonrpc: '2.0', error: { code, message }, id: null };
  res.status(status).type('application/json').send(JSON.stringify(body));
}

function hostAllowed(header: string | undefined, allowed: readonly string[]): boolean {
  if (typeof header !== 'string') return false;
  const authority = parseAuthority(header);
  if (authority === undefined) return false;
  return allowed.some((entry) => entry.toLowerCase() === authority.hostname);
}

function originAllowed(header: string | undefined, allowed: readonly string[]): boolean {
  if (header === undefined || header.length === 0) return true;
  let parsed: URL;
  try {
    parsed = new URL(header);
  } catch {
    return false;
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return false;
  }
  return allowed.some((entry) => {
    try {
      return new URL(entry).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

function isJsonContentType(header: string | undefined): boolean {
  if (typeof header !== 'string') return false;
  return header.split(';')[0].trim().toLowerCase() === 'application/json';
}

type BodyRead = { ok: true; body: Buffer } | { ok: false; tooLarge: boolean };

function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        req.pause();
        finish({ ok: false, tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () =>
      finish(tooLarge ? { ok: false, tooLarge } : { ok: true, body: Buffer.concat(chunks) })
    );
    req.on('error', () => finish({ ok: false, tooLarge }));
    req.on('aborted', () => finish({ ok: false, tooLarge }));
    req.on('close', () => finish({ ok: false, tooLarge }));
  });
}

function discardRemainingBody(req: IncomingMessage): void {
  const timer = setTimeout(() => {
    req.destroy();
  }, OVERFLOW_DRAIN_MS);
  timer.unref?.();
  const stop = (): void => {
    clearTimeout(timer);
  };
  req.once('end', stop);
  req.once('error', stop);
  req.resume();
}

function resolvePrincipal(runtime: BrainRuntime, req: Request): Principal | undefined {
  try {
    return authenticate(req.headers.authorization, runtime.credentials);
  } catch (error) {
    if (isBrainError(error) && error.code === 'UNAUTHENTICATED') return undefined;
    throw error;
  }
}

async function handleMcpRequest(
  runtime: BrainRuntime,
  req: Request,
  res: Response
): Promise<void> {
  if (!hostAllowed(req.headers.host, runtime.config.allowed_hosts)) {
    sendJsonRpcError(res, 403, -32000, 'the request host is not allowed');
    return;
  }
  if (!originAllowed(req.headers.origin, runtime.config.allowed_origins)) {
    sendJsonRpcError(res, 403, -32000, 'the request origin is not allowed');
    return;
  }

  let principal: Principal | undefined;
  try {
    principal = resolvePrincipal(runtime, req);
  } catch (error) {
    runtime.services.reportDiagnostic?.(internalDiagnostic(error));
    sendJsonRpcError(res, 500, -32603, 'the gateway could not authenticate the request');
    return;
  }
  if (principal === undefined) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendJsonRpcError(res, 401, -32000, 'a valid bearer credential is required');
    return;
  }

  if (runtime.closing) {
    sendJsonRpcError(res, 503, -32000, 'the gateway is shutting down');
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJsonRpcError(res, 405, -32000, 'this stateless endpoint accepts only POST');
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    sendJsonRpcError(res, 415, -32000, 'Content-Type must be application/json');
    return;
  }

  const limit = runtime.config.limits.input_body_max_bytes ?? INPUT_BODY_MAX_BYTES;
  const raw = await readBody(req, limit);
  if (!raw.ok) {
    if (raw.tooLarge) {
      res.setHeader('Connection', 'close');
      sendJsonRpcError(res, 413, -32000, 'the request body exceeds the input limit');
      discardRemainingBody(req);
    } else {
      sendJsonRpcError(res, 400, -32700, 'the request body could not be read');
    }
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw.body.toString('utf8'));
  } catch {
    sendJsonRpcError(res, 400, -32700, 'Parse error: Invalid JSON');
    return;
  }

  const ctx: RequestContext = {
    principal,
    request_id: randomUUID(),
    signal: runtime.shutdownSignal
  };
  const server = createMcpServer(runtime.services, ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  res.on('close', () => {
    void cleanup();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    runtime.services.reportDiagnostic?.(internalDiagnostic(error));
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, 'the gateway could not complete the request');
    } else {
      try {
        res.end();
      } catch {}
    }
    await cleanup();
  }
}

export function readAuthorizationHeader(rawHeaders: readonly string[]): string | undefined {
  let count = 0;
  let value: string | undefined;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() !== 'authorization') continue;
    count += 1;
    value = rawHeaders[index + 1];
  }
  if (count > 1) return undefined;
  if (value !== undefined && value.length > MAX_AUTHORIZATION_HEADER_CHARS) return undefined;
  return value;
}

export interface AuthenticatedHttpOptions {
  token_digest: string | (() => string);
  allowed_hosts: readonly string[];
  allowed_origins: readonly string[];
  input_body_max_bytes?: number;
  signal: AbortSignal;
  isClosing?: () => boolean;
  reportDiagnostic?: (message: string) => void;
  dispatch: (
    ctx: AuthenticatedContext,
    req: Request,
    res: Response,
    parsedBody: unknown
  ) => Promise<void>;
}

function resolveTokenDigest(source: string | (() => string)): string {
  return typeof source === 'function' ? source() : source;
}

async function handleAuthenticatedRequest(
  options: AuthenticatedHttpOptions,
  req: Request,
  res: Response
): Promise<void> {
  if (!hostAllowed(req.headers.host, options.allowed_hosts)) {
    sendJsonRpcError(res, 403, -32000, 'the request host is not allowed');
    return;
  }
  if (!originAllowed(req.headers.origin, options.allowed_origins)) {
    sendJsonRpcError(res, 403, -32000, 'the request origin is not allowed');
    return;
  }

  const authorization = readAuthorizationHeader(req.rawHeaders);
  if (authorization === undefined || !verifyBearer(authorization, resolveTokenDigest(options.token_digest))) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendJsonRpcError(res, 401, -32000, 'a valid bearer credential is required');
    return;
  }

  if (options.isClosing?.() === true) {
    sendJsonRpcError(res, 503, -32000, 'the gateway is shutting down');
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJsonRpcError(res, 405, -32000, 'this stateless endpoint accepts only POST');
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    sendJsonRpcError(res, 415, -32000, 'Content-Type must be application/json');
    return;
  }

  const limit = options.input_body_max_bytes ?? INPUT_BODY_MAX_BYTES;
  const raw = await readBody(req, limit);
  if (!raw.ok) {
    if (raw.tooLarge) {
      res.setHeader('Connection', 'close');
      sendJsonRpcError(res, 413, -32000, 'the request body exceeds the input limit');
      discardRemainingBody(req);
    } else {
      sendJsonRpcError(res, 400, -32700, 'the request body could not be read');
    }
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw.body.toString('utf8'));
  } catch {
    sendJsonRpcError(res, 400, -32700, 'Parse error: Invalid JSON');
    return;
  }

  const ctx: AuthenticatedContext = {
    actor: SYSTEM_ACTOR,
    request_id: randomUUID(),
    signal: options.signal
  };
  await options.dispatch(ctx, req, res, parsedBody);
}

export function createAuthenticatedHttpApp(options: AuthenticatedHttpOptions): Express {
  assertTokenDigest(resolveTokenDigest(options.token_digest));
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.all(MCP_PATH, (req: Request, res: Response): void => {
    void handleAuthenticatedRequest(options, req, res).catch((error: unknown) => {
      options.reportDiagnostic?.(internalDiagnostic(error));
      sendJsonRpcError(res, 500, -32603, 'the gateway could not complete the request');
    });
  });

  app.use((_req: Request, res: Response): void => {
    res.status(404).type('application/json').send(JSON.stringify({ error: 'not found' }));
  });

  return app;
}

export function createHttpApp(runtime: BrainRuntime): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.all(MCP_PATH, (req: Request, res: Response): void => {
    void handleMcpRequest(runtime, req, res).catch((error: unknown) => {
      runtime.services.reportDiagnostic?.(internalDiagnostic(error));
      sendJsonRpcError(res, 500, -32603, 'the gateway could not complete the request');
    });
  });

  app.use((_req: Request, res: Response): void => {
    res.status(404).type('application/json').send(JSON.stringify({ error: 'not found' }));
  });

  return app;
}
