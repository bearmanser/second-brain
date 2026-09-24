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
      expect(JSON.stringify(structured)).not.toMatch(/permission|can_read|can_write|can_review/);
    } finally {
      await client.close();
    }
  } finally {
    await h.close();
  }
});
