import { Hono } from 'hono';
import type { AppBindings } from '../lib/env.js';
import { rateLimit } from '../lib/ratelimit.js';
import { METADATA_CACHE } from '../lib/http-cache.js';
import { AppwriteQuery } from '../lib/appwrite.js';
import { registryAppwriteRepository } from '../lib/appwrite-repository.js';
import { isPublicPackage } from '../lib/metadata.js';
import { badRequest } from '@lemonize/shared';
import { PUBLISH_QUOTAS } from '../lib/publish-security.js';

export const meta = new Hono<AppBindings>();

export function publicPackageSearchQueries(): string[] {
  return [
    AppwriteQuery.equal('status', ['active', 'published']),
    // Apply visibility and publication predicates in Appwrite before the
    // result limit. Otherwise private or never-published rows can crowd all
    // public matches out of the first page. Null covers rows created before
    // the visibility column existed; new rows use the public default.
    AppwriteQuery.or([
      AppwriteQuery.equal('visibility', 'public'),
      AppwriteQuery.isNull('visibility'),
    ]),
    AppwriteQuery.greaterThan('publishedVersionCount', 0),
    AppwriteQuery.orderDesc('$updatedAt'),
    AppwriteQuery.limit(50),
  ];
}

meta.get('/limits', (c) => {
  const cfg = c.get('config');
  c.header('cache-control', 'no-store');
  return c.json({
    maxTarballSizeBytes: Math.min(cfg.maxTarballSizeBytes, PUBLISH_QUOTAS.maxTarballSizeBytes),
    maxPackageFiles: cfg.maxPackageFiles,
    maxGlobalArtifactBytes: cfg.maxGlobalArtifactBytes,
    rateLimitReadsPerMinute: cfg.rateLimitReadsPerMinute,
    rateLimitWritesPerMinute: cfg.rateLimitWritesPerMinute,
    allowPublicPublish: cfg.allowPublicPublish,
    allowPrivatePackages: cfg.allowPrivatePackages,
    privatePackagesPaid: true,
    registryBaseUrl: cfg.registryBaseUrl,
    registryMode: cfg.registryMode,
    publishRestricted: cfg.registryMode !== 'public',
    openSignup: cfg.registryMode === 'public',
    publisherEligibility: 'authenticated',
    quotas: {
      packages: PUBLISH_QUOTAS.maxPackages,
      versionsPerPackage: PUBLISH_QUOTAS.maxVersionsPerPackage,
      storageBytes: PUBLISH_QUOTAS.maxStoredAndReservedBytes,
      activePublishes: PUBLISH_QUOTAS.maxLiveReservations,
    },
  });
});

meta.get('/search', async (c) => {
  const cfg = c.get('config');
  await rateLimit(c, 'read', cfg.rateLimitReadsPerMinute);
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  if (!q) return c.json({ results: [] });
  if (q.length > 64) throw badRequest('Search query must be at most 64 characters.');
  const repo = registryAppwriteRepository(c.env);
  const rows = await repo.searchPackages(q, {
    total: false,
    queries: publicPackageSearchQueries(),
  });
  const results = rows.rows.filter(isPublicPackage).map((pkg) => ({
    name: pkg.name,
    description: pkg.description ?? undefined,
    latest: pkg.latestVersion ?? undefined,
    updatedAt: pkg.$updatedAt,
    downloads: 0,
  }));
  c.header('cache-control', METADATA_CACHE);
  return c.json({ results });
});
