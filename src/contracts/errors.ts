export const BRAIN_ERROR_CODES = [
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'SCOPE_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'UNSUPPORTED_SCHEMA',
  'BACKEND_UNAVAILABLE',
  'BACKEND_PROTOCOL_ERROR',
  'EMBEDDINGS_UNAVAILABLE',
  'LIMIT_EXCEEDED',
  'RECOVERY_REQUIRED',
  'CANCELLED'
] as const;

export type BrainErrorCode = (typeof BRAIN_ERROR_CODES)[number];

const RETRYABLE_CODES: readonly BrainErrorCode[] = [
  'BACKEND_UNAVAILABLE',
  'EMBEDDINGS_UNAVAILABLE',
  'RECOVERY_REQUIRED',
  'CANCELLED'
];

export interface BrainErrorInput {
  code: BrainErrorCode;
  message: string;
  retryable?: boolean;
  operation_id?: string;
  cause?: unknown;
}

export class BrainError extends Error {
  readonly code: BrainErrorCode;
  readonly retryable: boolean;
  readonly operation_id?: string;

  constructor(input: BrainErrorInput) {
    super(`${input.code}: ${input.message}`, { cause: input.cause });
    this.name = 'BrainError';
    this.code = input.code;
    this.retryable = input.retryable ?? RETRYABLE_CODES.includes(input.code);
    this.operation_id = input.operation_id;
  }
}

export const isBrainError = (value: unknown): value is BrainError =>
  value instanceof BrainError;
