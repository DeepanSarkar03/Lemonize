import type { KVNamespace } from '@cloudflare/workers-types';

/** KV metadata cache helpers. KV is a cache only — never source of truth. */
export const kvKeys = {
  pkg: (normalized: string) => `pkg:${normalized}`,
  pkgver: (normalized: string, version: string) => `pkgver:${normalized}:${version}`,
  yanked: (normalized: string, version: string) => `yanked:${normalized}:${version}`,
  blocked: (normalized: string, version: string) => `blocked:${normalized}:${version}`,
  publicVersion: (normalized: string, version: string) => `public-version:${normalized}:${version}`,
};

export async function cacheGet<T>(kv: KVNamespace, key: string): Promise<T | null> {
  return kv.get<T>(key, 'json');
}

export async function cacheSet(kv: KVNamespace, key: string, value: unknown, ttl = 60): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

/** Invalidate all cache entries for a package after a mutation. */
export async function invalidatePackage(kv: KVNamespace, normalized: string): Promise<void> {
  await kv.delete(kvKeys.pkg(normalized));
}
