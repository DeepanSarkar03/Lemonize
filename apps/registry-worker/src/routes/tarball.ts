import { Hono, type Context } from 'hono';
import {
  notFound,
  ErrorCodes,
  isValidVersion,
  normalizePackageName,
  toObjectKeyName,
} from '@lemonize/shared';
import type { AppBindings } from '../lib/env.js';
import { registryAppwriteRepository } from '../lib/appwrite-repository.js';
import { getDownloadablePackage, resolvePublicVersion } from '../lib/appwrite-public.js';
import { rateLimit } from '../lib/ratelimit.js';
import { IMMUTABLE_CACHE, defaultCache } from '../lib/http-cache.js';
import { kvKeys } from '../lib/kv-cache.js';

export const tarball = new Hono<AppBindings>();

export function objectKey(name: string, version: string): string {
  return `packages/${toObjectKeyName(name)}/${version}/package.tgz`;
}

export async function hasSecurityBlockTombstone(
  kv: AppBindings['Bindings']['KV'],
  name: string,
  version: string,
): Promise<boolean> {
  try {
    return (await kv.get(kvKeys.blocked(normalizePackageName(name), version))) === '1';
  } catch {
    // TablesDB remains authoritative when the tombstone cache is unavailable.
    return false;
  }
}

function safeFilename(name: string, version: string): string {
  const base = name.replace('@', '').replace('/', '-');
  return `${base}-${version}.tgz`;
}

function requestedFilename(value: string | undefined, fallback: string): string {
  return value && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value) ? value : fallback;
}

async function resolveTarget(
  c: Context<AppBindings>,
  name: string,
  versionSpec: string,
) {
  const repo = registryAppwriteRepository(c.env);
  const pkg = await getDownloadablePackage(repo, name);
  const versionRow = await resolvePublicVersion(repo, pkg, name, versionSpec);
  return { pkg, versionRow };
}

async function serveTarball(
  c: Context<AppBindings>,
  name: string,
  versionSpec: string,
  downloadName?: string,
) {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const rangeHeader = c.req.header('range');
  const exactCacheCandidate =
    c.req.method === 'GET' && !rangeHeader && isValidVersion(versionSpec);
  if (isValidVersion(versionSpec)) {
    if (await hasSecurityBlockTombstone(c.env.KV, name, versionSpec)) {
      throw notFound(ErrorCodes.VERSION_NOT_FOUND, `Version ${versionSpec} was not found`);
    }
  }
  let cache: Cache | null | undefined;
  if (exactCacheCandidate) {
    try {
      const normalized = normalizePackageName(name);
      const [yanked, publicMarker] = await Promise.all([
        c.env.KV.get(kvKeys.yanked(normalized, versionSpec)),
        c.env.KV.get(kvKeys.publicVersion(normalized, versionSpec)),
      ]);
      // Only a positive marker created after an Appwrite visibility check may
      // bypass Appwrite. Missing/restored KV therefore fails safely to source
      // of truth instead of reviving a stale Cache API response.
      if (!yanked && publicMarker === '1') cache = defaultCache();
    } catch {
      // Fall through to Appwrite source of truth.
    }
  }
  const normalizedCacheUrl = new URL(c.req.url);
  if (downloadName) normalizedCacheUrl.pathname = normalizedCacheUrl.pathname.replace(/\/[^/]+$/, '');
  normalizedCacheUrl.search = '';
  const cacheKey = new Request(normalizedCacheUrl.toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const etag = hit.headers.get('etag');
      if (etag && c.req.header('if-none-match') === etag) {
        return new Response(null, {
          status: 304,
          headers: { etag, 'cache-control': IMMUTABLE_CACHE, 'x-lemonize-cache': 'HIT' },
        });
      }
      const headers = new Headers(hit.headers);
      headers.set('x-lemonize-cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  const { pkg, versionRow } = await resolveTarget(c, name, versionSpec);
  if (exactCacheCandidate) {
    if (versionRow.status === 'published' && !versionRow.yankedAt) {
      cache ??= defaultCache();
      c.executionCtx.waitUntil(
        c.env.KV
          .put(kvKeys.publicVersion(pkg.normalizedName, versionRow.version), '1', {
            expirationTtl: 60,
          })
          .catch(() => undefined),
      );
    } else {
      cache = null;
    }
  }
  const key = versionRow.artifactKey || objectKey(pkg.name, versionRow.version);
  const etag = `"${versionRow.computedShasum ?? versionRow.shasum}"`;
  const filename = requestedFilename(undefined, safeFilename(pkg.name, versionRow.version));

  // Tags and semver ranges are mutable. Redirect them to the content's exact,
  // immutable version URL before consulting the edge cache so `latest` can
  // never pin an older artifact for a year.
  if (versionSpec !== versionRow.version) {
    const canonical = `${cfg.registryBaseUrl}/v1/packages/${encodeURIComponent(pkg.name)}/versions/${encodeURIComponent(versionRow.version)}/tarball${
      downloadName ? `/${encodeURIComponent(filename)}` : ''
    }`;
    return new Response(null, {
      status: 302,
      headers: {
        location: canonical,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (c.req.header('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': IMMUTABLE_CACHE, 'x-lemonize-cache': 'HIT' },
    });
  }

  const baseHeaders: Record<string, string> = {
    'content-type': 'application/gzip',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': IMMUTABLE_CACHE,
    etag,
    'x-lemonize-integrity': versionRow.integrity,
    'x-lemonize-version': versionRow.version,
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
  };

  if (c.req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, 'content-length': String(versionRow.tarballSize) },
    });
  }

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    const total = versionRow.tarballSize;
    let start: number;
    let end: number;
    if (!match || (!match[1] && !match[2])) {
      start = total;
      end = 0;
    } else if (!match[1]) {
      const suffixLength = Number(match[2]);
      start = Number.isSafeInteger(suffixLength) && suffixLength > 0
        ? Math.max(0, total - suffixLength)
        : total;
      end = total - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : total - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${total}` },
      });
    }
    end = Math.min(end, total - 1);
    const obj = await c.env.BUCKET.get(key, {
      range: { offset: start, length: end - start + 1 },
    });
    if (!obj) throw notFound(ErrorCodes.ARTIFACT_MISSING, 'Artifact is missing from storage');
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(end - start + 1),
        'x-lemonize-cache': 'BYPASS',
      },
    });
  }

  const obj = await c.env.BUCKET.get(key);
  if (!obj) throw notFound(ErrorCodes.ARTIFACT_MISSING, 'Artifact is missing from storage');
  const headers = new Headers({
    ...baseHeaders,
    'content-length': String(versionRow.tarballSize),
    'x-lemonize-cache': 'MISS',
  });
  const response = new Response(obj.body, { status: 200, headers });
  if (cache) c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

tarball.on(['GET', 'HEAD'], '/packages/:name/versions/:version/tarball', (c) =>
  serveTarball(c, c.req.param('name'), c.req.param('version')),
);

tarball.on(['GET', 'HEAD'], '/packages/:name/versions/:version/tarball/:filename', (c) =>
  serveTarball(c, c.req.param('name'), c.req.param('version'), c.req.param('filename')),
);

export const now = () => new Date().toISOString();
