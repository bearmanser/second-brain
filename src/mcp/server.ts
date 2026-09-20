import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ResultDelivery } from '../config/schema.js';
import { isBrainError } from '../contracts/errors.js';
import type {
  CaptureRequest,
  FeedbackRequest,
  FeedbackResult,
  MutationReceipt,
  ReadRequest,
  ReadResult,
  RecallRequest,
  RecallResult,
  RequestContext,
  ReviewListResult,
  ReviewRequest,
  StatusRequest,
  StatusResult
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
  type ToolName
} from './tools.js';

export interface BrainServices {
  capture(ctx: RequestContext, request: CaptureRequest): Promise<MutationReceipt>;
  review(ctx: RequestContext, request: ReviewRequest): Promise<MutationReceipt | ReviewListResult>;
  recall(ctx: RequestContext, request: RecallRequest): Promise<RecallResult>;
  read(ctx: RequestContext, request: ReadRequest): Promise<ReadResult>;
  feedback(ctx: RequestContext, request: FeedbackRequest): Promise<FeedbackResult>;
  status(ctx: RequestContext, request: StatusRequest): Promise<StatusResult>;
  readonly result_delivery?: ResultDelivery;
  readonly reportDiagnostic?: (message: string) => void;
}

export const OUTPUT_SCHEMA_META_KEY = 'second-brain/outputSchema';

type ToolInvoker = (
  services: BrainServices,
  ctx: RequestContext,
  args: unknown
) => Promise<unknown>;

const TOOL_HANDLERS: Record<ToolName, ToolInvoker> = {
  brain_capture: (services, ctx, args) => services.capture(ctx, args as CaptureRequest),
  brain_feedback: (services, ctx, args) => services.feedback(ctx, args as FeedbackRequest),
  brain_read: (services, ctx, args) => services.read(ctx, args as ReadRequest),
  brain_recall: (services, ctx, args) => services.recall(ctx, args as RecallRequest),
  brain_review: (services, ctx, args) => services.review(ctx, args as ReviewRequest),
  brain_status: (services, ctx, args) => services.status(ctx, args as StatusRequest)
};

export function createMcpServer(services: BrainServices, ctx: RequestContext): McpServer {
  const server = new McpServer(
    { name: APPLICATION_NAME, version: APPLICATION_VERSION },
    { instructions: buildInstructions() }
  );
  const delivery: ResultDelivery = services.result_delivery ?? 'structured';

  for (const definition of toolDefinitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.annotations.title,
        description: definition.description,
        inputSchema: requestSchemas[definition.name],
        annotations: { ...definition.annotations },
        _meta: { [OUTPUT_SCHEMA_META_KEY]: definition.outputSchema }
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

  return server;
}
