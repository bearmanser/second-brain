import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from 'vitest';

const IMAGE = process.env.BRAIN_E2E_IMAGE ?? 'second-brain:test';
const TOKEN = 'e2e-token-0123456789';
const DIGEST = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const enabled = process.env.BRAIN_E2E === '1';

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // the container is still starting
    }
    if (Date.now() > deadline) throw new Error('the container did not become healthy');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function connect(port: number): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
  });
  await client.connect(transport);
  return client;
}

test.runIf(enabled)('runs the published image and keeps its vault across a restart', async () => {
  const tag = randomUUID().slice(0, 8);
  const name = `brain-e2e-${tag}`;
  const vaultVolume = `${name}-vault`;
  const stateVolume = `${name}-state`;
  try {
    docker([
      'run', '-d', '--name', name, '-p', '127.0.0.1::7331',
      '-e', `BRAIN_TOKEN_SHA256=${DIGEST}`,
      '-e', 'BRAIN_ALLOWED_HOSTS=127.0.0.1,localhost',
      '-v', `${vaultVolume}:/vault`,
      '-v', `${stateVolume}:/var/lib/second-brain`,
      IMAGE, 'serve'
    ]);
    const port = Number(docker(['port', name, '7331']).split('\n')[0].split(':').pop());
    await waitForHealth(port);

    const first = await connect(port);
    const tools = (await first.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual([
      'brain_capture', 'brain_delete', 'brain_feedback', 'brain_project_ensure',
      'brain_read', 'brain_recall', 'brain_status', 'brain_update'
    ]);
    const captured = await first.callTool({
      name: 'brain_capture',
      arguments: { title: 'Container note', body: 'written inside the container', idempotency_key: randomUUID() }
    });
    const capturedBody = JSON.parse((captured.content as { text: string }[])[0].text) as { path: string };
    expect(capturedBody.path).toBe('Notes/Container note.md');
    await first.close();

    docker(['restart', name]);
    const restartedPort = Number(docker(['port', name, '7331']).split('\n')[0].split(':').pop());
    await waitForHealth(restartedPort);
    const second = await connect(restartedPort);
    const recalled = await second.callTool({ name: 'brain_recall', arguments: { query: 'container' } });
    const items = JSON.parse((recalled.content as { text: string }[])[0].text).items as { path: string }[];
    expect(items.map((item) => item.path)).toEqual(['Notes/Container note.md']);
    await second.close();
  } finally {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    execFileSync('docker', ['volume', 'rm', '-f', vaultVolume, stateVolume], { stdio: 'ignore' });
  }
}, 120_000);
