import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { expect, test } from 'vitest';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { INPUT_BODY_MAX_BYTES } from '../../src/core/limits.js';
import { startHttpHarness, type HttpHarness } from '../support/harness.js';

interface RawResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function raw(
  h: HttpHarness,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<RawResult> {
  return new Promise<RawResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: h.port,
        method: options.method ?? 'POST',
        path: options.path ?? '/mcp',
        headers: options.headers ?? {}
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

function authenticated(h: HttpHarness, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${h.token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra
  };
}

test('a request without a bearer credential is rejected', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: rpc
    });
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Bearer');
    expect(response.text).not.toContain('second-brain');
  } finally {
    await h.close();
  }
});

test('an incorrect bearer credential is rejected', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      headers: authenticated(h, { authorization: 'Bearer not-the-right-token' }),
      body: rpc
    });
    expect(response.status).toBe(401);
  } finally {
    await h.close();
  }
});

test('a malformed authorization header is rejected', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      headers: authenticated(h, { authorization: 'Basic dXNlcjpwYXNz' }),
      body: rpc
    });
    expect(response.status).toBe(401);
  } finally {
    await h.close();
  }
});

test('an unauthenticated GET is authenticated before the method is considered', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, { method: 'GET' });
    expect(response.status).toBe(401);
  } finally {
    await h.close();
  }
});

test('GET streaming is rejected with a stateless method response', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      method: 'GET',
      headers: { authorization: `Bearer ${h.token}`, accept: 'text/event-stream' }
    });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
  } finally {
    await h.close();
  }
});

test('DELETE session termination is rejected with a stateless method response', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${h.token}` }
    });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
  } finally {
    await h.close();
  }
});

test('the pinned client accepts the stateless DELETE rejection', async () => {
  const h = await startHttpHarness();
  try {
    const transport = new StreamableHTTPClientTransport(new URL(h.url), {
      sessionId: 'stateless-session',
      requestInit: { headers: { Authorization: `Bearer ${h.token}` } }
    });
    await expect(transport.terminateSession()).resolves.toBeUndefined();
  } finally {
    await h.close();
  }
});

test('a legacy SSE endpoint is not published', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      method: 'GET',
      path: '/sse',
      headers: { authorization: `Bearer ${h.token}`, accept: 'text/event-stream' }
    });
    expect(response.status).toBe(404);
  } finally {
    await h.close();
  }
});

test('an unsupported content type is rejected before dispatch', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      headers: authenticated(h, { 'content-type': 'text/plain' }),
      body: rpc
    });
    expect(response.status).toBe(415);
  } finally {
    await h.close();
  }
});

test('malformed JSON is rejected as a parse error', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, { headers: authenticated(h), body: '{"jsonrpc":' });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text).error.code).toBe(-32700);
  } finally {
    await h.close();
  }
});

test('malformed JSON-RPC is rejected by the protocol layer', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      headers: authenticated(h),
      body: JSON.stringify({ hello: 'world' })
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text).error.code).toBe(-32700);
  } finally {
    await h.close();
  }
});

test('an oversized request body is rejected at the input limit', async () => {
  const h = await startHttpHarness();
  try {
    const padding = 'x'.repeat(INPUT_BODY_MAX_BYTES + 1024);
    const response = await raw(h, {
      headers: authenticated(h),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { padding } })
    });
    expect(response.status).toBe(413);
  } finally {
    await h.close();
  }
});

test('an oversized streaming body is rejected before the sender finishes', async () => {
  const h = await startHttpHarness();
  try {
    const outcome = await new Promise<{ status: number; elapsed: number }>((resolve, reject) => {
      const started = Date.now();
      const timer = setTimeout(() => {
        reject(new Error('no response before the sender finished'));
      }, 4000);
      const req = httpRequest(
        { host: '127.0.0.1', port: h.port, method: 'POST', path: '/mcp', headers: authenticated(h) },
        (res) => {
          res.resume();
          res.on('end', () => {
            clearTimeout(timer);
            req.destroy();
            resolve({ status: res.statusCode ?? 0, elapsed: Date.now() - started });
          });
        }
      );
      req.on('error', () => undefined);
      const chunk = 'x'.repeat(64 * 1024);
      let written = 0;
      const pump = (): void => {
        if (written >= 5) return;
        written += 1;
        req.write(chunk);
        setTimeout(pump, 10);
      };
      pump();
    });
    expect(outcome.status).toBe(413);
    expect(outcome.elapsed).toBeLessThan(3000);
  } finally {
    await h.close();
  }
});

test('a POST without the SSE accept type is rejected by the SDK transport', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      headers: authenticated(h, { accept: 'application/json' }),
      body: rpc
    });
    expect(response.status).toBe(406);
  } finally {
    await h.close();
  }
});

test('a malicious Host header is rejected', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      headers: authenticated(h, { host: 'evil.example' }),
      body: rpc
    });
    expect(response.status).toBe(403);
  } finally {
    await h.close();
  }
});

test('a Host header with prohibited authority syntax is rejected', async () => {
  const h = await startHttpHarness();
  const malformed = [
    'attacker@localhost',
    'localhost/path',
    'localhost?x=1',
    'localhost:80:90',
    'local host'
  ];
  try {
    for (const host of malformed) {
      const response = await raw(h, {
        headers: authenticated(h, { host }),
        body: rpc
      });
      expect(response.status, `host=${host}`).toBe(403);
    }
  } finally {
    await h.close();
  }
});

test('a Host header with an invalid port is rejected', async () => {
  const h = await startHttpHarness();
  const malformed = [
    'localhost:',
    'localhost:+80',
    'localhost:08x',
    'localhost:0',
    'localhost:08',
    'localhost:99999',
    'localhost:65536'
  ];
  try {
    for (const host of malformed) {
      const response = await raw(h, {
        headers: authenticated(h, { host }),
        body: rpc
      });
      expect(response.status, `host=${host}`).toBe(403);
    }
  } finally {
    await h.close();
  }
});

test('a Host header carrying a port is matched by hostname', async () => {
  const h = await startHttpHarness();
  try {
    const response = await raw(h, {
      headers: authenticated(h, { host: `127.0.0.1:${h.port}` }),
      body: rpc
    });
    expect(response.status).toBe(200);
  } finally {
    await h.close();
  }
});

test('an Origin with userinfo or a path is rejected', async () => {
  const h = await startHttpHarness({ allowed_origins: ['https://allowed.example'] });
  const malformed = [
    'https://user:secret@allowed.example',
    'https://allowed.example/path',
    'https://allowed.example?x=1',
    'https://allowed.example#fragment'
  ];
  try {
    for (const origin of malformed) {
      const response = await raw(h, {
        headers: authenticated(h, { origin }),
        body: rpc
      });
      expect(response.status, `origin=${origin}`).toBe(403);
    }
  } finally {
    await h.close();
  }
});

test('an unapproved Origin header is rejected', async () => {
  const h = await startHttpHarness({ allowed_origins: ['https://allowed.example'] });
  try {
    const response = await raw(h, {
      headers: authenticated(h, { origin: 'https://evil.example' }),
      body: rpc
    });
    expect(response.status).toBe(403);
  } finally {
    await h.close();
  }
});

test('an approved Origin is allowed and no wildcard CORS header is installed', async () => {
  const h = await startHttpHarness({ allowed_origins: ['https://allowed.example'] });
  try {
    const response = await raw(h, {
      headers: authenticated(h, { origin: 'https://allowed.example' }),
      body: rpc
    });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  } finally {
    await h.close();
  }
});

test('an absent Origin is allowed for non-browser MCP clients', async () => {
  const h = await startHttpHarness({ allowed_origins: ['https://allowed.example'] });
  try {
    const response = await raw(h, { headers: authenticated(h), body: rpc });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text).result.tools).toHaveLength(6);
  } finally {
    await h.close();
  }
});
