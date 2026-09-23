import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { expect, test } from 'vitest';
import { BRAIN_TOKEN_ENV, assertTokenDigest, loadTokenDigest } from '../../src/config/load.js';
import type { AuthenticatedContext } from '../../src/core/types.js';
import {
  MAX_AUTHORIZATION_HEADER_CHARS,
  SessionRegistry,
  createAuthenticatedHttpApp
} from '../../src/mcp/http.js';
import { startHttpHarness } from '../support/harness.js';

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const token = (): string => `token-${Math.random().toString(36).slice(2)}-${Date.now()}`;

interface GuardHarness {
  port: number;
  contexts: AuthenticatedContext[];
  rotate(next: string): void;
  close(): Promise<void>;
}

async function startGuard(
  initialDigest: string,
  options: { hosts?: string[]; origins?: string[]; registry?: SessionRegistry } = {}
): Promise<GuardHarness> {
  const source = { digest: initialDigest };
  const contexts: AuthenticatedContext[] = [];
  const app = createAuthenticatedHttpApp({
    token_digest: () => source.digest,
    allowed_hosts: options.hosts ?? ['127.0.0.1'],
    allowed_origins: options.origins ?? [],
    signal: new AbortController().signal,
    ...(options.registry === undefined ? {} : { session_registry: options.registry }),
    dispatch: (ctx, _req, res) => {
      contexts.push(ctx);
      res
        .status(200)
        .type('application/json')
        .send(JSON.stringify({ ok: true, request_id: ctx.request_id, actor: ctx.actor }));
      return Promise.resolve();
    }
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    contexts,
    rotate: (next: string) => {
      source.digest = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

interface RawResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function send(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string | string[]>;
    body?: string;
  } = {}
): Promise<RawResult> {
  return new Promise<RawResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
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

const authorized = (bearer: string, extra: Record<string, string | string[]> = {}) => ({
  authorization: `Bearer ${bearer}`,
  'content-type': 'application/json',
  accept: 'application/json',
  ...extra
});

test('a request without an authorization header is rejected with a bearer challenge', async () => {
  const guard = await startGuard(digest(token()));
  try {
    const response = await send(guard.port, { headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(guard.contexts).toHaveLength(0);
  } finally {
    await guard.close();
  }
});

test('a request with a wrong token is rejected', async () => {
  const guard = await startGuard(digest(token()));
  try {
    const response = await send(guard.port, {
      headers: authorized(token()),
      body: '{}'
    });
    expect(response.status).toBe(401);
    expect(guard.contexts).toHaveLength(0);
  } finally {
    await guard.close();
  }
});

test('duplicate authorization headers are rejected before Express combines them', async () => {
  const value = token();
  const guard = await startGuard(digest(value));
  try {
    const response = await send(guard.port, {
      headers: authorized(value, { authorization: [`Bearer ${value}`, `Bearer ${value}`] }),
      body: '{}'
    });
    expect(response.status).toBe(401);
    expect(guard.contexts).toHaveLength(0);
  } finally {
    await guard.close();
  }
});

test('an oversized authorization header is rejected', async () => {
  const guard = await startGuard(digest(token()));
  try {
    const response = await send(guard.port, {
      headers: authorized('a'.repeat(MAX_AUTHORIZATION_HEADER_CHARS + 10)),
      body: '{}'
    });
    expect(response.status).toBe(401);
  } finally {
    await guard.close();
  }
});

test('a malformed digest fails at construction and at load time', async () => {
  expect(() =>
    createAuthenticatedHttpApp({
      token_digest: 'not-a-digest',
      allowed_hosts: ['127.0.0.1'],
      allowed_origins: [],
      signal: new AbortController().signal,
      dispatch: () => Promise.resolve()
    })
  ).toThrow(/INVALID_INPUT/);
  expect(() => assertTokenDigest('ABCD')).toThrow(/INVALID_INPUT/);
  expect(() => loadTokenDigest({ [BRAIN_TOKEN_ENV]: 'nope' })).toThrow(/INVALID_INPUT/);
});

test('a valid token receives a role-free context with a request id and actor', async () => {
  const value = token();
  const guard = await startGuard(digest(value));
  try {
    const response = await send(guard.port, { headers: authorized(value), body: '{"jsonrpc":"2.0"}' });
    expect(response.status).toBe(200);
    expect(guard.contexts).toHaveLength(1);
    const context = guard.contexts[0];
    expect(context.actor).toEqual({ kind: 'system', id: 'system' });
    expect(context.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context).not.toHaveProperty('principal');
    expect(context).not.toHaveProperty('role');
    expect(Object.keys(context).sort()).toEqual(['actor', 'request_id', 'signal']);
  } finally {
    await guard.close();
  }
});

test('every unsupported HTTP method is authenticated, then rejected with 405', async () => {
  const value = token();
  const guard = await startGuard(digest(value));
  try {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      const unauthenticated = await send(guard.port, { method });
      expect(unauthenticated.status, `unauthenticated ${method}`).toBe(401);
      const authenticated = await send(guard.port, {
        method,
        headers: { authorization: `Bearer ${value}` }
      });
      expect(authenticated.status, `authenticated ${method}`).toBe(405);
      expect(authenticated.headers.allow, `allow ${method}`).toBe('POST');
    }
    const post = await send(guard.port, { headers: authorized(value), body: '{}' });
    expect(post.status).toBe(200);
  } finally {
    await guard.close();
  }
});

test('host and origin protections are preserved for the token guard', async () => {
  const value = token();
  const guard = await startGuard(digest(value), { origins: ['https://allowed.example'] });
  try {
    const badHost = await send(guard.port, {
      headers: authorized(value, { host: 'evil.example' })
    });
    expect(badHost.status).toBe(403);
    const badOrigin = await send(guard.port, {
      headers: authorized(value, { origin: 'https://evil.example' })
    });
    expect(badOrigin.status).toBe(403);
    const good = await send(guard.port, {
      headers: authorized(value, { origin: 'https://allowed.example' }),
      body: '{}'
    });
    expect(good.status).toBe(200);
    expect(good.headers['access-control-allow-origin']).toBeUndefined();
  } finally {
    await guard.close();
  }
});

test('a valid token keeps resource failures distinct from authentication failure', async () => {
  const value = token();
  const guard = await startGuard(digest(value));
  try {
    const badType = await send(guard.port, {
      headers: authorized(value, { 'content-type': 'text/plain' }),
      body: '{}'
    });
    expect(badType.status).toBe(415);

    const badJson = await send(guard.port, { headers: authorized(value), body: '{"jsonrpc":' });
    expect(badJson.status).toBe(400);
    expect(JSON.parse(badJson.text).error.code).toBe(-32700);

    const oversized = 'x'.repeat(400 * 1024);
    const tooLarge = await send(guard.port, {
      headers: authorized(value),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { oversized } })
    });
    expect(tooLarge.status).toBe(413);
  } finally {
    await guard.close();
  }
});

test('an existing session must reauthenticate after the token rotates', async () => {
  const first = token();
  const second = token();
  const guard = await startGuard(digest(first));
  try {
    const established = await send(guard.port, { headers: authorized(first), body: '{}' });
    expect(established.status).toBe(200);
    const sessionId = established.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');
    const firstRequestId = guard.contexts[0].request_id;

    const reused = await send(guard.port, {
      headers: authorized(first, { 'mcp-session-id': sessionId as string }),
      body: '{}'
    });
    expect(reused.status).toBe(200);
    expect(reused.headers['mcp-session-id']).toBe(sessionId);
    expect(guard.contexts).toHaveLength(2);

    guard.rotate(digest(second));

    const oldSessionNoToken = await send(guard.port, {
      headers: { 'mcp-session-id': sessionId as string, 'content-type': 'application/json' },
      body: '{}'
    });
    expect(oldSessionNoToken.status).toBe(401);

    const oldSessionOldToken = await send(guard.port, {
      headers: authorized(first, { 'mcp-session-id': sessionId as string }),
      body: '{}'
    });
    expect(oldSessionOldToken.status).toBe(401);

    const oldSessionForgedCursor = await send(guard.port, {
      headers: { 'mcp-session-id': sessionId as string, 'content-type': 'application/json' },
      body: JSON.stringify({ cursor: 'forged-read-cursor' })
    });
    expect(oldSessionForgedCursor.status).toBe(401);

    expect(guard.contexts).toHaveLength(2);

    const rotated = await send(guard.port, {
      headers: authorized(second, { 'mcp-session-id': sessionId as string }),
      body: '{}'
    });
    expect(rotated.status).toBe(200);
    expect(rotated.headers['mcp-session-id']).toBeDefined();
    expect(rotated.headers['mcp-session-id']).not.toBe(sessionId);
    expect(guard.contexts).toHaveLength(3);
    expect(guard.contexts[2].request_id).not.toBe(firstRequestId);
  } finally {
    await guard.close();
  }
});

test('retained session state stays bounded under anonymous requests that never reuse a session', async () => {
  const value = token();
  let issued = 0;
  const registry = new SessionRegistry({
    capacity: 8,
    idle_ms: 60_000,
    generate: () => `anonymous-${(issued += 1)}`
  });
  const guard = await startGuard(digest(value), { registry });
  try {
    for (let index = 0; index < 50; index += 1) {
      const response = await send(guard.port, { headers: authorized(value), body: '{}' });
      expect(response.status, `request ${index}`).toBe(200);
      expect(typeof response.headers['mcp-session-id']).toBe('string');
    }
    expect(guard.contexts).toHaveLength(50);
    expect(registry.size).toBeLessThanOrEqual(8);
    expect(issued).toBe(50);
  } finally {
    await guard.close();
  }
});

test('the runtime exposes the token digest seam and rejects a malformed rotation', async () => {
  const initial = digest(token());
  const harness = await startHttpHarness({ token_digest: initial });
  try {
    expect(harness.runtime.tokenDigest).toBe(initial);
    const rotated = digest(token());
    harness.runtime.rotateTokenDigest(rotated);
    expect(harness.runtime.tokenDigest).toBe(rotated);
    expect(() => harness.runtime.rotateTokenDigest('not-a-digest')).toThrow(/INVALID_INPUT/);
    expect(harness.runtime.tokenDigest).toBe(rotated);
  } finally {
    await harness.close();
  }
});

test('a malformed configured token digest fails runtime startup', async () => {
  await expect(startHttpHarness({ token_digest: 'not-a-digest' })).rejects.toThrow(/INVALID_INPUT/);
});
