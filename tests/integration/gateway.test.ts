import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  mcpClient,
  rawPost,
  scratch,
  startTestGateway,
  waitFor,
  writeTree,
  TEST_TOKEN
} from '../helpers.js';

const AUTHORIZED = { authorization: `Bearer ${TEST_TOKEN}` };

test('serves an unauthenticated health check', async () => {
  const root = scratch('gateway');
  writeTree(join(root, 'vault'), { 'Notes/a.md': '# A\n' });
  const gateway = await startTestGateway(join(root, 'vault'), join(root, 'state'));
  const response = await fetch(`http://127.0.0.1:${gateway.port}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('guards the MCP endpoint', async () => {
  const root = scratch('gateway');
  writeTree(join(root, 'vault'), {});
  const gateway = await startTestGateway(join(root, 'vault'), join(root, 'state'));
  expect((await rawPost(gateway.port, '{}')).status).toBe(401);
  expect((await rawPost(gateway.port, '{}', { ...AUTHORIZED, host: 'evil.example' })).status).toBe(403);
  expect((await rawPost(gateway.port, '{}', { ...AUTHORIZED, origin: 'http://evil.example' })).status).toBe(403);
  const get = await fetch(`http://127.0.0.1:${gateway.port}/mcp`, { headers: AUTHORIZED });
  expect(get.status).toBe(405);
  expect(get.headers.get('allow')).toBe('POST');
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {}, pad: 'x'.repeat(300 * 1024) });
  expect((await rawPost(gateway.port, huge, AUTHORIZED)).status).toBe(413);
});

test('lists exactly the eight tools', async () => {
  const root = scratch('gateway');
  writeTree(join(root, 'vault'), {});
  const client = await mcpClient(await startTestGateway(join(root, 'vault'), join(root, 'state')));
  expect(await client.listTools()).toEqual([
    'brain_capture',
    'brain_delete',
    'brain_feedback',
    'brain_project_ensure',
    'brain_read',
    'brain_recall',
    'brain_status',
    'brain_update'
  ]);
  await client.close();
});

test('runs the full capture, recall, read, update, feedback, delete cycle', async () => {
  const root = scratch('gateway');
  writeTree(join(root, 'vault'), {});
  const client = await mcpClient(await startTestGateway(join(root, 'vault'), join(root, 'state')));
  const ensured = await client.call('brain_project_ensure', {
    remote_url: 'git@github.com:bearmanser/second-brain.git',
    idempotency_key: randomUUID()
  });
  expect(ensured).toMatchObject({
    created: true,
    project: { name: 'second-brain', repositories: ['github.com/bearmanser/second-brain'] }
  });
  expect(await client.call('brain_project_ensure', {
    remote_url: 'https://github.com/bearmanser/second-brain',
    idempotency_key: randomUUID()
  })).toMatchObject({ created: false });

  const captured = await client.call('brain_capture', {
    title: 'Recall budget note',
    body: 'Budget details about laya.',
    type: 'lesson',
    project: 'second-brain',
    idempotency_key: randomUUID()
  });
  const id = captured.id as string;
  expect(captured).toMatchObject({ path: 'Projects/second-brain/Recall budget note.md' });
  expect(await client.call('brain_capture', {
    title: 'Collision probe',
    body: 'Nothing to find here.',
    project: 'second-brain',
    idempotency_key: randomUUID()
  })).toMatchObject({ path: 'Projects/second-brain/Collision probe.md' });
  expect(await client.call('brain_capture', {
    title: 'Collision probe',
    body: 'Nothing to find here.',
    project: 'second-brain',
    idempotency_key: randomUUID()
  })).toMatchObject({ path: 'Projects/second-brain/Collision probe (2).md' });

  const recalled = await client.call('brain_recall', { query: 'budget laya', project: 'second-brain' });
  expect((recalled.items as unknown[]).length).toBe(1);
  expect((recalled.items as { excerpt: string }[])[0].excerpt).toBe('Budget details about laya.');

  const read = await client.call('brain_read', { id });
  expect(read).toMatchObject({ id, body: 'Budget details about laya.\n', demoted: false, feedback: {} });

  const updated = await client.call('brain_update', { id, expected_hash: read.hash, body: 'Corrected budget details.' });
  const stale = await client.raw('brain_update', { id, expected_hash: read.hash, body: 'stale write' });
  expect(stale.isError).toBe(true);
  expect(stale.text).toContain('CONFLICT');

  expect(await client.call('brain_feedback', { id, verdict: 'incorrect', reason: 'wrong number' })).toEqual({ recorded: true });
  expect(await client.call('brain_read', { id })).toMatchObject({ demoted: true, feedback: { incorrect: 1 } });
  const fixed = await client.call('brain_update', { id, expected_hash: updated.hash, body: 'Fixed budget details.' });
  expect(await client.call('brain_read', { id })).toMatchObject({ demoted: false });
  expect(await client.call('brain_delete', { id, expected_hash: fixed.hash })).toEqual({
    trashed_path: '.trash/Recall budget note.md'
  });
  expect((await client.raw('brain_read', { id })).isError).toBe(true);
  await client.close();
});

test('picks up files written directly into the vault', async () => {
  const root = scratch('gateway');
  const vaultDir = join(root, 'vault');
  writeTree(vaultDir, {});
  const client = await mcpClient(await startTestGateway(vaultDir, join(root, 'state')));
  mkdirSync(join(vaultDir, 'Notes'), { recursive: true });
  writeFileSync(join(vaultDir, 'Notes/hand.md'), '---\nid: hand-id\ntype: fact\n---\n\n# Hand written\n\nobsidian edit\n');
  await waitFor(async () => {
    const read = await client.call('brain_read', { id: 'hand-id' });
    return (read.body as string).includes('obsidian edit');
  });
  await client.close();
});

test('reports broken notes through brain_status without failing', async () => {
  const root = scratch('gateway');
  writeTree(join(root, 'vault'), { 'Notes/broken.md': '---\nid: [oops\n---\n# Broken\n' });
  const client = await mcpClient(await startTestGateway(join(root, 'vault'), join(root, 'state')));
  const result = await client.call('brain_status');
  expect(result).toMatchObject({ notes: 0, projects: [] });
  expect((result.problems as { path: string }[]).map((problem) => problem.path)).toEqual(['Notes/broken.md']);
  await client.close();
});

test('rejects arguments that fail schema validation', async () => {
  const root = scratch('gateway');
  writeTree(join(root, 'vault'), {});
  const client = await mcpClient(await startTestGateway(join(root, 'vault'), join(root, 'state')));
  const rejected = await client.raw('brain_read', { id: 42 }).catch((error: Error) => ({
    isError: true,
    text: error.message
  }));
  expect(rejected.isError).toBe(true);
  await client.close();
});
