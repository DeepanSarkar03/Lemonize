import type { Context } from 'hono';
import { LemonizeError, ErrorCodes, type ApiErrorBody } from '@lemonize/shared';
import type { AppBindings } from './env.js';

export function errorBody(code: ApiErrorBody['error']['code'], message: string, requestId: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, requestId, ...(details ? { details } : {}) } };
}

export function handleError(err: unknown, c: Context<AppBindings>): Response {
  const requestId = c.get('requestId') ?? 'unknown';
  if (err instanceof LemonizeError) {
    return c.json(errorBody(err.code, err.message, requestId, err.details), err.status as 400);
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'SyntaxError' &&
    c.req.header('content-type')?.toLowerCase().includes('application/json')
  ) {
    return c.json(
      errorBody(ErrorCodes.VALIDATION_FAILED, 'Request body must contain valid JSON.', requestId),
      400,
    );
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  ) {
    const issues = (err as { issues: Array<{ path?: unknown; code?: unknown }> }).issues.map(
      (issue) => ({
        path: Array.isArray(issue.path) ? issue.path.slice(0, 8) : [],
        code: typeof issue.code === 'string' ? issue.code : 'invalid',
      }),
    );
    return c.json(
      errorBody(ErrorCodes.VALIDATION_FAILED, 'Request validation failed.', requestId, issues),
      400,
    );
  }
  console.error(`[${requestId}] Unhandled error:`, err);
  return c.json(
    errorBody(ErrorCodes.INTERNAL, 'An unexpected error occurred.', requestId),
    500,
  );
}
