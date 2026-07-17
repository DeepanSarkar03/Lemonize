import { Hono } from 'hono';
import { notFound, ErrorCodes, normalizePackageName, resolveVersion } from '@lemonize/shared';
import type { Context } from 'hono';
import type { AppBindings } from '../lib/env.js';
import { registryAppwriteRepository } from '../lib/appwrite-repository.js';
import { rateLimit } from '../lib/ratelimit.js';
import { buildPackageMetadata } from '../lib/metadata.js';
import { getPublicPackage } from '../lib/appwrite-public.js';
import { cacheGet, cacheSet, kvKeys } from '../lib/kv-cache.js';
import { METADATA_CACHE } from '../lib/http-cache.js';

export const packages = new Hono<AppBindings>();

async function loadPublicPackage(c: Context<AppBindings>, name: string) {
  const repo = registryAppwriteRepository(c.env);
  const normalized = normalizePackageName(name);
  const pkg = await getPublicPackage(repo, name);
  return { repo, pkg, normalized };
}

packages.get('/packages/:name', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const name = c.req.param('name');

  const normalized = normalizePackageName(name);
  const cached = await cacheGet(c.env.KV, kvKeys.pkg(normalized)).catch(() => null);
  if (cached) {
    c.header('cache-control', METADATA_CACHE);
    c.header('x-lemonize-cache', 'HIT');
    return c.json(cached);
  }

  const { repo, pkg } = await loadPublicPackage(c, name);
  const metadata = await buildPackageMetadata(repo, pkg, cfg.registryBaseUrl);
  // Six hours keeps worst-case hot-package writes inside KV's free allowance;
  // mutations explicitly delete this key.
  c.executionCtx.waitUntil(
    cacheSet(c.env.KV, kvKeys.pkg(normalized), metadata, 21_600).catch(() => undefined),
  );
  c.header('cache-control', METADATA_CACHE);
  c.header('x-lemonize-cache', 'MISS');
  return c.json(metadata);
});

packages.get('/packages/:name/versions/:version', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const name = c.req.param('name');
  const version = c.req.param('version');
  const { repo, pkg } = await loadPublicPackage(c, name);
  const metadata = await buildPackageMetadata(repo, pkg, cfg.registryBaseUrl);
  const distTags = metadata.distTags;
  const resolved = resolveVersion(version, Object.keys(metadata.versions), distTags);
  const v = resolved ? metadata.versions[resolved] : undefined;
  if (!v) throw notFound(ErrorCodes.VERSION_NOT_FOUND, `Version ${version} of ${name} was not found`);
  c.header('cache-control', METADATA_CACHE);
  return c.json(v);
});

packages.get('/packages/:name/readme', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const { pkg } = await loadPublicPackage(c, c.req.param('name'));
  c.header('cache-control', METADATA_CACHE);
  return c.json({ name: pkg.name, readme: pkg.readme ?? '' });
});

packages.get('/packages/:name/downloads', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const { pkg } = await loadPublicPackage(c, c.req.param('name'));
  c.header('cache-control', METADATA_CACHE);
  // Downloads are not a registry source-of-truth resource in TablesDB. Keep
  // the public response stable until analytics is attached separately.
  return c.json({ name: pkg.name, total: 0, daily: [] });
});
