import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from 'vitest';
import { TOOL_NAMES } from '../../src/mcp/tools.js';
import { createRuntime } from '../../src/runtime.js';
import { startLocalHttpHarness } from '../support/harness.js';

test('the default integration harness runs the seven tools without an injected backend', async () => {
  const h = await startLocalHttpHarness();
  try {
    const unauth = await fetch(h.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(unauth.status).toBe(401);

    const client = await h.connect(h.token);
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(tools).toEqual([...TOOL_NAMES].sort());
      const status = (await client.callTool({ name: 'brain_status', arguments: {} })) as {
        structuredContent?: Record<string, unknown>;
      };
      const structured = status.structuredContent;
      expect(structured?.protocol).toBe(2);
      expect(structured?.health).toMatchObject({ gateway: 'ready', index: 'ready', worker: 'disabled' });
      expect(structured?.health).not.toHaveProperty('backend');
      expect(structured?.health).not.toHaveProperty('embeddings');
      if (process.platform === 'linux') {
        const rss = (structured?.health as { rss_bytes?: unknown } | undefined)?.rss_bytes;
        expect(typeof rss).toBe('number');
        expect(rss as number).toBeGreaterThan(0);
      }
      expect(JSON.stringify(structured)).not.toMatch(/permission|can_read|can_write|can_review/);
      const ensured = (await client.callTool({
        name: 'brain_project_ensure',
        arguments: { idempotency_key: '11111111-1111-4111-8111-111111111111', remote_url: 'git@github.com:example/disposable.git' }
      })) as { structuredContent?: Record<string, unknown> };
      expect(ensured.structuredContent).toMatchObject({
        project_id: 'disposable', created: true, materialized: true
      });
      expect(ensured.structuredContent).not.toHaveProperty('backend_ready');
      const ensureStatus = (await client.callTool({
        name: 'brain_status', arguments: { operation_id: ensured.structuredContent?.operation_id }
      })) as { structuredContent?: Record<string, unknown> };
      expect(ensureStatus.structuredContent?.operation).toMatchObject({
        operation_id: ensured.structuredContent?.operation_id, created: true
      });
      const captured = (await client.callTool({ name: 'brain_capture', arguments: {
        idempotency_key: '22222222-2222-4222-8222-222222222222',
        note: { title: 'Status capture', tags: [], content: { kind: 'note', summary: 'status', body_markdown: 'status' },
          evidence: [], related_ids: [] }
      } })) as { structuredContent?: Record<string, unknown> };
      const captureStatus = (await client.callTool({
        name: 'brain_status', arguments: { operation_id: captured.structuredContent?.operation_id }
      })) as { structuredContent?: Record<string, unknown> };
      expect(captureStatus.structuredContent?.operation).toMatchObject({
        operation_id: captured.structuredContent?.operation_id, id: captured.structuredContent?.id
      });
      const afterEnsure = (await client.callTool({ name: 'brain_status', arguments: {} })) as {
        structuredContent?: Record<string, unknown>;
      };
      expect(afterEnsure.structuredContent?.projects).toContainEqual({
        id: 'disposable', display_name: 'disposable', relative_root: ensured.structuredContent?.relative_root,
        state: 'ready'
      });
    } finally {
      await client.close();
    }
  } finally {
    await h.close();
  }
});

test('public operation status and creation receipts survive a full V2 runtime restart', async () => {
  const h = await startLocalHttpHarness();
  let restarted: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let client: Client | undefined;
  try {
    const original = await h.connect(h.token);
    const ensureArgs = { idempotency_key: '33333333-3333-4333-8333-333333333333',
      remote_url: 'https://github.com/example/runtime-restart.git' };
    const ensured = (await original.callTool({ name: 'brain_project_ensure', arguments: ensureArgs })) as {
      structuredContent?: Record<string, unknown>;
    };
    const captured = (await original.callTool({ name: 'brain_capture', arguments: {
      idempotency_key: '44444444-4444-4444-8444-444444444444',
      note: { title: 'Restart note', tags: [], content: { kind: 'note', summary: 'restart', body_markdown: 'restart' },
        evidence: [], related_ids: [] }
    } })) as { structuredContent?: Record<string, unknown> };
    await original.close();
    await h.runtime.close();
    restarted = await createRuntime(h.config, {
      token_digest: createHash('sha256').update(h.token, 'utf8').digest('hex'), logger: () => undefined
    });
    client = new Client({ name: 'restarted-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(restarted.url), {
      requestInit: { headers: { Authorization: `Bearer ${h.token}` } }
    }));
    const replay = (await client.callTool({ name: 'brain_project_ensure', arguments: ensureArgs })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(replay.structuredContent).toMatchObject({
      operation_id: ensured.structuredContent?.operation_id, created: true
    });
    for (const operation of [ensured.structuredContent, captured.structuredContent]) {
      const status = (await client.callTool({ name: 'brain_status', arguments: {
        operation_id: operation?.operation_id
      } })) as { structuredContent?: Record<string, unknown> };
      expect(status.structuredContent?.operation).toMatchObject({ operation_id: operation?.operation_id });
    }
  } finally {
    await client?.close();
    await restarted?.close();
    await h.close();
  }
});
