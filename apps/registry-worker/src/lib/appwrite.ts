import type { AppwriteRow, AppwriteRowList, JsonValue } from './appwrite-types.js';

export type AppwriteFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AppwriteClientOptions {
  endpoint: string;
  projectId: string;
  apiKey: string;
  databaseId?: string;
  fetch?: AppwriteFetch;
  timeoutMs?: number;
  /** Appwrite response contract to pin. Defaults to the current TablesDB format. */
  responseFormat?: string;
}

export interface ListRowsOptions {
  queries?: readonly string[];
  /** Ask Appwrite to calculate the exact total. Defaults to false for cheaper queries. */
  total?: boolean;
  signal?: AbortSignal;
}

export interface WriteRowOptions {
  permissions?: readonly string[];
  signal?: AbortSignal;
}

export type AppwriteErrorKind =
  | 'configuration_error'
  | 'network_error'
  | 'timeout_error'
  | 'serialization_error'
  | 'protocol_error'
  | 'appwrite_error';

/**
 * A deliberately redacted error. It never retains request headers, bodies,
 * Appwrite's free-form error message, or the original network error.
 */
export class AppwriteError extends Error {
  readonly kind: AppwriteErrorKind;
  readonly status: number;
  readonly responseType?: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    kind: AppwriteErrorKind;
    message: string;
    status?: number;
    responseType?: string;
    requestId?: string;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = 'AppwriteError';
    this.kind = input.kind;
    this.status = input.status ?? 0;
    this.responseType = input.responseType;
    this.requestId = input.requestId;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const COLUMN = /^(?:\$[A-Za-z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9._-]{0,127})$/;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new AppwriteError({
      kind: 'configuration_error',
      message: `Invalid Appwrite ${label}.`,
    });
  }
}

function assertColumn(value: string): void {
  if (!COLUMN.test(value)) {
    throw new AppwriteError({ kind: 'serialization_error', message: 'Invalid query column.' });
  }
}

function assertQueryValues(input: readonly JsonValue[]): void {
  const ancestors = new Set<object>();
  let visited = 0;
  const visit = (value: unknown, depth: number): void => {
    visited += 1;
    if (visited > 10_000 || depth > 20) {
      throw new AppwriteError({
        kind: 'serialization_error',
        message: 'Query value is too complex.',
      });
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return;
      throw new AppwriteError({
        kind: 'serialization_error',
        message: 'Query values must be finite JSON values.',
      });
    }
    if (typeof value !== 'object') {
      throw new AppwriteError({
        kind: 'serialization_error',
        message: 'Query values must be JSON values.',
      });
    }
    if (ancestors.has(value)) {
      throw new AppwriteError({
        kind: 'serialization_error',
        message: 'Query values must not contain cycles.',
      });
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else {
      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new AppwriteError({
          kind: 'serialization_error',
          message: 'Query values must be plain JSON values.',
        });
      }
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
    ancestors.delete(value);
  };
  for (const value of input) visit(value, 0);
}

function query(method: string, attribute?: string, values?: readonly JsonValue[]): string {
  if (attribute !== undefined) assertColumn(attribute);
  if (values !== undefined) assertQueryValues(values);
  return JSON.stringify({
    method,
    ...(attribute === undefined ? {} : { attribute }),
    ...(values === undefined ? {} : { values }),
  });
}

function values(value: JsonValue | readonly JsonValue[]): readonly JsonValue[] {
  return Array.isArray(value) ? [...value] : [value as JsonValue];
}

function logicalQuery(method: 'or' | 'and', encodedQueries: readonly string[]): string {
  if (encodedQueries.length < 1 || encodedQueries.length > 100) {
    throw new AppwriteError({
      kind: 'serialization_error',
      message: 'Invalid logical query list.',
    });
  }
  const parsed: JsonValue[] = [];
  for (const encoded of encodedQueries) {
    if (encoded.length < 1 || encoded.length > 4_096) {
      throw new AppwriteError({
        kind: 'serialization_error',
        message: 'Invalid logical query.',
      });
    }
    try {
      const value: unknown = JSON.parse(encoded);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('invalid query');
      }
      parsed.push(value as JsonValue);
    } catch {
      throw new AppwriteError({
        kind: 'serialization_error',
        message: 'Invalid logical query.',
      });
    }
  }
  return query(method, undefined, parsed);
}

/** Cloudflare-safe equivalent of the Appwrite SDK Query helper. */
export const AppwriteQuery = {
  equal: (column: string, value: JsonValue | readonly JsonValue[]) =>
    query('equal', column, values(value)),
  notEqual: (column: string, value: JsonValue | readonly JsonValue[]) =>
    query('notEqual', column, values(value)),
  lessThan: (column: string, value: JsonValue) => query('lessThan', column, [value]),
  lessThanEqual: (column: string, value: JsonValue) => query('lessThanEqual', column, [value]),
  greaterThan: (column: string, value: JsonValue) => query('greaterThan', column, [value]),
  greaterThanEqual: (column: string, value: JsonValue) =>
    query('greaterThanEqual', column, [value]),
  between: (column: string, start: JsonValue, end: JsonValue) =>
    query('between', column, [start, end]),
  isNull: (column: string) => query('isNull', column),
  isNotNull: (column: string) => query('isNotNull', column),
  search: (column: string, term: string) => query('search', column, [term]),
  startsWith: (column: string, term: string) => query('startsWith', column, [term]),
  endsWith: (column: string, term: string) => query('endsWith', column, [term]),
  select: (columns: readonly string[]) => {
    for (const column of columns) assertColumn(column);
    return query('select', undefined, columns);
  },
  orderAsc: (column: string) => query('orderAsc', column),
  orderDesc: (column: string) => query('orderDesc', column),
  limit: (limit: number) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new AppwriteError({ kind: 'serialization_error', message: 'Invalid query limit.' });
    }
    return query('limit', undefined, [limit]);
  },
  offset: (offset: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new AppwriteError({ kind: 'serialization_error', message: 'Invalid query offset.' });
    }
    return query('offset', undefined, [offset]);
  },
  cursorAfter: (rowId: string) => {
    assertIdentifier(rowId, 'cursor row ID');
    return query('cursorAfter', undefined, [rowId]);
  },
  cursorBefore: (rowId: string) => {
    assertIdentifier(rowId, 'cursor row ID');
    return query('cursorBefore', undefined, [rowId]);
  },
  or: (queries: readonly string[]) => logicalQuery('or', queries),
  and: (queries: readonly string[]) => logicalQuery('and', queries),
} as const;

interface RequestOptions {
  body?: unknown;
  queries?: readonly string[];
  total?: boolean;
  signal?: AbortSignal;
}

interface AppwriteErrorBody {
  type?: unknown;
  code?: unknown;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeResponseToken(value: unknown, secret: string, maxLength: number): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    value.includes(secret) ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AppwriteRestClient {
  private readonly endpoint: string;
  private readonly projectId: string;
  private readonly apiKey: string;
  private readonly databaseId: string;
  private readonly fetcher: AppwriteFetch;
  private readonly timeoutMs: number;
  private readonly responseFormat: string;

  constructor(options: AppwriteClientOptions) {
    assertIdentifier(options.projectId, 'project ID');
    assertIdentifier(options.databaseId ?? 'registry', 'database ID');
    if (options.apiKey.length < 1) {
      throw new AppwriteError({ kind: 'configuration_error', message: 'Missing Appwrite API key.' });
    }
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new AppwriteError({ kind: 'configuration_error', message: 'Invalid Appwrite endpoint.' });
    }
    const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname);
    if (
      endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && isLoopback)
    ) {
      throw new AppwriteError({ kind: 'configuration_error', message: 'Invalid Appwrite endpoint.' });
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new AppwriteError({ kind: 'configuration_error', message: 'Invalid Appwrite endpoint.' });
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new AppwriteError({ kind: 'configuration_error', message: 'Invalid Appwrite timeout.' });
    }
    const responseFormat = options.responseFormat ?? '1.9.5';
    if (!/^\d+\.\d+\.\d+$/.test(responseFormat)) {
      throw new AppwriteError({
        kind: 'configuration_error',
        message: 'Invalid Appwrite response format.',
      });
    }

    const normalizedEndpoint = endpoint.toString().replace(/\/+$/, '');
    this.endpoint = normalizedEndpoint.endsWith('/v1')
      ? normalizedEndpoint
      : `${normalizedEndpoint}/v1`;
    this.projectId = options.projectId;
    this.apiKey = options.apiKey;
    this.databaseId = options.databaseId ?? 'registry';
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = timeoutMs;
    this.responseFormat = responseFormat;
  }

  async createRow<T extends object>(
    tableId: string,
    rowId: string,
    data: T,
    options: WriteRowOptions = {},
  ): Promise<AppwriteRow<T>> {
    assertIdentifier(tableId, 'table ID');
    assertIdentifier(rowId, 'row ID');
    return this.request<AppwriteRow<T>>('POST', this.rowsPath(tableId), {
      body: {
        rowId,
        data,
        ...(options.permissions === undefined
          ? {}
          : { permissions: [...options.permissions] }),
      },
      signal: options.signal,
    });
  }

  async getRow<T extends object>(
    tableId: string,
    rowId: string,
    signal?: AbortSignal,
  ): Promise<AppwriteRow<T>> {
    assertIdentifier(tableId, 'table ID');
    assertIdentifier(rowId, 'row ID');
    return this.request<AppwriteRow<T>>('GET', `${this.rowsPath(tableId)}/${encodeURIComponent(rowId)}`, {
      signal,
    });
  }

  async listRows<T extends object>(
    tableId: string,
    options: ListRowsOptions = {},
  ): Promise<AppwriteRowList<T>> {
    assertIdentifier(tableId, 'table ID');
    const result = await this.request<unknown>('GET', this.rowsPath(tableId), {
      queries: options.queries,
      total: options.total ?? false,
      signal: options.signal,
    });
    if (!isRecord(result) || !Array.isArray(result.rows) || typeof result.total !== 'number') {
      throw new AppwriteError({
        kind: 'protocol_error',
        status: 502,
        message: 'Appwrite returned an invalid row-list response.',
      });
    }
    return result as unknown as AppwriteRowList<T>;
  }

  async updateRow<T extends object>(
    tableId: string,
    rowId: string,
    data: Partial<T>,
    options: WriteRowOptions = {},
  ): Promise<AppwriteRow<T>> {
    assertIdentifier(tableId, 'table ID');
    assertIdentifier(rowId, 'row ID');
    return this.request<AppwriteRow<T>>(
      'PATCH',
      `${this.rowsPath(tableId)}/${encodeURIComponent(rowId)}`,
      {
        body: {
          data,
          ...(options.permissions === undefined
            ? {}
            : { permissions: [...options.permissions] }),
        },
        signal: options.signal,
      },
    );
  }

  async deleteRow(tableId: string, rowId: string, signal?: AbortSignal): Promise<void> {
    assertIdentifier(tableId, 'table ID');
    assertIdentifier(rowId, 'row ID');
    await this.request<unknown>(
      'DELETE',
      `${this.rowsPath(tableId)}/${encodeURIComponent(rowId)}`,
      { signal },
    );
  }

  private rowsPath(tableId: string): string {
    return `/tablesdb/${encodeURIComponent(this.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
  }

  private async request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = new URL(`${this.endpoint}${path}`);
    const queries = options.queries ?? [];
    if (
      queries.length > 100 ||
      queries.some((encodedQuery) => encodedQuery.length < 1 || encodedQuery.length > 4_096)
    ) {
      throw new AppwriteError({
        kind: 'serialization_error',
        message: 'Invalid Appwrite query list.',
      });
    }
    for (const encodedQuery of queries) {
      url.searchParams.append('queries[]', encodedQuery);
    }
    if (options.total !== undefined) url.searchParams.set('total', String(options.total));

    let body: string | undefined;
    try {
      body = options.body === undefined ? undefined : JSON.stringify(options.body);
    } catch {
      throw new AppwriteError({
        kind: 'serialization_error',
        message: 'Appwrite request data is not JSON serializable.',
      });
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Appwrite-Project': this.projectId,
          'X-Appwrite-Key': this.apiKey,
          'X-Appwrite-Response-Format': this.responseFormat,
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
    } catch {
      const timedOut = controller.signal.aborted && !options.signal?.aborted;
      throw new AppwriteError({
        kind: timedOut ? 'timeout_error' : 'network_error',
        message: timedOut ? 'Appwrite request timed out.' : 'Appwrite request failed.',
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }

    const requestId = safeResponseToken(
      response.headers.get('x-appwrite-request-id'),
      this.apiKey,
      128,
    );
    if (!response.ok) {
      let errorBody: AppwriteErrorBody = {};
      try {
        const parsed: unknown = await response.json();
        if (isRecord(parsed)) errorBody = parsed;
      } catch {
        // The free-form response is intentionally discarded.
      }
      const responseType = safeResponseToken(errorBody.type, this.apiKey, 128);
      throw new AppwriteError({
        kind: 'appwrite_error',
        status: response.status,
        message: `Appwrite request failed with status ${response.status}.`,
        responseType,
        requestId,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      });
    }

    if (response.status === 204 || method === 'DELETE') return undefined as T;
    try {
      const parsed: unknown = await response.json();
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed as T;
    } catch {
      throw new AppwriteError({
        kind: 'protocol_error',
        status: 502,
        message: 'Appwrite returned an invalid JSON response.',
        requestId,
      });
    }
  }
}
