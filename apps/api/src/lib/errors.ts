export const ErrorCodes = {
  internal: 'SYS-001',
  databaseUnreachable: 'DB-001',
  notFound: 'API-001',
  invalidRequest: 'API-002',
  config: 'CFG-001',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toErrorBody(code: string, message: string, traceId: string) {
  return {
    error: {
      code,
      message,
      trace_id: traceId,
    },
  };
}

