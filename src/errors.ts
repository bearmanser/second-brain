export type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'LIMIT_EXCEEDED';

export class BrainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
  }
}

export const invalidInput = (message: string): BrainError => new BrainError('INVALID_INPUT', message);
export const notFound = (message: string): BrainError => new BrainError('NOT_FOUND', message);
export const conflict = (message: string): BrainError => new BrainError('CONFLICT', message);
export const limitExceeded = (message: string): BrainError => new BrainError('LIMIT_EXCEEDED', message);

export function isBrainError(value: unknown): value is BrainError {
  return value instanceof BrainError;
}
