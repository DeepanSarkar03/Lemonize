import { handleScanRequest } from './scanner.js';

interface AppwriteFunctionRequest {
  method: string;
  path?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  bodyText?: string;
}

interface AppwriteFunctionResponse {
  json(
    body: unknown,
    statusCode?: number,
    headers?: Record<string, string>,
  ): unknown;
}

interface AppwriteFunctionContext {
  req: AppwriteFunctionRequest;
  res: AppwriteFunctionResponse;
  error?: (message: string) => void;
}

function standardHeaders(input: AppwriteFunctionRequest['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return headers;
}

/** Appwrite Node runtime entrypoint. */
export default async function main(context: AppwriteFunctionContext): Promise<unknown> {
  try {
    const method = context.req.method || 'POST';
    const path = context.req.path?.startsWith('/')
      ? context.req.path
      : `/${context.req.path ?? ''}`;
    const url = context.req.url
      ? new URL(context.req.url, 'http://function.local').toString()
      : `http://function.local${path}`;
    const request = new Request(url, {
      method,
      headers: standardHeaders(context.req.headers),
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: context.req.bodyText ?? '' }),
    });
    const response = await handleScanRequest(request);
    const payload: unknown = await response.json();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return context.res.json(payload, response.status, headers);
  } catch {
    context.error?.('artifact-scanner: request adapter failed');
    return context.res.json(
      { ok: false, error: { code: 'scanner_failure' } },
      500,
      { 'cache-control': 'no-store' },
    );
  }
}

export { executeScan, handleScanRequest, parseScanJob } from './scanner.js';
export { signRequest, signedHeaders, verifyRequestSignature } from './signing.js';
export { validateGzipTar } from './tar.js';
export type { ScanJob, ScanResult, ScannerConfig } from './types.js';
