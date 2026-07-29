import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings } from '../src/lib/env.js';
import { AppwriteError } from '../src/lib/appwrite.js';
import { handleError } from '../src/lib/errors.js';

function diagnosticApp(role: 'admin' | 'publisher') {
  const app = new Hono<AppBindings>();
  app.get('/', (c) => {
    c.set('requestId', 'request-1');
    c.set('role', role);
    throw new AppwriteError({
      kind: 'appwrite_error',
      status: 400,
      responseType: 'row_invalid_structure',
      requestId: 'dependency-request-1',
      message: 'Appwrite request failed with status 400.',
    });
  });
  app.onError((error, c) => handleError(error, c));
  return app;
}

describe('internal error diagnostics', () => {
  it('returns only redacted Appwrite metadata to administrators', async () => {
    const response = await diagnosticApp('admin').request('/');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'INTERNAL',
        requestId: 'request-1',
        details: {
          dependency: 'appwrite',
          kind: 'appwrite_error',
          status: 400,
          responseType: 'row_invalid_structure',
          dependencyRequestId: 'dependency-request-1',
        },
      },
    });
  });

  it('does not disclose dependency diagnostics to publishers', async () => {
    const response = await diagnosticApp('publisher').request('/');
    const body = (await response.json()) as { error: { details?: unknown } };

    expect(response.status).toBe(500);
    expect(body.error.details).toBeUndefined();
  });
});
