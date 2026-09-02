export const ErrorCodes = {
  internal: 'SYS-001',
  databaseUnreachable: 'DB-001',
  notFound: 'API-001',
  invalidRequest: 'API-002',
  config: 'CFG-001',
  authInvalidRequest: 'AUTH-001',
  authInvalidCredentials: 'AUTH-002',
  authEmailNotVerified: 'AUTH-003',
  authRateLimited: 'AUTH-004',
  authSessionInvalid: 'AUTH-005',
  authSessionExpired: 'AUTH-006',
  authVerificationTokenInvalid: 'AUTH-007',
  authResetTokenInvalid: 'AUTH-008',
  authTwoFactorRequired: 'AUTH-009',
  authTwoFactorInvalid: 'AUTH-010',
  authRecoveryCodeInvalid: 'AUTH-011',
  authCsrfInvalid: 'AUTH-012',
  authAccountDisabled: 'AUTH-013',
  authPasswordPolicy: 'AUTH-014',
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
