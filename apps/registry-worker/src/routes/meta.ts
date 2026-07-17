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

meta.get('/limits', (c) => {
  const cfg = c.get('config');
  c.header('cache-control', 'no-store');
  return c.json({
    maxTarballSizeBytes: Math.min(
      cfg.maxTarballSizeBytes,
      PUBLISH_QUOTAS.maxTarballSizeBytes,
    ),
    maxPackageFiles: cfg.maxPackageFiles,
    maxGlobalArtifactBytes: cfg.maxGlobalArtifactBytes,
    rateLimitReadsPerMinute: cfg.rateLimitReadsPerMinute,
    rateLimitWritesPerMinute: cfg.rateLimitWritesPerMinute,
    allowPublicPublish: cfg.allowPublicPublish,
    allowPrivatePackages: cfg.allowPrivatePackages,
    registryBaseUrl: cfg.registryBaseUrl,
    registryMode: cfg.registryMode,
    publishRestricted: cfg.registryMode !== 'public',
    openSignup: cfg.registryMode === 'public',
    publisherEligibility: 'github_linked',
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
    queries: [
      AppwriteQuery.equal('status', ['active', 'published']),
      AppwriteQuery.orderDesc('$updatedAt'),
      AppwriteQuery.limit(50),
    ],
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
