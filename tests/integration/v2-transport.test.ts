import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { INPUT_BODY_MAX_BYTES } from '../../src/core/limits.js';
import { TOOL_NAMES } from '../../src/mcp/tools.js';
import { startLocalHttpHarness, type LocalHttpHarness } from '../support/harness.js';

interface RawResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function raw(
  h: { port: number },
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

const authenticated = (h: LocalHttpHarness, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${h.token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...extra
});

const listBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'v2-transport', version: '1.0.0' }
  }
});
const callBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'brain_status', arguments: {} }
});

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function invoke(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

async function callEveryTool(client: Client): Promise<Record<string, ToolResult>> {
  const key = (): string => randomUUID();
  const ensured = await invoke(client, 'brain_project_ensure', {
    idempotency_key: key(),
    remote_url: 'https://github.com/example/v2-transport.git'
  });
  const captured = await invoke(client, 'brain_capture', {
    idempotency_key: key(),
    note: {
      title: 'V2 transport note',
      tags: [],
      content: { kind: 'note', summary: 'transport', body_markdown: 'transport recall marker' },
      evidence: [],
      related_ids: []
    }
  });
  const receipt = captured.structuredContent ?? {};
  const read = await invoke(client, 'brain_read', { id: receipt.id as string });
  const recall = await invoke(client, 'brain_recall', {
    query: 'transport recall marker',
    include_candidates: true
  });
  const feedback = await invoke(client, 'brain_feedback', {
    idempotency_key: key(),
    id: receipt.id as string,
    revision_id: receipt.revision_id as string,
    verdict: 'useful',
    reason: 'the V2 transport suite exercised this note'
  });
  const review = await invoke(client, 'brain_review', {
    operation: { action: 'list', filter: 'candidate' }
  });
  const status = await invoke(client, 'brain_status', {});
  return { ensured, captured, read, recall, feedback, review, status };
}

test('authenticates initialize, tools/list, and tools/call on the V2 runtime', async () => {
  const h = await startLocalHttpHarness();
  try {
    for (const body of [initializeBody, listBody, callBody]) {
      const rejected = await raw(h, {
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body
      });
      expect(rejected.status).toBe(401);
      expect(rejected.headers['www-authenticate']).toContain('Bearer');
    }
    for (const body of [initializeBody, listBody, callBody]) {
      const accepted = await raw(h, { headers: authenticated(h), body });
      expect(accepted.status).toBe(200);
    }
  } finally {
    await h.close();
  }
});

test('the V2 runtime lists the seven tools and calls each one over authenticated MCP', async () => {
  const h = await startLocalHttpHarness();
  const client = await h.connect(h.token, 'v2-transport-client');
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual([...TOOL_NAMES].sort());

    const results = await callEveryTool(client);
    for (const result of Object.values(results)) {
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeTruthy();
    }
    const receipt = results.captured.structuredContent ?? {};
    expect(results.read.structuredContent?.source).toMatchObject({ id: receipt.id });
    expect(JSON.stringify(results.recall.structuredContent)).toContain('transport recall marker');
    expect(results.feedback.structuredContent?.recorded).toBe(true);
    expect(Array.isArray((results.review.structuredContent as { items?: unknown[] }).items)).toBe(true);
    expect(results.ensured.structuredContent?.project_id).toBe('v2-transport');
    expect(results.status.structuredContent?.protocol).toBe(2);
    expect(JSON.stringify(results.status.structuredContent)).not.toMatch(
      /permission|can_read|can_write|can_review|backend_ready/
    );
  } finally {
    await client.close();
    await h.close();
  }
});

test('stateless session and stream boundaries are explicit on the V2 runtime', async () => {
  const h = await startLocalHttpHarness();
  try {
    const get = await raw(h, {
      method: 'GET',
      headers: { authorization: `Bearer ${h.token}`, accept: 'text/event-stream' }
    });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');

    const remove = await raw(h, { method: 'DELETE', headers: authenticated(h) });
    expect(remove.status).toBe(405);
    expect(remove.headers.allow).toBe('POST');

    const listed = await raw(h, { headers: authenticated(h), body: listBody });
    expect(listed.status).toBe(200);
    const sessionId = listed.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');
    expect(JSON.parse(listed.text).result.tools).toHaveLength(7);

    const reused = await raw(h, {
      headers: authenticated(h, { 'mcp-session-id': sessionId as string }),
      body: listBody
    });
    expect(reused.status).toBe(200);
    expect(reused.headers['mcp-session-id']).toBe(sessionId);
  } finally {
    await h.close();
  }
});

test('token rotation invalidates the old token and lets the new token call every tool through an existing session', async () => {
  const h = await startLocalHttpHarness();
  const nextToken = `rotated-${randomUUID()}`;
  try {
    const established = await raw(h, { headers: authenticated(h), body: listBody });
    expect(established.status).toBe(200);
    const sessionId = established.headers['mcp-session-id'] as string;

    h.runtime.rotateTokenDigest(createHash('sha256').update(nextToken, 'utf8').digest('hex'));

    const oldToken = await raw(h, { headers: authenticated(h), body: listBody });
    expect(oldToken.status).toBe(401);
    const oldSession = await raw(h, {
      headers: {
        'mcp-session-id': sessionId,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: listBody
    });
    expect(oldSession.status).toBe(401);

    const rotatedSession = await raw(h, {
      headers: {
        authorization: `Bearer ${nextToken}`,
        'mcp-session-id': sessionId,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: listBody
    });
    expect(rotatedSession.status).toBe(200);
    expect(JSON.parse(rotatedSession.text).result.tools).toHaveLength(7);

    const client = await h.connect(nextToken, 'v2-rotated-client');
    try {
      const results = await callEveryTool(client);
      for (const result of Object.values(results)) {
        expect(result.isError).toBeFalsy();
      }
    } finally {
      await client.close();
    }
  } finally {
    await h.close();
  }
});

test('host and origin protections reject unsafe requests on the V2 runtime', async () => {
  const h = await startLocalHttpHarness({ allowed_origins: ['https://allowed.example'] });
  try {
    const badHost = await raw(h, {
      headers: authenticated(h, { host: 'evil.example' }),
      body: listBody
    });
    expect(badHost.status).toBe(403);

    const badOrigin = await raw(h, {
      headers: authenticated(h, { origin: 'https://evil.example' }),
      body: listBody
    });
    expect(badOrigin.status).toBe(403);

    const malformedOrigin = await raw(h, {
      headers: authenticated(h, { origin: 'https://user:secret@allowed.example' }),
      body: listBody
    });
    expect(malformedOrigin.status).toBe(403);

    const allowed = await raw(h, {
      headers: authenticated(h, { origin: 'https://allowed.example' }),
      body: listBody
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBeUndefined();
  } finally {
    await h.close();
  }
});

test('a valid token still distinguishes transport and resource failures on the V2 runtime', async () => {
  const h = await startLocalHttpHarness();
  try {
    const badType = await raw(h, {
      headers: authenticated(h, { 'content-type': 'text/plain' }),
      body: listBody
    });
    expect(badType.status).toBe(415);

    const badJson = await raw(h, { headers: authenticated(h), body: '{"jsonrpc":' });
    expect(badJson.status).toBe(400);
    expect(JSON.parse(badJson.text).error.code).toBe(-32700);

    const missingAccept = await raw(h, {
      headers: authenticated(h, { accept: 'application/json' }),
      body: listBody
    });
    expect(missingAccept.status).toBe(406);

    const oversized = 'x'.repeat(INPUT_BODY_MAX_BYTES + 1024);
    const tooLarge = await raw(h, {
      headers: authenticated(h),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { oversized } })
    });
    expect(tooLarge.status).toBe(413);
  } finally {
    await h.close();
  }
});

test('text-json delivery serializes the complete V2 result in the text block', async () => {
  const h = await startLocalHttpHarness({ result_delivery: 'text-json' });
  const client = await h.connect(h.token, 'v2-text-json');
  try {
    const status = await invoke(client, 'brain_status', {});
    const parsed = JSON.parse(status.content[0].text) as Record<string, unknown>;
    expect(parsed.protocol).toBe(2);
    expect(parsed).toEqual(status.structuredContent);
  } finally {
    await client.close();
    await h.close();
  }
});
