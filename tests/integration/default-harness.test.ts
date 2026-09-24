import { expect, test } from 'vitest';
import { TOOL_NAMES } from '../../src/mcp/tools.js';
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
      expect(JSON.stringify(structured)).not.toMatch(/permission|can_read|can_write|can_review/);
      const ensured = (await client.callTool({
        name: 'brain_project_ensure',
        arguments: { idempotency_key: '11111111-1111-4111-8111-111111111111', remote_url: 'git@github.com:example/disposable.git' }
      })) as { structuredContent?: Record<string, unknown> };
      expect(ensured.structuredContent).toMatchObject({
        project_id: 'disposable', created: true, materialized: true
      });
      expect(ensured.structuredContent).not.toHaveProperty('backend_ready');
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
