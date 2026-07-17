import { describe, expect, it, vi } from 'vitest';
import {
  AppwriteError,
  AppwriteQuery,
  AppwriteRestClient,
  type AppwriteFetch,
} from '../src/lib/appwrite.js';
import { RegistryAppwriteRepository } from '../src/lib/appwrite-repository.js';

const metadata = {
  $id: 'row-1',
  $sequence: 1,
  $databaseId: 'registry',
  $tableId: 'users',
  $createdAt: '2026-07-17T00:00:00.000Z',
  $updatedAt: '2026-07-17T00:00:00.000Z',
  $permissions: [],
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function client(fetcher: AppwriteFetch, apiKey = 'server-secret-key'): AppwriteRestClient {
  return new AppwriteRestClient({
    endpoint: 'https://fra.cloud.appwrite.io/v1/',
    projectId: 'lemonize-prod-2026',
    apiKey,
    fetch: fetcher,
  });
}

describe('AppwriteRestClient', () => {
  it('encodes TablesDB paths, repeated queries, headers, and row data', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: AppwriteFetch = async (url, init) => {
      calls.push({ url, init });
      return json({
        ...metadata,
        clerkId: 'clerk_123',
        email: 'a@example.test',
        namespace: 'alice',
        status: 'active',
        role: 'user',
        storageBytes: 0,
        packageCount: 0,
      });
    };
    const appwrite = client(fetcher);

    await appwrite.createRow('users', 'row-1', {
      clerkId: 'clerk_123',
      namespace: 'alice',
    });
    await appwrite.listRows('users', {
      queries: [AppwriteQuery.equal('status', 'active'), AppwriteQuery.limit(25)],
      total: false,
    }).catch(() => undefined);

    expect(calls[0]?.url).toBe(
      'https://fra.cloud.appwrite.io/v1/tablesdb/registry/tables/users/rows',
    );
    expect(new Headers(calls[0]?.init?.headers).get('x-appwrite-project')).toBe(
      'lemonize-prod-2026',
    );
    expect(new Headers(calls[0]?.init?.headers).get('x-appwrite-key')).toBe(
      'server-secret-key',
    );
    expect(new Headers(calls[0]?.init?.headers).get('x-appwrite-response-format')).toBe(
      '1.9.5',
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      rowId: 'row-1',
      data: { clerkId: 'clerk_123', namespace: 'alice' },
    });

    const listUrl = new URL(calls[1]?.url ?? 'https://invalid.test');
    expect(listUrl.searchParams.getAll('queries[]')).toEqual([
      '{"method":"equal","attribute":"status","values":["active"]}',
      '{"method":"limit","values":[25]}',
    ]);
    expect(listUrl.searchParams.get('total')).toBe('false');
  });

  it('rejects unsafe query columns and non-finite values before fetch', () => {
    expect(() => AppwriteQuery.equal('status&queries[]=oops', 'active')).toThrow(
      AppwriteError,
    );
    expect(() => AppwriteQuery.greaterThan('attempts', Number.POSITIVE_INFINITY)).toThrow(
      'finite JSON values',
    );
  });

  it('encodes logical search queries in Appwrite SDK wire format', () => {
    expect(
      AppwriteQuery.or([
        AppwriteQuery.search('name', 'demo'),
        AppwriteQuery.search('description', 'demo'),
      ]),
    ).toBe(
      '{"method":"or","values":[{"method":"search","attribute":"name","values":["demo"]},{"method":"search","attribute":"description","values":["demo"]}]}',
    );
  });

  it('does not expose API keys or free-form upstream messages in errors', async () => {
    const key = 'extremely-sensitive-api-key';
    const fetcher: AppwriteFetch = vi.fn(async () =>
      json(
        {
          type: 'general_unauthorized_scope',
          code: 401,
          message: `bad key ${key}; Authorization: Bearer stolen`,
        },
        { status: 401, headers: { 'x-appwrite-request-id': 'req-safe' } },
      ),
    );

    const error = await client(fetcher, key)
      .getRow('users', 'row-1')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppwriteError);
    expect(error).toMatchObject({
      status: 401,
      responseType: 'general_unauthorized_scope',
      requestId: 'req-safe',
    });
    expect(JSON.stringify(error)).not.toContain(key);
    expect(String(error)).not.toContain('Bearer');
  });

  it('wraps network failures without retaining their potentially sensitive message', async () => {
    const fetcher: AppwriteFetch = vi.fn(async () => {
      throw new Error('request failed while sending X-Appwrite-Key: leaked');
    });
    const error = await client(fetcher).getRow('users', 'row-1').catch((caught) => caught);
    expect(error).toMatchObject({ kind: 'network_error', status: 0 });
    expect(String(error)).not.toContain('leaked');
  });
});

describe('RegistryAppwriteRepository', () => {
  it('uses indexed domain queries and returns the first typed row', async () => {
    let requestedUrl = '';
    const fetcher: AppwriteFetch = async (url) => {
      requestedUrl = url;
      return json({
        total: 1,
        rows: [
          {
            ...metadata,
            clerkId: 'clerk_123',
            email: 'a@example.test',
            namespace: 'alice',
            status: 'active',
            role: 'user',
            storageBytes: 0,
            packageCount: 0,
          },
        ],
      });
    };
    const repo = new RegistryAppwriteRepository(client(fetcher));

    const user = await repo.getUserByClerkId('clerk_123');

    expect(user?.namespace).toBe('alice');
    const queries = new URL(requestedUrl).searchParams.getAll('queries[]');
    expect(queries).toEqual([
      '{"method":"equal","attribute":"clerkId","values":["clerk_123"]}',
      '{"method":"limit","values":[1]}',
    ]);
  });

  it('maps a missing CRUD row to null without hiding other failures', async () => {
    const repo = new RegistryAppwriteRepository(
      client(async () => json({ type: 'row_not_found', message: 'missing' }, { status: 404 })),
    );
    await expect(repo.scanJobs.getOrNull('missing-row')).resolves.toBeNull();
  });
});
