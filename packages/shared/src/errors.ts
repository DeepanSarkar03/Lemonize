/** Canonical error codes shared by the API, CLI and web client. */
export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  PACKAGE_NOT_FOUND: 'PACKAGE_NOT_FOUND',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  VERSION_EXISTS: 'VERSION_EXISTS',
  NAME_RESERVED: 'NAME_RESERVED',
  NAME_TAKEN: 'NAME_TAKEN',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
  RATE_LIMITED: 'RATE_LIMITED',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  ARTIFACT_MISSING: 'ARTIFACT_MISSING',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

/** Thrown inside the Worker; carries an HTTP status + canonical code. */
export class LemonizeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LemonizeError';
  }
}

export const badRequest = (m: string, d?: unknown) =>
  new LemonizeError(400, ErrorCodes.BAD_REQUEST, m, d);
export const unauthorized = (m = 'Authentication required') =>
  new LemonizeError(401, ErrorCodes.UNAUTHORIZED, m);
export const forbidden = (m = 'You do not have permission to perform this action') =>
  new LemonizeError(403, ErrorCodes.FORBIDDEN, m);
export const notFound = (code: ErrorCode, m: string) => new LemonizeError(404, code, m);
export const conflict = (code: ErrorCode, m: string) => new LemonizeError(409, code, m);
export const tooLarge = (m: string) => new LemonizeError(413, ErrorCodes.PAYLOAD_TOO_LARGE, m);
export const rateLimited = (m = 'Rate limit exceeded') =>
  new LemonizeError(429, ErrorCodes.RATE_LIMITED, m);
