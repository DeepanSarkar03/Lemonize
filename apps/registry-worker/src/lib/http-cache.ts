/** HTTP cache header helpers + Cache API wrappers. */

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const METADATA_CACHE = 'public, max-age=30, stale-while-revalidate=300';
export const NO_STORE = 'private, no-store';

export function withCacheHeaders(
  headers: Headers,
  opts: { cacheControl: string; etag?: string; cacheStatus?: 'HIT' | 'MISS' | 'BYPASS' },
): Headers {
  headers.set('cache-control', opts.cacheControl);
  if (opts.etag) headers.set('etag', opts.etag);
  if (opts.cacheStatus) headers.set('x-lemonize-cache', opts.cacheStatus);
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

/** Open the default cache. Returns null in environments without the Cache API. */
export function defaultCache(): Cache | null {
  const store = (caches as unknown as { default?: Cache }).default;
  return store ?? null;
}
