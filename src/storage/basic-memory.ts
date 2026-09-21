import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BrainError, isBrainError } from '../contracts/errors.js';
import { BACKEND_TIMEOUT_MS } from '../core/limits.js';
import type { BackendHit, BackendPort, BackendSearch, PlannedWrite, ScopeConfig } from '../core/types.js';
import {
  CREATE_MEMORY_PROJECT_TOOL,
  LIST_MEMORY_PROJECTS_TOOL,
  SEARCH_NOTES_TOOL,
  WRITE_NOTE_TOOL,
  argumentsForCreate,
  argumentsForIndexedLookup,
  argumentsForProjectCreate,
  argumentsForSearch,
  assertRequiredBackendTools,
  decodeCreateResponse,
  decodeProjectCreateResponse,
  decodeProjectNames,
  decodeProjects,
  decodeSearchResponse,
  invalidInput,
  protocolError
} from './backend-contract.js';

const DEFAULT_CLIENT_NAME = 'second-brain-gateway';
const DEFAULT_CLIENT_VERSION = '0.1.0';
const DEFAULT_READ_ATTEMPTS = 3;
const DEFAULT_READ_RETRY_DELAY_MS = 100;
const ERROR_DETAIL_MAX_CHARS = 200;
const ERROR_MESSAGE_MAX_CHARS = 400;
const BACKEND_VAULT_ROOT = '/app/data';

function projectPathMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  return actual.startsWith('/') && `${BACKEND_VAULT_ROOT}${actual}` === expected;
}

const EMBEDDING_ERROR_PATTERN =
  /(embedding|fastembed|sentence[- ]?transformer|semantic (?:search|index)|vector (?:index|search)|model (?:is )?(?:unavailable|missing|not found))/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

function firstTextContent(envelope: Record<string, unknown>): string | undefined {
  const content = envelope.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return undefined;
}

function backendToolError(envelope: Record<string, unknown>): BrainError {
  const text = firstTextContent(envelope);
  const detail = (text ?? 'no detail provided')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_DETAIL_MAX_CHARS);
  const code =
    text !== undefined && EMBEDDING_ERROR_PATTERN.test(text)
      ? 'EMBEDDINGS_UNAVAILABLE'
      : 'BACKEND_UNAVAILABLE';
  return new BrainError({ code, message: `backend tool error: ${detail}` });
}

export function normalizeToolResponse(result: unknown): unknown {
  if (!isRecord(result)) {
    throw protocolError('backend returned a non-object tool result');
  }
  if (result.isError === true) {
    throw backendToolError(result);
  }
  const structured = result.structuredContent;
  if (isRecord(structured) && 'result' in structured) {
    return structured.result;
  }
  const text = firstTextContent(result);
  if (text === undefined) {
    throw protocolError('backend tool result carried no payload');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw protocolError('backend tool result is not JSON', cause);
  }
}

export interface BackendConnection {
  open(): Promise<void>;
  listTools(): Promise<string[]>;
  call(name: string, args: unknown, timeout_ms: number): Promise<unknown>;
  serverVersion(): string | undefined;
  close(): Promise<void>;
}

export interface ConnectionFactoryOptions {
  url: URL;
  timeout_ms: number;
  client_name: string;
  client_version: string;
}

export type ConnectionFactory = (options: ConnectionFactoryOptions) => BackendConnection;

export interface BasicMemoryOptions {
  url: string | URL;
  projects: readonly string[];
  timeout_ms?: number;
  read_attempts?: number;
  read_retry_delay_ms?: number;
  client_name?: string;
  client_version?: string;
  connection_factory?: ConnectionFactory;
}

class SdkBackendConnection implements BackendConnection {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly timeoutMs: number;

  constructor(options: ConnectionFactoryOptions) {
    this.timeoutMs = options.timeout_ms;
    this.transport = new StreamableHTTPClientTransport(options.url);
    this.client = new Client({
      name: options.client_name,
      version: options.client_version
    });
  }

  async open(): Promise<void> {
    await this.client.connect(this.transport, { timeout: this.timeoutMs });
  }

  async listTools(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
        { timeout: this.timeoutMs }
      );
      names.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return names;
  }

  async call(name: string, args: unknown, timeout_ms: number): Promise<unknown> {
    return this.client.callTool(
      { name, arguments: args as Record<string, unknown> },
      undefined,
      { timeout: timeout_ms }
    );
  }

  serverVersion(): string | undefined {
    return this.client.getServerVersion()?.version;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class BasicMemoryBackend implements BackendPort {
  private readonly url: URL;
  private readonly projects: Set<string>;
  private readonly scopeMappings = new Map<string, { backend_project: string; relative_root: string }>();
  private readonly timeoutMs: number;
  private readonly readAttempts: number;
  private readonly readRetryDelayMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectionFactory: ConnectionFactory;
  private connection: BackendConnection | undefined;

  constructor(options: BasicMemoryOptions) {
    this.url = options.url instanceof URL ? options.url : new URL(options.url);
    this.projects = new Set(options.projects);
    for (const project of options.projects) {
      this.scopeMappings.set(project, { backend_project: project, relative_root: '' });
    }
    this.timeoutMs = options.timeout_ms ?? BACKEND_TIMEOUT_MS;
    this.readAttempts = Math.max(1, options.read_attempts ?? DEFAULT_READ_ATTEMPTS);
    this.readRetryDelayMs = Math.max(
      0,
      options.read_retry_delay_ms ?? DEFAULT_READ_RETRY_DELAY_MS
    );
    this.clientName = options.client_name ?? DEFAULT_CLIENT_NAME;
    this.clientVersion = options.client_version ?? DEFAULT_CLIENT_VERSION;
    this.connectionFactory =
      options.connection_factory ?? ((factoryOptions) => new SdkBackendConnection(factoryOptions));
  }

  async connect(): Promise<void> {
    await this.close();
    const connection = this.connectionFactory({
      url: this.url,
      timeout_ms: this.timeoutMs,
      client_name: this.clientName,
      client_version: this.clientVersion
    });
    await connection.open();
    this.connection = connection;
  }

  async probe(): Promise<{ server_version: string; tools: string[] }> {
    return this.read('probe', async (connection) => {
      const tools = await connection.listTools();
      assertRequiredBackendTools(tools);
      const raw = await connection.call(
        LIST_MEMORY_PROJECTS_TOOL,
        { output_format: 'json' },
        this.timeoutMs
      );
      const names = decodeProjectNames(normalizeToolResponse(raw));
      for (const project of this.projects) {
        if (!names.includes(project)) {
          throw invalidInput(`configured backend project ${project} is not available`);
        }
      }
      const serverVersion = connection.serverVersion();
      if (serverVersion === undefined) {
        throw protocolError('backend did not report a server version after initialization');
      }
      return { server_version: serverVersion, tools };
    });
  }

  registerScope(scope: ScopeConfig): void {
    const existing = this.scopeMappings.get(scope.id);
    if (existing !== undefined) {
      const syntheticInitial = existing.relative_root === '' && existing.backend_project === scope.id;
      if (
        !syntheticInitial &&
        (existing.backend_project !== scope.backend_project || existing.relative_root !== scope.relative_root)
      ) {
        throw invalidInput(`backend scope ${scope.id} is already registered differently`);
      }
      if (!syntheticInitial) return;
    }
    this.scopeMappings.set(scope.id, {
      backend_project: scope.backend_project,
      relative_root: scope.relative_root
    });
    this.projects.add(scope.backend_project);
  }

  async create(write: PlannedWrite): Promise<{ permalink: string; relative_path?: string }> {
    this.assertProject(write.backend_project);
    const connection = this.requireConnection(WRITE_NOTE_TOOL);
    let raw: unknown;
    try {
      raw = await connection.call(WRITE_NOTE_TOOL, argumentsForCreate(write), this.timeoutMs);
    } catch (cause) {
      throw writeFailure(cause);
    }
    return decodeCreateResponse(normalizeToolResponse(raw));
  }

  async ensureProject(project: string, projectPath: string): Promise<{ created: boolean }> {
    const existing = await this.listProjects();
    const existingProject = existing.find((entry) => entry.name === project);
    if (existingProject !== undefined) {
      if (!projectPathMatches(existingProject.path, projectPath)) {
        throw protocolError('existing backend project path did not match the expected mapping');
      }
      return { created: false };
    }

    const connection = this.requireConnection(CREATE_MEMORY_PROJECT_TOOL);
    let payload: unknown;
    try {
      const raw = await connection.call(
        CREATE_MEMORY_PROJECT_TOOL,
        argumentsForProjectCreate(project, projectPath),
        this.timeoutMs
      );
      payload = normalizeToolResponse(raw);
    } catch (cause) {
      throw projectCreateFailure(cause);
    }
    const result = decodeProjectCreateResponse(payload, project, projectPath);
    const confirmed = await this.listProjects();
    if (!confirmed.some((entry) => entry.name === project && projectPathMatches(entry.path, projectPath))) {
      throw protocolError('create_memory_project did not make the exact project available');
    }
    return result;
  }

  async search(input: BackendSearch): Promise<{ hits: BackendHit[]; has_more: boolean }> {
    this.assertProject(input.project);
    const argumentsForRequest = argumentsForSearch(input);
    return this.read(SEARCH_NOTES_TOOL, async (connection) => {
      const raw = await connection.call(SEARCH_NOTES_TOOL, argumentsForRequest, this.timeoutMs);
      return decodeSearchResponse(normalizeToolResponse(raw));
    });
  }

  async isIndexed(project: string, revision_id: string): Promise<boolean> {
    this.assertProject(project);
    return this.read('is_indexed', async (connection) => {
      const raw = await connection.call(
        SEARCH_NOTES_TOOL,
        argumentsForIndexedLookup(project, revision_id),
        this.timeoutMs
      );
      return decodeSearchResponse(normalizeToolResponse(raw)).hits.length > 0;
    });
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) {
      await connection.close();
    }
  }

  private assertProject(project: string): void {
    if (!this.projects.has(project)) {
      throw invalidInput(`backend project ${project} is not configured`);
    }
  }

  private async listProjectNames(): Promise<string[]> {
    return this.read(LIST_MEMORY_PROJECTS_TOOL, async (connection) => {
      const raw = await connection.call(
        LIST_MEMORY_PROJECTS_TOOL,
        { output_format: 'json' },
        this.timeoutMs
      );
      return decodeProjectNames(normalizeToolResponse(raw));
    });
  }

  private async listProjects(): Promise<Array<{ name: string; path: string }>> {
    return this.read(LIST_MEMORY_PROJECTS_TOOL, async (connection) => {
      const raw = await connection.call(
        LIST_MEMORY_PROJECTS_TOOL,
        { output_format: 'json' },
        this.timeoutMs
      );
      return decodeProjects(normalizeToolResponse(raw));
    });
  }

  private requireConnection(operation: string): BackendConnection {
    if (this.connection === undefined) {
      throw transportFailure(operation, new Error('backend is not connected'));
    }
    return this.connection;
  }

  private async read<T>(
    operation: string,
    run: (connection: BackendConnection) => Promise<T>
  ): Promise<T> {
    let lastError: BrainError | undefined;
    for (let attempt = 1; attempt <= this.readAttempts; attempt += 1) {
      const connection = this.requireConnection(operation);
      try {
        return await run(connection);
      } catch (error) {
        if (isBrainError(error)) throw error;
        lastError = transportFailure(operation, error);
        if (attempt < this.readAttempts && this.readRetryDelayMs > 0) {
          await delay(this.readRetryDelayMs);
        }
      }
    }
    throw lastError ?? transportFailure(operation);
  }
}

function transportFailure(operation: string, cause?: unknown): BrainError {
  const detail =
    cause instanceof Error
      ? cause.message
      : cause === undefined
        ? 'no transport is available'
        : String(cause);
  return new BrainError({
    code: 'BACKEND_UNAVAILABLE',
    message: `backend ${operation} is unavailable: ${detail}`.slice(0, ERROR_MESSAGE_MAX_CHARS),
    cause
  });
}

function writeFailure(cause: unknown): BrainError {
  if (isBrainError(cause)) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new BrainError({
    code: 'BACKEND_UNAVAILABLE',
    message: `write_note did not confirm persistence (${detail}); the mutation reconciler must verify materialization`,
    cause
  });
}

function projectCreateFailure(cause: unknown): BrainError {
  return new BrainError({
    code: 'BACKEND_UNAVAILABLE',
    message: 'create_memory_project failed without a verified project',
    cause
  });
}
