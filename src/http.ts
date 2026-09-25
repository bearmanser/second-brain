import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type Request, type Response } from 'express';
import { openBrain, type Brain } from './app.js';
import { verifyBearer } from './auth.js';
import type { Config } from './config.js';
import { createMcpServer } from './mcp/tools.js';
import { LIMITS, VERSION } from './types.js';

export const MCP_PATH = '/mcp';
const SESSION_ID_HEADER = 'mcp-session-id';

function hostOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const value = header.trim().toLowerCase();
  if (value.length === 0) return null;
  return value.startsWith('[') ? value : (value.split(':')[0] ?? null);
}

function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin === '') return true;
  if (allowed.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const normalized = parsed.origin.toLowerCase();
  return allowed.some((entry) => entry.toLowerCase() === normalized);
}

export function createApp(brain: Brain, config: Config): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', version: VERSION, notes: brain.index.all().length });
  });

  const guard = (req: Request, res: Response, next: () => void): void => {
    const host = hostOf(req.headers.host);
    if (host === null || !config.allowedHosts.includes(host)) {
      res.status(403).json({ error: 'forbidden host' });
      return;
    }
    if (!originAllowed(req.headers.origin, config.allowedOrigins)) {
      res.status(403).json({ error: 'forbidden origin' });
      return;
    }
    if (!verifyBearer(req.headers.authorization, config.tokenSha256)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  const rpc = async (req: Request, res: Response): Promise<void> => {
    const session = req.headers[SESSION_ID_HEADER];
    if (typeof session === 'string' && session.length > 0) {
      res.status(404).json({ error: 'no such session' });
      return;
    }
    const server = createMcpServer(brain);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      onsessionclosed: () => {
        void transport.close();
        void server.close();
      }
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(JSON.stringify({ event: 'mcp_error', message: error instanceof Error ? error.message : String(error) }));
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  };

  app.post(MCP_PATH, guard, express.json({ limit: LIMITS.requestBodyBytes }), rpc);
  app.get(MCP_PATH, guard, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' });
  });
  app.delete(MCP_PATH, guard, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'method not allowed' });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
    const status = (error as { status?: number } | null)?.status ?? 500;
    if (!res.headersSent) {
      const code = status === 413 ? 413 : status === 400 ? 400 : 500;
      res.status(code).json({ error: code === 413 ? 'payload too large' : code === 400 ? 'invalid JSON body' : 'internal error' });
    }
  });
  return app;
}

export interface Gateway {
  url: string;
  port: number;
  brain: Brain;
  close(): Promise<void>;
}

export async function startGateway(config: Config): Promise<Gateway> {
  mkdirSync(config.vaultDir, { recursive: true });
  const brain = openBrain(config);
  const server: Server = createServer(createApp(brain, config));
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(config.port, '0.0.0.0', () => {
        server.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    brain.close();
    throw error;
  }
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : config.port;
  const scan = setInterval(() => {
    try {
      brain.sync.scan();
    } catch (error) {
      console.error(JSON.stringify({ event: 'scan_error', message: error instanceof Error ? error.message : String(error) }));
    }
  }, config.scanIntervalMs);
  scan.unref?.();
  console.log(JSON.stringify({ event: 'listening', port, vault: config.vaultDir }));
  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    port,
    brain,
    close: async () => {
      clearInterval(scan);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      brain.close();
    }
  };
}
