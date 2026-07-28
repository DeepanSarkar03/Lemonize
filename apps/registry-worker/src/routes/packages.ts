import { Hono } from 'hono';
import {
  notFound,
  ErrorCodes,
  normalizePackageName,
  resolveVersion,
  type PackageMetadata,
} from '@lemonize/shared';
import type { Context } from 'hono';
import type { AppBindings } from '../lib/env.js';
import { registryAppwriteRepository } from '../lib/appwrite-repository.js';
import { rateLimit } from '../lib/ratelimit.js';
import { buildPackageMetadata, isPrivatePackage, isPublicPackage } from '../lib/metadata.js';
import { cacheGet, cacheSet, kvKeys } from '../lib/kv-cache.js';
import { METADATA_CACHE, NO_STORE } from '../lib/http-cache.js';
import { requirePackageReadAccess } from '../lib/package-access.js';
import { packageVisibility } from '../lib/private-packages.js';

export const packages = new Hono<AppBindings>();

async function loadReadablePackage(c: Context<AppBindings>, name: string) {
  const repo = registryAppwriteRepository(c.env);
  const normalized = normalizePackageName(name);
  const pkg = await repo.getPackageByNormalizedName(normalized);
  if (!pkg || (!isPublicPackage(pkg) && !isPrivatePackage(pkg))) {
    throw notFound(ErrorCodes.PACKAGE_NOT_FOUND, `Package ${name} was not found`);
  }
  await requirePackageReadAccess(c, pkg);
  return { repo, pkg, normalized };
}

function cacheHeaders(c: Context<AppBindings>, visibility: 'public' | 'private', status?: string) {
  if (visibility === 'private') {
    c.header('cache-control', NO_STORE);
    c.header('pragma', 'no-cache');
    const vary = c.res.headers.get('vary');
    if (
      !vary
        ?.toLowerCase()
        .split(',')
        .some((value) => value.trim() === 'authorization')
    ) {
      c.header('vary', vary ? `${vary}, Authorization` : 'Authorization');
    }
    c.header('x-lemonize-cache', 'BYPASS');
    return;
  }
  c.header('cache-control', METADATA_CACHE);
  if (status) c.header('x-lemonize-cache', status);
}

packages.get('/packages/:name', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const name = c.req.param('name');

  const normalized = normalizePackageName(name);
  const cached = await cacheGet<PackageMetadata>(c.env.KV, kvKeys.pkg(normalized)).catch(
    () => null,
  );
  // Only public metadata is ever written to this key and visibility is
  // immutable. This preserves the hot CDN path without risking private data.
  if (cached?.visibility === 'public') {
    cacheHeaders(c, 'public', 'HIT');
    return c.json(cached);
  }
  const { repo, pkg } = await loadReadablePackage(c, name);
  const visibility = packageVisibility(pkg);
  const metadata = await buildPackageMetadata(repo, pkg, cfg.registryBaseUrl);
  if (visibility === 'public') {
    // Six hours keeps worst-case hot-package writes inside KV's free allowance;
    // mutations explicitly delete this key. Private metadata never enters KV.
    c.executionCtx.waitUntil(
      cacheSet(c.env.KV, kvKeys.pkg(normalized), metadata, 21_600).catch(() => undefined),
    );
  }
  cacheHeaders(c, visibility, visibility === 'public' ? 'MISS' : undefined);
  return c.json(metadata);
});

packages.get('/packages/:name/versions/:version', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const name = c.req.param('name');
  const version = c.req.param('version');
  const { repo, pkg } = await loadReadablePackage(c, name);
  const metadata = await buildPackageMetadata(repo, pkg, cfg.registryBaseUrl);
  const distTags = metadata.distTags;
  const resolved = resolveVersion(version, Object.keys(metadata.versions), distTags);
  const v = resolved ? metadata.versions[resolved] : undefined;
  if (!v)
    throw notFound(ErrorCodes.VERSION_NOT_FOUND, `Version ${version} of ${name} was not found`);
  cacheHeaders(c, packageVisibility(pkg));
  return c.json(v);
});

packages.get('/packages/:name/readme', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const { pkg } = await loadReadablePackage(c, c.req.param('name'));
  cacheHeaders(c, packageVisibility(pkg));
  return c.json({ name: pkg.name, readme: pkg.readme ?? '' });
});

packages.get('/packages/:name/downloads', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const { pkg } = await loadReadablePackage(c, c.req.param('name'));
  cacheHeaders(c, packageVisibility(pkg));
  // Downloads are not a registry source-of-truth resource in TablesDB. Keep
  // the public response stable until analytics is attached separately.
  return c.json({ name: pkg.name, total: 0, daily: [] });
});
