import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import express from 'express';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isBrainError } from '../contracts/errors.js';
import { INPUT_BODY_MAX_BYTES } from '../core/limits.js';
import type { Principal, RequestContext } from '../core/types.js';
import { authenticate } from '../security/authenticate.js';
import type { BrainRuntime } from '../runtime.js';
import { createMcpServer } from './server.js';
import { internalDiagnostic } from './tools.js';

export const MCP_PATH = '/mcp';

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
  if (typeof header !== 'string' || header.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((entry) => entry.toLowerCase() === hostname);
}

function originAllowed(header: string | undefined, allowed: readonly string[]): boolean {
  if (header === undefined || header.length === 0) return true;
  let normalized: string;
  try {
    normalized = new URL(header).origin;
  } catch {
    return false;
  }
  return allowed.some((entry) => {
    try {
      return new URL(entry).origin === normalized;
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

function resolvePrincipal(runtime: BrainRuntime, req: Request): Principal | undefined {
  try {
    return authenticate(req.headers.authorization, runtime.credentials);
  } catch (error) {
    if (isBrainError(error) && error.code === 'UNAUTHENTICATED') return undefined;
    throw error;
  }
}

export function createHttpApp(runtime: BrainRuntime): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.all(MCP_PATH, (req: Request, res: Response): void => {
    void (async (): Promise<void> => {
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
          sendJsonRpcError(res, 413, -32000, 'the request body exceeds the input limit');
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
    })().catch((error: unknown) => {
      runtime.services.reportDiagnostic?.(internalDiagnostic(error));
      sendJsonRpcError(res, 500, -32603, 'the gateway could not complete the request');
    });
  });

  app.use((_req: Request, res: Response): void => {
    res.status(404).type('application/json').send(JSON.stringify({ error: 'not found' }));
  });

  return app;
}
