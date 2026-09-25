// Historical compatibility probe for the retired Basic Memory backend. It is
// retained so the sanitized fixtures used by the legacy import tests can be
// regenerated reproducibly; the production deployment no longer runs it.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export function assertBackendCapabilities(
  tools: { name: string; inputSchema: unknown }[]
): void {
  const names = new Set(tools.map(tool => tool.name));
  for (const name of [
    'write_note',
    'search_notes',
    'read_note',
    'list_memory_projects',
    'create_memory_project'
  ]) {
    if (!names.has(name)) throw new Error(`Missing backend tool: ${name}`);
  }
}

type DiscoveredTool = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

async function listAllTools(client: Client): Promise<DiscoveredTool[]> {
  const tools: DiscoveredTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

function writeJson(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function structuredResult(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Backend tool returned a non-object envelope');
  }
  const structured = (value as Record<string, unknown>).structuredContent;
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured)) {
    throw new Error('Backend tool returned no structuredContent');
  }
  const result = (structured as Record<string, unknown>).result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Backend tool returned no structured result');
  }
  return result as Record<string, unknown>;
}

function sanitizedProjectCreateEnvelope(value: unknown): unknown {
  const envelope = value as Record<string, unknown>;
  const result = structuredResult(value);
  return {
    ...envelope,
    content: [{ type: 'text', text: '<sanitized structured project result>' }],
    structuredContent: {
      result: {
        ...result,
        name: '<generated-project>',
        external_id: '<uuid>',
        path: '/app/data/Projects/<generated-project>'
      }
    }
  };
}

async function runProbe(): Promise<void> {
  const url = process.env.BACKEND_MCP_URL ?? 'http://127.0.0.1:8000/mcp';
  const outputDirectory = process.env.PROBE_OUTPUT_DIR;
  const project = process.env.PROBE_PROJECT ?? 'probe';
  const generatedProject = `probe-${randomUUID()}`;
  const generatedProjectPath = `/app/data/Projects/${generatedProject}`;
  const vaultDirectory = process.env.PROBE_VAULT_DIR;
  if (vaultDirectory === undefined) {
    throw new Error('PROBE_VAULT_DIR is required to verify project directory materialization');
  }

  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'second-brain-compatibility-probe', version: '0.1.0' });

  await client.connect(transport);

  const tools = await listAllTools(client);
  assertBackendCapabilities(tools);

  const projectCreateResult = await client.callTool({
    name: 'create_memory_project',
    arguments: {
      project_name: generatedProject,
      project_path: generatedProjectPath,
      set_default: false,
      output_format: 'json'
    }
  });
  const createdProject = structuredResult(projectCreateResult);
  if (
    createdProject.name !== generatedProject ||
    createdProject.path !== generatedProjectPath ||
    createdProject.created !== true ||
    createdProject.already_exists !== false
  ) {
    throw new Error(
      `create_memory_project returned unexpected safe fields: ${JSON.stringify({
        name: createdProject.name,
        path: createdProject.path,
        created: createdProject.created,
        already_exists: createdProject.already_exists,
        error: createdProject.error
      })}`
    );
  }
  const hostProjectPath = resolve(vaultDirectory, 'Projects', generatedProject);
  if (!existsSync(hostProjectPath)) {
    throw new Error('create_memory_project did not create the expected project directory');
  }

  const projectsAfterCreate = await client.callTool({
    name: 'list_memory_projects',
    arguments: { output_format: 'json' }
  });
  const listedProjects = structuredResult(projectsAfterCreate).projects;
  if (
    !Array.isArray(listedProjects) ||
    !listedProjects.some(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).name === generatedProject
    )
  ) {
    throw new Error('create_memory_project project was absent from list_memory_projects');
  }

  const initialize = {
    protocolVersion: transport.protocolVersion,
    capabilities: client.getServerCapabilities(),
    serverInfo: client.getServerVersion(),
    instructions: client.getInstructions()
  };

  const writeArguments = {
    project,
    title: 'Probe Revision 1',
    directory: 'Notes/probe',
    note_type: 'note',
    content: '# Probe\n\nA searchable synthetic observation.',
    metadata: { brain_schema_version: 1, brain_id: 'probe-note', brain_status: 'candidate' },
    overwrite: false,
    output_format: 'json'
  };

  const writeResult = await client.callTool({ name: 'write_note', arguments: writeArguments });
  const duplicateResult = await client.callTool({ name: 'write_note', arguments: writeArguments });
  const searchResult = await client.callTool({
    name: 'search_notes',
    arguments: { query: 'synthetic observation', project, output_format: 'json' }
  });
  const readResult = await client.callTool({
    name: 'read_note',
    arguments: { identifier: 'Probe Revision 1', project, output_format: 'json', include_frontmatter: true }
  });
  const projectsResult = await client.callTool({
    name: 'list_memory_projects',
    arguments: { output_format: 'json' }
  });

  const report = {
    url,
    observedAt: new Date().toISOString(),
    initialize,
    toolCount: tools.length,
    tools,
    calls: {
      write_note: writeResult,
      write_note_duplicate: duplicateResult,
      search_notes: searchResult,
      read_note: readResult,
      list_memory_projects: projectsResult,
      create_memory_project: sanitizedProjectCreateEnvelope(projectCreateResult)
    }
  };

  if (outputDirectory !== undefined) {
    mkdirSync(outputDirectory, { recursive: true });
    writeJson(outputDirectory, 'initialize.json', initialize);
    writeJson(outputDirectory, 'tools-list.json', { tools });
    writeJson(outputDirectory, 'write-note.json', writeResult);
    writeJson(outputDirectory, 'write-note-duplicate.json', duplicateResult);
    writeJson(outputDirectory, 'search-notes.json', searchResult);
    writeJson(outputDirectory, 'read-note.json', readResult);
    writeJson(outputDirectory, 'list-memory-projects.json', projectsResult);
    writeJson(
      outputDirectory,
      'create-memory-project.json',
      sanitizedProjectCreateEnvelope(projectCreateResult)
    );
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await client.close();
}

const entry = process.argv[1];
const isEntryPoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isEntryPoint) {
  runProbe().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
