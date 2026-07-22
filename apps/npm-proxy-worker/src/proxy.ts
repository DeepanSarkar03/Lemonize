import {
  MAX_AUDIT_BYTES,
  MAX_PACKUMENT_BYTES,
  MAX_TARBALL_BYTES,
  METADATA_TTL_SECONDS,
  NEGATIVE_TTL_SECONDS,
  PUBLIC_ORIGIN,
  UPSTREAM_ORIGIN,
  InvalidNpmPathError,
  classifyPath,
  packumentPath,
  rewritePackumentTarballs,
  selectPackumentRepresentation,
  tarballPath,
  type MetadataRoute,
  type NpmRoute,
  type PackumentRepresentation,
  type TarballRoute,
} from './protocol.js';
import {
  hashClientIp,
  type AdmissionCandidate,
  type AdmissionDecision,
  type OriginRouteClass,
} from './admission.js';

const MAX_REQUEST_URL_BYTES = 8192;
const BUFFERED_PACKUMENT_BYTES = 256 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PING_BYTES = 64 * 1024;
const IMMUTABLE_TTL_SECONDS = 365 * 24 * 60 * 60;
export const METADATA_AUDIT_TIMEOUT_MS = 10_000;
export const TARBALL_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NEGATIVE_STATUSES = new Set([404, 410]);
const STRIPPED_RESPONSE_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

export interface CacheStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface ProxyDependencies {
  fetch(request: Request): Promise<Response>;
  getCache(): CacheStore | null;
  admitOrigin(candidate: AdmissionCandidate): Promise<AdmissionDecision>;
  metadataAuditTimeoutMs?: number;
  tarballTimeoutMs?: number;
}

export interface ProxyRuntime {
  waitUntil(promise: Promise<unknown>): void;
}

type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

class ProxyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ProxyHttpError';
  }
}

async function requireOriginAdmission(
  request: Request,
  dependencies: ProxyDependencies,
  routeClass: OriginRouteClass,
): Promise<void> {
  let decision: AdmissionDecision;
  try {
    decision = await dependencies.admitOrigin({
      clientIpHash: await hashClientIp(request),
      routeClass,
    });
  } catch {
    throw new ProxyHttpError(
      503,
      'ADMISSION_UNAVAILABLE',
      'The npm proxy admission controller is unavailable.',
    );
  }

  if (!decision.allowed) {
    throw new ProxyHttpError(
      429,
      'ORIGIN_BUDGET_EXHAUSTED',
      'The npm proxy origin budget is temporarily exhausted.',
      Math.max(1, Math.ceil(decision.retryAfterSeconds)),
    );
  }
}

function cleanHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  headers.delete('cf-cache-status');
  headers.delete('x-cache');
  headers.delete('x-lemonize-cache');
  return headers;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  allow?: string,
): Response {
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-lemonize-cache': 'BYPASS',
  });
  if (allow) headers.set('allow', allow);
  return new Response(JSON.stringify({ error: message, code, requestId }), { status, headers });
}

function finalizeResponse(response: Response, requestId: string): Response {
  const cacheStatus = response.headers.get('x-lemonize-cache');
  const headers = cleanHeaders(response.headers);
  if (cacheStatus) headers.set('x-lemonize-cache', cacheStatus);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  headers.set('x-request-id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function clientResponse(
  response: Response,
  cacheStatus: CacheStatus,
  requestMethod: string,
  requestHeaders?: Headers,
): Response {
  const headers = cleanHeaders(response.headers);
  headers.set('x-lemonize-cache', cacheStatus);

  const etag = headers.get('etag');
  const ifNoneMatch = requestHeaders?.get('if-none-match');
  if (
    response.status === 200 &&
    etag &&
    ifNoneMatch &&
    (ifNoneMatch.trim() === '*' ||
      ifNoneMatch.split(',').some((candidate) => candidate.trim() === etag))
  ) {
    void response.body?.cancel().catch(() => undefined);
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }

  if (requestMethod === 'HEAD') void response.body?.cancel().catch(() => undefined);
  return new Response(requestMethod === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw))
    throw new ProxyHttpError(
      502,
      'INVALID_UPSTREAM_LENGTH',
      'The npm registry returned an invalid Content-Length.',
    );
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ProxyHttpError(
      502,
      'INVALID_UPSTREAM_LENGTH',
      'The npm registry returned an invalid Content-Length.',
    );
  }
  return value;
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maximumBytes: number,
  tooLargeStatus: number,
  tooLargeCode: string,
  tooLargeMessage: string,
  idleTimeoutMilliseconds?: number,
): Promise<Uint8Array> {
  const declaredLength = parseContentLength(headers);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    if (stream) await stream.cancel().catch(() => undefined);
    throw new ProxyHttpError(tooLargeStatus, tooLargeCode, tooLargeMessage);
  }
  if (!stream) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    let result = await readWithIdleTimeout(reader, idleTimeoutMilliseconds);
    while (!result.done) {
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProxyHttpError(tooLargeStatus, tooLargeCode, tooLargeMessage);
      }
      chunks.push(result.value);
      result = await readWithIdleTimeout(reader, idleTimeoutMilliseconds);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMilliseconds?: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!timeoutMilliseconds) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutError = new ProxyHttpError(
    504,
    'UPSTREAM_TIMEOUT',
    'The npm registry response timed out.',
  );
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(timeoutError);
          queueMicrotask(() => {
            void reader.cancel('upstream response idle timeout').catch(() => undefined);
          });
        }, timeoutMilliseconds);
      }),
    ]);
    if (timedOut) throw timeoutError;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readAuditBody(request: Request): Promise<Uint8Array> {
  try {
    return await readStreamLimited(
      request.body,
      request.headers,
      MAX_AUDIT_BYTES,
      413,
      'AUDIT_PAYLOAD_TOO_LARGE',
      'npm audit payloads are limited to 1 MiB.',
    );
  } catch (error) {
    if (error instanceof ProxyHttpError) throw error;
    throw new ProxyHttpError(
      400,
      'INVALID_AUDIT_PAYLOAD',
      'The npm audit payload could not be read.',
    );
  }
}

function limitedPassthroughStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  idleTimeoutMilliseconds?: number,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await readWithIdleTimeout(reader, idleTimeoutMilliseconds);
        if (result.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        total += result.value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel('upstream response exceeds proxy size limit').catch(() => undefined);
          controller.error(new Error('Upstream response exceeded the streaming size limit.'));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * Rewrite an ASCII URL prefix while preserving a bounded UTF-8 stream.
 *
 * Keeping only search.length - 1 trailing characters between chunks makes
 * replacements work even when npm splits the URL across network frames. This
 * lets free-tier mode keep large packuments on Lemonize without retaining or
 * parsing the complete JSON document in Worker memory.
 */
function replaceUtf8Stream(
  stream: ReadableStream<Uint8Array>,
  search: string,
  replacement: string,
  maximumBytes: number,
  idleTimeoutMilliseconds?: number,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const encoder = new TextEncoder();
  let pending = '';
  let upstreamBytes = 0;
  let emittedBytes = 0;

  const replace = (value: string) => value.split(search).join(replacement);

  const encodeLimited = (value: string): Uint8Array => {
    const encoded = encoder.encode(value);
    emittedBytes += encoded.byteLength;
    if (emittedBytes > maximumBytes) {
      throw new Error('Rewritten response exceeded the streaming size limit.');
    }
    return encoded;
  };

  const replaceCompleteMatches = (value: string): string => {
    let cursor = 0;
    let output = '';
    for (;;) {
      const index = value.indexOf(search, cursor);
      if (index < 0) break;
      output += value.slice(cursor, index) + replacement;
      cursor = index + search.length;
    }

    const remainder = value.slice(cursor);
    let retainedCharacters = Math.min(search.length - 1, remainder.length);
    while (retainedCharacters > 0 && !remainder.endsWith(search.slice(0, retainedCharacters))) {
      retainedCharacters -= 1;
    }
    const emitLength = remainder.length - retainedCharacters;
    pending = remainder.slice(emitLength);
    return output + remainder.slice(0, emitLength);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await readWithIdleTimeout(reader, idleTimeoutMilliseconds);
        if (result.done) {
          const output = replace(pending + decoder.decode());
          if (output.length > 0) controller.enqueue(encodeLimited(output));
          controller.close();
          reader.releaseLock();
          return;
        }

        upstreamBytes += result.value.byteLength;
        if (upstreamBytes > maximumBytes) {
          await reader.cancel('upstream response exceeds proxy size limit').catch(() => undefined);
          controller.error(new Error('Upstream response exceeded the streaming size limit.'));
          return;
        }

        const decoded = pending + decoder.decode(result.value, { stream: true });
        const output = replaceCompleteMatches(decoded);
        if (output.length > 0) controller.enqueue(encodeLimited(output));
      } catch (error) {
        await reader.cancel('invalid upstream packument stream').catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

async function sha256Etag(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  return `"sha256-${hex}"`;
}

function cacheKey(upstreamUrl: URL, publicOrigin: string, variant?: string): Request {
  const key = new URL(publicOrigin);
  key.pathname = `/__lemonize_cache__/${variant ?? 'default'}${upstreamUrl.pathname}`;
  key.search = upstreamUrl.search;
  return new Request(key, { method: 'GET' });
}

async function lookupCache(
  dependencies: ProxyDependencies,
  key: Request,
): Promise<{ cache: CacheStore | null; response?: Response; status: Exclude<CacheStatus, 'HIT'> }> {
  let cache: CacheStore | null;
  try {
    cache = dependencies.getCache();
  } catch {
    return { cache: null, status: 'BYPASS' };
  }
  if (!cache) return { cache: null, status: 'BYPASS' };

  try {
    const response = await cache.match(key);
    return response ? { cache, response, status: 'MISS' } : { cache, status: 'MISS' };
  } catch {
    return { cache: null, status: 'BYPASS' };
  }
}

function scheduleCachePut(
  runtime: ProxyRuntime,
  cache: CacheStore | null,
  key: Request,
  response: Response,
): void {
  if (!cache) return;
  const operation = cache.put(key, response).catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.warn(`npm proxy cache write failed (${name})`);
  });
  try {
    runtime.waitUntil(operation);
  } catch {
    void operation;
  }
}

function outboundMetadataHeaders(representation?: PackumentRepresentation): Headers {
  return new Headers({
    accept: representation?.accept ?? 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'Lemonize-npm-proxy/1.0',
  });
}

function copyHeaderIfPresent(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value !== null) to.set(name, value);
}

function outboundTarballHeaders(request: Request): Headers {
  const headers = new Headers({
    accept: '*/*',
    'accept-encoding': 'identity',
    'user-agent': 'Lemonize-npm-proxy/1.0',
  });
  for (const name of [
    'if-match',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'if-unmodified-since',
    'range',
  ]) {
    copyHeaderIfPresent(request.headers, headers, name);
  }
  return headers;
}

async function fetchFromRegistry(
  dependencies: ProxyDependencies,
  initialUrl: URL,
  method: 'GET' | 'HEAD' | 'POST',
  headers: Headers,
  timeoutMilliseconds: number,
  body?: Uint8Array,
  includeBodyInDeadline = true,
): Promise<Response> {
  const abortController = new AbortController();
  const deadline = { timedOut: false };
  const timeout = setTimeout(() => {
    deadline.timedOut = true;
    abortController.abort(new Error('npm registry deadline exceeded'));
  }, timeoutMilliseconds);
  let currentUrl = new URL(initialUrl);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    let response: Response;
    try {
      response = await dependencies.fetch(
        new Request(currentUrl, {
          method,
          headers,
          body: method === 'POST' ? body : undefined,
          redirect: 'manual',
          signal: abortController.signal,
        }),
      );
    } catch {
      clearTimeout(timeout);
      if (deadline.timedOut || abortController.signal.aborted) {
        throw new ProxyHttpError(504, 'UPSTREAM_TIMEOUT', 'The npm registry request timed out.');
      }
      throw new ProxyHttpError(
        502,
        'UPSTREAM_UNAVAILABLE',
        'The npm registry could not be reached.',
      );
    }

    if (deadline.timedOut) {
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(504, 'UPSTREAM_TIMEOUT', 'The npm registry request timed out.');
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!includeBodyInDeadline) {
        clearTimeout(timeout);
        return response;
      }
      if (!response.body) {
        clearTimeout(timeout);
        return response;
      }

      const reader = response.body.getReader();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
      };
      const timedBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              finish();
              reader.releaseLock();
              controller.close();
              return;
            }
            controller.enqueue(result.value);
          } catch (error) {
            finish();
            controller.error(
              deadline.timedOut
                ? new ProxyHttpError(
                    504,
                    'UPSTREAM_TIMEOUT',
                    'The npm registry response timed out.',
                  )
                : error,
            );
          }
        },
        async cancel(reason) {
          finish();
          abortController.abort(reason);
          await reader.cancel(reason).catch(() => undefined);
        },
      });
      return new Response(timedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    if (redirectCount === 3) {
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'UPSTREAM_REDIRECT_LIMIT',
        'The npm registry returned too many redirects.',
      );
    }

    const location = response.headers.get('location');
    if (!location) {
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'INVALID_UPSTREAM_REDIRECT',
        'The npm registry returned an invalid redirect.',
      );
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'INVALID_UPSTREAM_REDIRECT',
        'The npm registry returned an invalid redirect.',
      );
    }
    if (nextUrl.origin !== UPSTREAM_ORIGIN || nextUrl.username !== '' || nextUrl.password !== '') {
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'UNSAFE_UPSTREAM_REDIRECT',
        'The npm registry attempted to redirect outside its origin.',
      );
    }
    if (method === 'POST' && response.status !== 307 && response.status !== 308) {
      clearTimeout(timeout);
      await response.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'INVALID_UPSTREAM_REDIRECT',
        'The npm registry returned an unsafe audit redirect.',
      );
    }
    await response.body?.cancel().catch(() => undefined);
    currentUrl = nextUrl;
  }
  clearTimeout(timeout);
  throw new ProxyHttpError(
    502,
    'UPSTREAM_REDIRECT_LIMIT',
    'The npm registry returned too many redirects.',
  );
}

function upstreamUrl(pathname: string, search: string): URL {
  const url = new URL(UPSTREAM_ORIGIN);
  url.pathname = pathname;
  url.search = search;
  return url;
}

function canonicalSearch(route: NpmRoute, incomingUrl: URL): string {
  const input = incomingUrl.searchParams;
  if (route.kind === 'packument' || route.kind === 'tarball') {
    if (input.size > 0) {
      throw new InvalidNpmPathError('This npm route does not accept query parameters.');
    }
    return '';
  }

  if (route.kind === 'audit-bulk' || route.kind === 'audit-quick') {
    if (input.size > 0) {
      throw new InvalidNpmPathError('The npm audit routes do not accept query parameters.');
    }
    return '';
  }

  if (route.kind === 'ping') {
    const values = input.getAll('write');
    if (input.size === 0) return '';
    if (input.size !== 1 || values.length !== 1 || values[0] !== 'true') {
      throw new InvalidNpmPathError('The npm ping route accepts only write=true.');
    }
    return '?write=true';
  }

  const allowed = new Set(['text', 'size', 'from', 'quality', 'popularity', 'maintenance']);
  const seen = new Set<string>();
  const normalized = new Map<string, string>();

  for (const [key, value] of input) {
    if (!allowed.has(key) || seen.has(key)) {
      throw new InvalidNpmPathError('The npm route contains unsupported query parameters.');
    }
    seen.add(key);

    if (key === 'text') {
      const byteLength = new TextEncoder().encode(value).byteLength;
      if (byteLength < 1 || byteLength > 256) {
        throw new InvalidNpmPathError('The npm search text is invalid.');
      }
      normalized.set(key, value);
    } else if (key === 'size') {
      if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 250) {
        throw new InvalidNpmPathError('The npm search pagination parameter is invalid.');
      }
      normalized.set(key, String(Number(value)));
    } else if (key === 'from') {
      if (!/^\d{1,4}$/.test(value) || Number(value) > 5000) {
        throw new InvalidNpmPathError('The npm search pagination parameter is invalid.');
      }
      normalized.set(key, String(Number(value)));
    } else {
      if (!/^(?:0|1)(?:\.\d{1,3})?$/.test(value) || Number(value) > 1) {
        throw new InvalidNpmPathError('The npm search ranking parameter is invalid.');
      }
      normalized.set(key, String(Number(value)));
    }
  }

  if (!normalized.has('text')) {
    throw new InvalidNpmPathError('The npm search text parameter is required.');
  }
  const output = new URLSearchParams();
  for (const [key, fallback] of [
    ['text', ''],
    ['size', '20'],
    ['from', '0'],
    ['quality', '0.65'],
    ['popularity', '0.98'],
    ['maintenance', '0.5'],
  ] as const) {
    output.set(key, normalized.get(key) ?? fallback);
  }
  const encoded = output.toString();
  return encoded ? `?${encoded}` : '';
}

async function normalizedPackumentResponse(
  upstream: Response,
  representation: PackumentRepresentation,
  publicOrigin: string,
  rewriteLargePackuments: boolean,
  idleTimeoutMilliseconds: number,
): Promise<Response> {
  const declaredLength = parseContentLength(upstream.headers);
  if (declaredLength !== null && declaredLength > MAX_PACKUMENT_BYTES) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new ProxyHttpError(
      502,
      'PACKUMENT_TOO_LARGE',
      'The npm registry packument exceeds the 16 MiB proxy limit.',
    );
  }

  if (
    upstream.status >= 200 &&
    upstream.status < 300 &&
    upstream.body &&
    declaredLength !== null &&
    declaredLength > BUFFERED_PACKUMENT_BYTES &&
    !rewriteLargePackuments
  ) {
    const headers = cleanHeaders(upstream.headers);
    headers.set('content-type', `${representation.accept}; charset=utf-8`);
    headers.set('vary', 'Accept');
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.delete('content-md5');
    headers.delete('content-range');
    headers.delete('digest');
    headers.delete('etag');
    headers.set('x-lemonize-packument-mode', 'free-tier-streaming-rewrite');
    const upstreamPrefix = `${UPSTREAM_ORIGIN}/`;
    const publicPrefix = `${publicOrigin}/`;
    return new Response(
      replaceUtf8Stream(
        upstream.body,
        upstreamPrefix,
        publicPrefix,
        MAX_PACKUMENT_BYTES,
        idleTimeoutMilliseconds,
      ),
      { status: upstream.status, statusText: upstream.statusText, headers },
    );
  }

  const bytes = await readStreamLimited(
    upstream.body,
    upstream.headers,
    MAX_PACKUMENT_BYTES,
    502,
    'PACKUMENT_TOO_LARGE',
    'The npm registry packument exceeds the 16 MiB proxy limit.',
    idleTimeoutMilliseconds,
  );
  const headers = cleanHeaders(upstream.headers);
  headers.delete('content-encoding');
  headers.delete('content-md5');
  headers.delete('content-range');
  headers.delete('digest');
  headers.delete('etag');
  headers.delete('content-length');

  if (upstream.status < 200 || upstream.status >= 300) {
    headers.set('content-length', String(bytes.byteLength));
    return new Response(bytes, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ProxyHttpError(
      502,
      'INVALID_PACKUMENT',
      'The npm registry returned invalid package metadata.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProxyHttpError(
      502,
      'INVALID_PACKUMENT',
      'The npm registry returned invalid package metadata.',
    );
  }

  const output = new TextEncoder().encode(
    JSON.stringify(rewritePackumentTarballs(parsed, publicOrigin)),
  );
  if (output.byteLength > MAX_PACKUMENT_BYTES) {
    throw new ProxyHttpError(
      502,
      'PACKUMENT_TOO_LARGE',
      'The rewritten npm packument exceeds the 16 MiB proxy limit.',
    );
  }
  headers.set('content-length', String(output.byteLength));
  headers.set('content-type', `${representation.accept}; charset=utf-8`);
  headers.set('etag', await sha256Etag(output));
  headers.set('vary', 'Accept');
  return new Response(output, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function normalizedUtilityResponse(
  upstream: Response,
  maximumBytes: number,
  idleTimeoutMilliseconds: number,
): Promise<Response> {
  const bytes = await readStreamLimited(
    upstream.body,
    upstream.headers,
    maximumBytes,
    502,
    'UPSTREAM_RESPONSE_TOO_LARGE',
    'The npm registry utility response exceeds the proxy limit.',
    idleTimeoutMilliseconds,
  );
  const headers = cleanHeaders(upstream.headers);
  headers.delete('content-encoding');
  headers.delete('content-md5');
  headers.delete('content-range');
  headers.delete('digest');
  headers.set('content-length', String(bytes.byteLength));
  return new Response(bytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function applyMetadataCaching(response: Response): { response: Response; cacheable: boolean } {
  const headers = cleanHeaders(response.headers);
  let cacheable = false;
  if (response.status >= 200 && response.status < 300) {
    headers.set(
      'cache-control',
      `public, max-age=${METADATA_TTL_SECONDS}, s-maxage=${METADATA_TTL_SECONDS}`,
    );
    cacheable = true;
  } else if (NEGATIVE_STATUSES.has(response.status)) {
    headers.set(
      'cache-control',
      `public, max-age=${NEGATIVE_TTL_SECONDS}, s-maxage=${NEGATIVE_TTL_SECONDS}`,
    );
    cacheable = true;
  } else {
    headers.set('cache-control', 'no-store');
  }
  headers.delete('age');
  return {
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    cacheable,
  };
}

async function handleMetadata(
  request: Request,
  route: MetadataRoute,
  dependencies: ProxyDependencies,
  runtime: ProxyRuntime,
  publicOrigin: string,
  rewriteLargePackuments: boolean,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const representation =
    route.kind === 'packument'
      ? selectPackumentRepresentation(request.headers.get('accept'))
      : undefined;
  const pathname =
    route.kind === 'packument' ? packumentPath(route.packageName) : incomingUrl.pathname;
  const target = upstreamUrl(pathname, canonicalSearch(route, incomingUrl));
  const bypassCache = route.kind === 'ping' && target.search === '?write=true';
  const key = cacheKey(target, publicOrigin, representation?.variant);
  let cached = bypassCache
    ? { cache: null, status: 'BYPASS' as const }
    : await lookupCache(dependencies, key);
  if (cached.response)
    return clientResponse(cached.response, 'HIT', request.method, request.headers);

  await requireOriginAdmission(
    request,
    dependencies,
    route.kind === 'search' ? 'search' : 'metadata',
  );
  if (!bypassCache) {
    const rechecked = await lookupCache(dependencies, key);
    if (rechecked.response) {
      return clientResponse(rechecked.response, 'HIT', request.method, request.headers);
    }
    if (!cached.cache && rechecked.cache) cached = rechecked;
  }
  const upstream = await fetchFromRegistry(
    dependencies,
    target,
    'GET',
    outboundMetadataHeaders(representation),
    dependencies.metadataAuditTimeoutMs ?? METADATA_AUDIT_TIMEOUT_MS,
    undefined,
    false,
  );
  const idleTimeout = dependencies.metadataAuditTimeoutMs ?? METADATA_AUDIT_TIMEOUT_MS;
  const normalized =
    route.kind === 'packument'
      ? await normalizedPackumentResponse(
          upstream,
          representation ?? selectPackumentRepresentation(null),
          publicOrigin,
          rewriteLargePackuments,
          idleTimeout,
        )
      : await normalizedUtilityResponse(
          upstream,
          route.kind === 'search' ? MAX_SEARCH_BYTES : MAX_PING_BYTES,
          idleTimeout,
        );
  const cachePolicy = bypassCache
    ? {
        response: new Response(normalized.body, {
          status: normalized.status,
          statusText: normalized.statusText,
          headers: {
            ...Object.fromEntries(cleanHeaders(normalized.headers)),
            'cache-control': 'no-store',
          },
        }),
        cacheable: false,
      }
    : applyMetadataCaching(normalized);
  if (cachePolicy.cacheable)
    scheduleCachePut(runtime, cached.cache, key, cachePolicy.response.clone());
  return clientResponse(cachePolicy.response, cached.status, request.method, request.headers);
}

function parseContentRangeTotal(headers: Headers): number | null {
  const raw = headers.get('content-range');
  if (!raw) return null;
  const match = /^bytes\s+\d+-\d+\/(\d+|\*)$/i.exec(raw.trim());
  if (!match || match[1] === '*') return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : null;
}

function normalizedTarballResponse(
  upstream: Response,
  requestMethod: string,
  isRange: boolean,
  idleTimeoutMilliseconds: number,
): Response {
  const headers = cleanHeaders(upstream.headers);
  const declaredLength = parseContentLength(headers);

  if (upstream.status === 200) {
    if (declaredLength === null) {
      throw new ProxyHttpError(
        502,
        'UPSTREAM_LENGTH_REQUIRED',
        'The npm registry tarball response did not include a Content-Length.',
      );
    }
    if (declaredLength > MAX_TARBALL_BYTES) {
      void upstream.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'TARBALL_TOO_LARGE',
        'The npm tarball exceeds the 100 MiB proxy limit.',
      );
    }
    headers.set('cache-control', `public, max-age=${IMMUTABLE_TTL_SECONDS}, immutable`);
  } else if (upstream.status === 206) {
    const total = parseContentRangeTotal(headers);
    if (
      total === null ||
      total > MAX_TARBALL_BYTES ||
      (declaredLength !== null && declaredLength > MAX_TARBALL_BYTES)
    ) {
      void upstream.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'TARBALL_TOO_LARGE',
        'The npm tarball exceeds the 100 MiB proxy limit.',
      );
    }
    headers.set('cache-control', `public, max-age=${IMMUTABLE_TTL_SECONDS}, immutable`);
  } else if (NEGATIVE_STATUSES.has(upstream.status)) {
    headers.set(
      'cache-control',
      `public, max-age=${NEGATIVE_TTL_SECONDS}, s-maxage=${NEGATIVE_TTL_SECONDS}`,
    );
  } else if (upstream.status !== 304) {
    headers.set('cache-control', 'no-store');
  }
  headers.delete('age');

  const body =
    requestMethod !== 'HEAD' &&
    upstream.body &&
    (upstream.status === 200 || upstream.status === 206)
      ? limitedPassthroughStream(upstream.body, MAX_TARBALL_BYTES, idleTimeoutMilliseconds)
      : upstream.body;
  if (isRange) headers.set('accept-ranges', headers.get('accept-ranges') ?? 'bytes');
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

async function normalizedTarballHeadResponse(upstream: Response): Promise<Response> {
  const headers = cleanHeaders(upstream.headers);
  const declaredLength = parseContentLength(headers);
  let status = upstream.status;
  let statusText = upstream.statusText;

  if (upstream.status === 200) {
    if (declaredLength === null) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'UPSTREAM_LENGTH_REQUIRED',
        'The npm registry tarball response did not include a Content-Length.',
      );
    }
    if (declaredLength > MAX_TARBALL_BYTES) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'TARBALL_TOO_LARGE',
        'The npm tarball exceeds the 100 MiB proxy limit.',
      );
    }
    headers.set('cache-control', `public, max-age=${IMMUTABLE_TTL_SECONDS}, immutable`);
  } else if (upstream.status === 206) {
    const total = parseContentRangeTotal(headers);
    if (total === null || total > MAX_TARBALL_BYTES) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new ProxyHttpError(
        502,
        'TARBALL_TOO_LARGE',
        'The npm tarball exceeds the 100 MiB proxy limit.',
      );
    }
    status = 200;
    statusText = 'OK';
    headers.set('content-length', String(total));
    headers.delete('content-range');
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', `public, max-age=${IMMUTABLE_TTL_SECONDS}, immutable`);
  } else if (NEGATIVE_STATUSES.has(upstream.status)) {
    headers.set(
      'cache-control',
      `public, max-age=${NEGATIVE_TTL_SECONDS}, s-maxage=${NEGATIVE_TTL_SECONDS}`,
    );
  } else if (upstream.status !== 304) {
    headers.set('cache-control', 'no-store');
  }
  headers.delete('age');
  await upstream.body?.cancel().catch(() => undefined);
  return new Response(null, { status, statusText, headers });
}

async function handleTarball(
  request: Request,
  route: TarballRoute,
  dependencies: ProxyDependencies,
  runtime: ProxyRuntime,
  publicOrigin: string,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const target = upstreamUrl(tarballPath(route), canonicalSearch(route, incomingUrl));
  const key = cacheKey(target, publicOrigin);
  const isRange = request.method === 'GET' && request.headers.has('range');
  const range = request.headers.get('range');
  const hasPrecondition = [
    'if-match',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'if-unmodified-since',
  ].some((header) => request.headers.has(header));
  if (isRange) {
    const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/i.exec(range!.trim());
    const start = match?.[1] ? Number(match[1]) : null;
    const end = match?.[2] ? Number(match[2]) : null;
    const suffix = match?.[3] ? Number(match[3]) : null;
    if (
      !match ||
      (start !== null && (!Number.isSafeInteger(start) || start < 0)) ||
      (end !== null && (!Number.isSafeInteger(end) || end < start!)) ||
      (suffix !== null && (!Number.isSafeInteger(suffix) || suffix < 1))
    ) {
      throw new ProxyHttpError(416, 'INVALID_RANGE', 'Only one valid byte range is supported.');
    }
  }
  const rangeKey =
    isRange && !hasPrecondition ? new Request(key, { headers: { range: range as string } }) : key;
  let cached = hasPrecondition
    ? { cache: null, status: 'BYPASS' as const }
    : await lookupCache(dependencies, rangeKey);
  if (isRange && cached.response && cached.response.status !== 206) {
    await cached.response.body?.cancel().catch(() => undefined);
    cached = { cache: cached.cache, status: cached.status };
  }
  if ('response' in cached && cached.response) {
    return clientResponse(cached.response, 'HIT', request.method, request.headers);
  }

  await requireOriginAdmission(request, dependencies, 'tarball');
  if (!hasPrecondition) {
    const rechecked = await lookupCache(dependencies, rangeKey);
    if (isRange && rechecked.response && rechecked.response.status !== 206) {
      await rechecked.response.body?.cancel().catch(() => undefined);
    } else if (rechecked.response) {
      return clientResponse(rechecked.response, 'HIT', request.method, request.headers);
    }
    if (!cached.cache && rechecked.cache) cached = rechecked;
  }
  const requestHeaders = outboundTarballHeaders(request);
  if (request.method === 'HEAD') requestHeaders.set('range', 'bytes=0-0');
  const upstream = await fetchFromRegistry(
    dependencies,
    target,
    'GET',
    requestHeaders,
    dependencies.tarballTimeoutMs ?? TARBALL_TIMEOUT_MS,
    undefined,
    false,
  );
  const normalized =
    request.method === 'HEAD'
      ? await normalizedTarballHeadResponse(upstream)
      : normalizedTarballResponse(
          upstream,
          request.method,
          isRange,
          dependencies.tarballTimeoutMs ?? TARBALL_TIMEOUT_MS,
        );
  const cacheFullResponse = !isRange && request.method === 'GET' && normalized.status === 200;
  const cacheNegative =
    !isRange && request.method === 'GET' && NEGATIVE_STATUSES.has(normalized.status);
  if (cacheFullResponse || cacheNegative) {
    scheduleCachePut(runtime, cached.cache, key, normalized.clone());
  }
  return clientResponse(
    normalized,
    isRange ? 'BYPASS' : cached.status,
    request.method,
    request.headers,
  );
}

async function handleAudit(
  request: Request,
  route: NpmRoute,
  dependencies: ProxyDependencies,
): Promise<Response> {
  if (route.kind !== 'audit-bulk' && route.kind !== 'audit-quick') {
    throw new ProxyHttpError(500, 'INTERNAL_ERROR', 'The audit route could not be resolved.');
  }
  const incomingUrl = new URL(request.url);
  const target = upstreamUrl(incomingUrl.pathname, canonicalSearch(route, incomingUrl));
  const headers = new Headers({
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'Lemonize-npm-proxy/1.0',
  });
  copyHeaderIfPresent(request.headers, headers, 'content-encoding');
  copyHeaderIfPresent(request.headers, headers, 'content-type');

  await requireOriginAdmission(request, dependencies, 'audit');
  const body = await readAuditBody(request);
  const upstream = await fetchFromRegistry(
    dependencies,
    target,
    'POST',
    headers,
    dependencies.metadataAuditTimeoutMs ?? METADATA_AUDIT_TIMEOUT_MS,
    body,
    false,
  );
  const responseBytes = await readStreamLimited(
    upstream.body,
    upstream.headers,
    MAX_AUDIT_RESPONSE_BYTES,
    502,
    'UPSTREAM_RESPONSE_TOO_LARGE',
    'The npm registry audit response exceeds the 8 MiB proxy limit.',
    dependencies.metadataAuditTimeoutMs ?? METADATA_AUDIT_TIMEOUT_MS,
  );
  const responseHeaders = cleanHeaders(upstream.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.set('content-length', String(responseBytes.byteLength));
  responseHeaders.set('cache-control', 'private, no-store');
  responseHeaders.set('x-lemonize-cache', 'BYPASS');
  return new Response(responseBytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function methodNotAllowed(requestId: string, allow: string): Response {
  return jsonError(405, 'METHOD_NOT_ALLOWED', 'This npm proxy is read-only.', requestId, allow);
}

export async function handleProxyRequest(
  request: Request,
  dependencies: ProxyDependencies,
  runtime: ProxyRuntime,
  enabled: boolean,
  requestId: string,
  configuredPublicOrigin = PUBLIC_ORIGIN,
  configuredPackumentMode = 'free',
): Promise<Response> {
  if (!enabled) {
    return finalizeResponse(
      jsonError(503, 'PROXY_DISABLED', 'The npm pull-through proxy is disabled.', requestId),
      requestId,
    );
  }

  let response: Response;
  try {
    const publicUrl = new URL(configuredPublicOrigin);
    if (
      publicUrl.protocol !== 'https:' ||
      publicUrl.username !== '' ||
      publicUrl.password !== '' ||
      publicUrl.pathname !== '/' ||
      publicUrl.search !== '' ||
      publicUrl.hash !== ''
    ) {
      throw new ProxyHttpError(
        503,
        'PROXY_MISCONFIGURED',
        'The npm proxy public origin is invalid.',
      );
    }
    const publicOrigin = publicUrl.origin;
    if (configuredPackumentMode !== 'free' && configuredPackumentMode !== 'full') {
      throw new ProxyHttpError(
        503,
        'PROXY_MISCONFIGURED',
        'The npm proxy packument mode is invalid.',
      );
    }
    if (new TextEncoder().encode(request.url).byteLength > MAX_REQUEST_URL_BYTES) {
      throw new ProxyHttpError(414, 'URI_TOO_LONG', 'The request URL is too long.');
    }

    const incomingUrl = new URL(request.url);
    const isAuditPath =
      incomingUrl.pathname === '/-/npm/v1/security/advisories/bulk' ||
      incomingUrl.pathname === '/-/npm/v1/security/audits/quick';

    if (request.method === 'POST') {
      if (!isAuditPath) {
        response = methodNotAllowed(requestId, 'GET, HEAD');
      } else {
        const route = classifyPath(incomingUrl.pathname);
        response = route
          ? await handleAudit(request, route, dependencies)
          : methodNotAllowed(requestId, 'POST');
      }
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      response = methodNotAllowed(requestId, isAuditPath ? 'POST' : 'GET, HEAD');
    } else {
      const route = classifyPath(incomingUrl.pathname);
      if (!route) {
        response = jsonError(
          404,
          'NOT_FOUND',
          'No supported npm registry route matches this URL.',
          requestId,
        );
      } else if (route.kind === 'audit-bulk' || route.kind === 'audit-quick') {
        response = methodNotAllowed(requestId, 'POST');
      } else if (route.kind === 'tarball') {
        response = await handleTarball(request, route, dependencies, runtime, publicOrigin);
      } else {
        response = await handleMetadata(
          request,
          route,
          dependencies,
          runtime,
          publicOrigin,
          configuredPackumentMode === 'full',
        );
      }
    }
  } catch (error) {
    if (error instanceof InvalidNpmPathError) {
      response = jsonError(400, 'INVALID_NPM_PATH', error.message, requestId);
    } else if (error instanceof ProxyHttpError) {
      response = jsonError(error.status, error.code, error.message, requestId);
      if (error.retryAfterSeconds !== undefined) {
        response.headers.set('retry-after', String(error.retryAfterSeconds));
      }
    } else {
      console.error(
        'npm proxy request failed',
        error instanceof Error ? error.name : 'UnknownError',
      );
      response = jsonError(
        502,
        'PROXY_FAILURE',
        'The npm proxy could not complete the request.',
        requestId,
      );
    }
  }
  return finalizeResponse(response, requestId);
}
