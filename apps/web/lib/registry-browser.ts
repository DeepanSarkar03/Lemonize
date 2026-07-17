import type { PackageMetadata, SearchResultItem } from '@lemonize/shared';

const REGISTRY_URL = process.env.NEXT_PUBLIC_REGISTRY_URL?.replace(/\/+$/, '');

export class RegistryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RegistryRequestError';
  }
}

interface RegistryRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export async function registryRequest<T>(
  path: string,
  options: RegistryRequestOptions = {},
): Promise<T> {
  if (!REGISTRY_URL) throw new Error('The registry endpoint is not configured.');
  if (!path.startsWith('/v1/')) throw new Error('Registry paths must begin with /v1/.');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${REGISTRY_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: unknown } }
      | null;
    const message =
      typeof body?.error?.message === 'string'
        ? body.error.message
        : `Registry request failed with ${response.status}.`;
    throw new RegistryRequestError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function fetchPackage(name: string, signal?: AbortSignal): Promise<PackageMetadata> {
  return registryRequest(`/v1/packages/${encodeURIComponent(name)}`, { signal });
}

export async function fetchSearch(term: string, signal?: AbortSignal): Promise<SearchResultItem[]> {
  const body = await registryRequest<{ results: SearchResultItem[] }>(
    `/v1/search?q=${encodeURIComponent(term)}`,
    { signal },
  );
  return body.results;
}
