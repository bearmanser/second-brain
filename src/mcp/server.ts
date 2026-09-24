import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ResultDelivery } from '../config/schema.js';
import { isBrainError } from '../contracts/errors.js';
import { ETAG_PATTERN, SCOPE_ID_PATTERN } from '../core/limits.js';
import {
  LIFECYCLES,
  NOTE_KINDS,
  type AuthenticatedContext,
  type CaptureRequest,
  type FeedbackRequest,
  type FeedbackResult,
  type MutationReceipt,
  type ProjectEnsureRequest,
  type ProjectEnsureResult,
  type ReadRequest,
  type ReadResult,
  type RecallRequest,
  type RecallResult,
  type ReviewListResult,
  type ReviewRequest,
  type StatusRequest,
  type StatusResult
} from '../core/types.js';
import { buildInstructions } from './instructions.js';
import {
  APPLICATION_NAME,
  APPLICATION_VERSION,
  requestSchemas,
  toolDefinitions,
  toToolError,
  toToolResult,
  internalDiagnostic,
  type ToolDefinition,
  type ToolName
} from './tools.js';

export interface BrainServices {
  capture(ctx: AuthenticatedContext, request: CaptureRequest): Promise<MutationReceipt>;
  review(ctx: AuthenticatedContext, request: ReviewRequest): Promise<MutationReceipt | ReviewListResult>;
  recall(ctx: AuthenticatedContext, request: RecallRequest): Promise<RecallResult>;
  read(ctx: AuthenticatedContext, request: ReadRequest): Promise<ReadResult>;
  feedback(ctx: AuthenticatedContext, request: FeedbackRequest): Promise<FeedbackResult>;
  projectEnsure(ctx: AuthenticatedContext, request: ProjectEnsureRequest): Promise<ProjectEnsureResult>;
  status(ctx: AuthenticatedContext, request: StatusRequest): Promise<StatusResult>;
  readonly result_delivery?: ResultDelivery;
  readonly reportDiagnostic?: (message: string) => void;
}

export const OUTPUT_SCHEMA_META_KEY = 'second-brain/outputSchema';

const scopeIdOutputSchema = z.string().regex(SCOPE_ID_PATTERN);
const uuidOutputSchema = z.uuid();
const etagOutputSchema = z.string().regex(ETAG_PATTERN);
const stringListOutputSchema = z.array(z.string());

const sourceRefOutputSchema = z.strictObject({
  id: z.string(),
  revision_id: z.string().optional(),
  scope: z.string(),
  title: z.string(),
  kind: z.enum(NOTE_KINDS),
  status: z.enum(LIFECYCLES),
  etag: etagOutputSchema,
  relative_path: z.string(),
  heading: z.string().nullable().optional(),
  start_line: z.number().optional(),
  end_line: z.number().optional(),
  warnings: stringListOutputSchema
});

const recallItemOutputSchema = sourceRefOutputSchema.extend({
  excerpt: z.string(),
  reasons: stringListOutputSchema
});

const mutationReceiptOutputSchema = z.strictObject({
  operation_id: uuidOutputSchema,
  id: uuidOutputSchema,
  revision_id: uuidOutputSchema,
  outcome: z.enum(['stored', 'stored_conflict', 'pending']),
  materialized: z.boolean(),
  indexed: z.boolean(),
  etag: etagOutputSchema.optional(),
  possible_duplicates: z.array(sourceRefOutputSchema),
  warnings: stringListOutputSchema
});

const reviewListOutputSchema = z.strictObject({
  items: z.array(sourceRefOutputSchema),
  next_cursor: z.string().optional()
});

const reviewResultSchema = z.union([mutationReceiptOutputSchema, reviewListOutputSchema]);

const readOutputSchema = z.strictObject({
  source: sourceRefOutputSchema,
  markdown: z.string(),
  next_cursor: z.string().optional()
});

const recallOutputSchema = z.strictObject({
  retrieval_id: uuidOutputSchema,
  mode: z.enum(['text', 'reranked', 'hybrid']),
  partial: z.boolean(),
  warnings: stringListOutputSchema,
  budget: z.strictObject({
    tokenizer: z.literal('cl100k_base'),
    used: z.number(),
    limit: z.number()
  }),
  items: z.array(recallItemOutputSchema)
});

const feedbackOutputSchema = z.strictObject({
  feedback_id: uuidOutputSchema,
  recorded: z.literal(true)
});

const projectEnsureOutputSchema = z.strictObject({
  operation_id: uuidOutputSchema,
  repository_identity: z.string(),
  scope: scopeIdOutputSchema,
  project_id: z.string().optional(),
  relative_root: z.string().optional(),
  created: z.boolean(),
  backend_ready: z.boolean(),
  materialized: z.boolean(),
  warnings: stringListOutputSchema
});

const statusOutputSchema = z.strictObject({
  version: z.string(),
  protocol_version: z.string(),
  schema_version: z.literal(1),
  protocol: z.literal(2).optional(),
  scopes: z.array(
    z.strictObject({
      id: scopeIdOutputSchema
    })
  ),
  health: z.strictObject({
    gateway: z.enum(['ready', 'recovering', 'degraded']),
    backend: z.enum(['ready', 'unavailable']),
    embeddings: z.enum(['ready', 'unavailable', 'unknown'])
  }),
  local: z
    .strictObject({
      index: z.strictObject({
        state: z.enum(['ready', 'unavailable']),
        documents: z.number().optional()
      }),
      worker: z.strictObject({
        state: z.string(),
        model_fingerprint: z.string().optional()
      })
    })
    .optional(),
  features: z
    .strictObject({
      reranking: z.boolean(),
      text_search: z.boolean(),
      fallback: z.boolean()
    })
    .optional(),
  pending_operations: z.number(),
  projects: z
    .array(
      z.strictObject({
        scope: scopeIdOutputSchema,
        state: z.enum(['provisioning', 'ready', 'recovery_required']),
        display_name: z.string().optional(),
        relative_root: z.string().optional()
      })
    )
    .optional(),
  operation: z.union([mutationReceiptOutputSchema, projectEnsureOutputSchema]).optional(),
  schemas: z.record(z.string(), z.unknown()).optional()
});

const TOOL_OUTPUT_SCHEMAS: Partial<Record<ToolName, z.ZodType>> = {
  brain_capture: mutationReceiptOutputSchema,
  brain_feedback: feedbackOutputSchema,
  brain_project_ensure: projectEnsureOutputSchema,
  brain_read: readOutputSchema,
  brain_recall: recallOutputSchema,
  brain_status: statusOutputSchema
};

export function publishedOutputSchema(definition: ToolDefinition): Record<string, unknown> {
  if (definition.name === 'brain_review') {
    const branches = (definition.outputSchema as { oneOf?: unknown[] }).oneOf ?? [];
    return { type: 'object', oneOf: branches };
  }
  return definition.outputSchema;
}

export function publishedTools(): Tool[] {
  return toolDefinitions.map((definition) => ({
    name: definition.name,
    title: definition.annotations.title,
    description: definition.description,
    inputSchema: definition.inputSchema as Tool['inputSchema'],
    outputSchema: publishedOutputSchema(definition) as NonNullable<Tool['outputSchema']>,
    annotations: { ...definition.annotations },
    _meta: { [OUTPUT_SCHEMA_META_KEY]: definition.outputSchema }
  }));
}

type ToolInvoker = (
  services: BrainServices,
  ctx: AuthenticatedContext,
  args: unknown
) => Promise<unknown>;

const TOOL_HANDLERS: Record<ToolName, ToolInvoker> = {
  brain_capture: (services, ctx, args) => services.capture(ctx, args as CaptureRequest),
  brain_feedback: (services, ctx, args) => services.feedback(ctx, args as FeedbackRequest),
  brain_project_ensure: (services, ctx, args) =>
    services.projectEnsure(ctx, args as ProjectEnsureRequest),
  brain_read: (services, ctx, args) => services.read(ctx, args as ReadRequest),
  brain_recall: (services, ctx, args) => services.recall(ctx, args as RecallRequest),
  brain_review: async (services, ctx, args) =>
    reviewResultSchema.parse(await services.review(ctx, args as ReviewRequest)),
  brain_status: (services, ctx, args) => services.status(ctx, args as StatusRequest)
};

export function createMcpServer(services: BrainServices, ctx: AuthenticatedContext): McpServer {
  const server = new McpServer(
    { name: APPLICATION_NAME, version: APPLICATION_VERSION },
    { instructions: buildInstructions() }
  );
  const delivery: ResultDelivery = services.result_delivery ?? 'structured';

  for (const definition of toolDefinitions) {
    const outputSchema = TOOL_OUTPUT_SCHEMAS[definition.name];
    server.registerTool(
      definition.name,
      {
        title: definition.annotations.title,
        description: definition.description,
        inputSchema: requestSchemas[definition.name],
        annotations: { ...definition.annotations },
        _meta: { [OUTPUT_SCHEMA_META_KEY]: definition.outputSchema },
        ...(outputSchema === undefined ? {} : { outputSchema })
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await TOOL_HANDLERS[definition.name](services, ctx, args);
          return toToolResult(definition.name, result, delivery) as unknown as CallToolResult;
        } catch (error) {
          if (!isBrainError(error)) {
            services.reportDiagnostic?.(internalDiagnostic(error));
          }
          return toToolError(error) as unknown as CallToolResult;
        }
      }
    );
  }

  const tools = publishedTools();
  server.server.removeRequestHandler('tools/list');
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  return server;
}
