import { Hono, type Context } from 'hono';
import {
  distTagSchema,
  deprecateSchema,
  securityBlockSchema,
  unpublishSchema,
  normalizePackageName,
  maxAny,
  maxStable,
  notFound,
  badRequest,
  forbidden,
  ErrorCodes,
} from '@lemonize/shared';
import type { AppBindings } from '../lib/env.js';
import type { AppwriteRow, PackageData } from '../lib/appwrite-types.js';
import type { RegistryAppwriteRepository } from '../lib/appwrite-repository.js';
import { AppwriteQuery } from '../lib/appwrite.js';
import { registryRepository } from '../lib/registry.js';
import { requireAuth, requireClerkSession, requirePackageManager } from '../lib/auth.js';
import { rateLimit } from '../lib/ratelimit.js';
import { invalidatePackage, kvKeys } from '../lib/kv-cache.js';
import { assertMaintainerIdentity, assertRegistryMutable } from '../lib/maintenance-security.js';

export const maintenance = new Hono<AppBindings>();

async function requireMaintainer(
  c: Context<AppBindings>,
  name: string,
): Promise<{ repo: RegistryAppwriteRepository; pkg: AppwriteRow<PackageData> }> {
  const repo = registryRepository(c.env);
  const pkg = await repo.getPackageByNormalizedName(normalizePackageName(name));
  if (!pkg || pkg.status !== 'active') {
    throw notFound(ErrorCodes.PACKAGE_NOT_FOUND, `Package ${name} was not found`);
  }
  assertMaintainerIdentity({
    role: c.get('role'),
    userId: c.get('userId'),
    namespace: c.get('namespace'),
    packageOwnerId: pkg.ownerId,
    packageScope: pkg.scope,
  });
  return { repo, pkg };
}

function requireMutableRegistry(c: Context<AppBindings>): void {
  assertRegistryMutable(c.get('config').registryMode);
}

async function audit(
  c: Context<AppBindings>,
  repo: RegistryAppwriteRepository,
  pkg: AppwriteRow<PackageData>,
  action: string,
  detail: string,
): Promise<void> {
  await repo.appendAudit({
    actorId: c.get('userId') ?? null,
    action,
    resourceType: 'package',
    resourceId: pkg.$id,
    detail,
    requestId: c.get('requestId'),
    ipHash: null,
  });
}

async function recomputeLatest(
  repo: RegistryAppwriteRepository,
  pkg: AppwriteRow<PackageData>,
): Promise<void> {
  const allVersions = (
    await repo.listVersions(pkg.$id, {
      queries: [AppwriteQuery.limit(5_000)],
    })
  ).rows;
  const published = allVersions.filter(
    (version) => version.status === 'published' && !version.yankedAt,
  );
  let storageBytes = 0;
  for (const version of allVersions.filter((candidate) => Boolean(candidate.artifactKey))) {
    storageBytes += version.tarballSize;
  }
  const latestTag = await repo.getTag(pkg.$id, 'latest');
  const taggedLatest = latestTag
    ? (published.find((version) => version.version === latestTag.version)?.version ?? null)
    : null;
  const available = published.map((version) => version.version);
  const latest = taggedLatest ?? maxStable(available) ?? maxAny(available);
  await repo.packages.update(pkg.$id, {
    latestVersion: latest,
    storageBytes,
    publishedVersionCount: published.length,
  });
  if (latest && latestTag?.version !== latest) {
    await repo.setTag({ packageId: pkg.$id, tag: 'latest', version: latest });
  } else if (latestTag) await repo.tags.delete(latestTag.$id);
}

// POST /packages/:name/dist-tags  { tag, version }
maintenance.post('/packages/:name/dist-tags', requireAuth, requirePackageManager, async (c) => {
  requireMutableRegistry(c);
  const config = c.get('config');
  await rateLimit(c, 'write', config.rateLimitWritesPerMinute);
  const body = distTagSchema.parse(await c.req.json());
  const { repo, pkg } = await requireMaintainer(c, c.req.param('name')!);
  const version = await repo.getVersion(pkg.$id, body.version);
  if (!version || version.status !== 'published' || version.yankedAt) {
    throw notFound(ErrorCodes.VERSION_NOT_FOUND, `Published version ${body.version} not found`);
  }
  await repo.setTag({ packageId: pkg.$id, tag: body.tag, version: body.version });
  if (body.tag === 'latest') await repo.packages.update(pkg.$id, { latestVersion: body.version });
  await audit(c, repo, pkg, 'dist_tag.set', `${body.tag}=${body.version}`).catch(() => undefined);
  await invalidatePackage(c.env.KV, pkg.normalizedName).catch(() => undefined);
  return c.json({ tag: body.tag, version: body.version });
});

// DELETE /packages/:name/dist-tags/:tag
maintenance.delete(
  '/packages/:name/dist-tags/:tag',
  requireAuth,
  requirePackageManager,
  async (c) => {
    requireMutableRegistry(c);
    const config = c.get('config');
    await rateLimit(c, 'write', config.rateLimitWritesPerMinute);
    const tag = c.req.param('tag')!;
    if (tag === 'latest') throw badRequest('The "latest" tag cannot be removed.');
    const { repo, pkg } = await requireMaintainer(c, c.req.param('name')!);
    const existing = await repo.getTag(pkg.$id, tag);
    if (existing) await repo.tags.delete(existing.$id);
    await audit(c, repo, pkg, 'dist_tag.delete', tag).catch(() => undefined);
    await invalidatePackage(c.env.KV, pkg.normalizedName).catch(() => undefined);
    return c.json({ ok: true });
  },
);

// POST /packages/:name/deprecate  { version, message }
maintenance.post('/packages/:name/deprecate', requireAuth, requirePackageManager, async (c) => {
  requireMutableRegistry(c);
  const config = c.get('config');
  await rateLimit(c, 'write', config.rateLimitWritesPerMinute);
  const body = deprecateSchema.parse(await c.req.json());
  const { repo, pkg } = await requireMaintainer(c, c.req.param('name')!);
  const version = await repo.getVersion(pkg.$id, body.version);
  if (!version || !['published', 'yanked'].includes(version.status)) {
    throw notFound(ErrorCodes.VERSION_NOT_FOUND, `Version ${body.version} not found`);
  }
  const deprecatedMessage = body.message.trim() || null;
  await repo.versions.update(version.$id, { deprecatedMessage });
  await audit(c, repo, pkg, 'version.deprecate', `${pkg.name}@${body.version}`).catch(
    () => undefined,
  );
  await invalidatePackage(c.env.KV, pkg.normalizedName).catch(() => undefined);
  return c.json({ version: body.version, deprecated: deprecatedMessage });
});

// POST /packages/:name/unpublish { version, force }. Artifacts are immutable;
// a normal yank removes discovery and mutable resolution while retaining exact
// downloads for lockfile reproducibility. A security block is a distinct
// version/package status and is never served by the artifact gateway.
maintenance.post('/packages/:name/unpublish', requireAuth, requirePackageManager, async (c) => {
  requireMutableRegistry(c);
  const config = c.get('config');
  await rateLimit(c, 'write', config.rateLimitWritesPerMinute);
  const body = unpublishSchema.parse(await c.req.json());
  const { repo, pkg } = await requireMaintainer(c, c.req.param('name')!);
  const version = await repo.getVersion(pkg.$id, body.version);
  if (!version || !['published', 'yanked'].includes(version.status)) {
    throw notFound(ErrorCodes.VERSION_NOT_FOUND, `Version ${body.version} not found`);
  }
  const yankedAt = version.yankedAt ?? new Date().toISOString();
  // Write the edge-cache tombstone before source-of-truth state so an exact
  // request must re-check whether this is a normal yank or a security block.
  await Promise.all([
    c.env.KV.put(kvKeys.yanked(pkg.normalizedName, version.version), '1'),
    c.env.KV.delete(kvKeys.publicVersion(pkg.normalizedName, version.version)),
  ]);
  await repo.versions.update(version.$id, { status: 'yanked', yankedAt });
  const tags = await repo.listTags(pkg.$id, { queries: [AppwriteQuery.limit(5_000)] });
  await Promise.all(
    tags.rows.filter((tag) => tag.version === body.version).map((tag) => repo.tags.delete(tag.$id)),
  );
  await recomputeLatest(repo, pkg);
  await audit(
    c,
    repo,
    pkg,
    'version.unpublish',
    `${pkg.name}@${body.version} force=${body.force}`,
  ).catch(() => undefined);
  await invalidatePackage(c.env.KV, pkg.normalizedName).catch(() => undefined);
  return c.json({ version: body.version, yanked: true, artifactRetained: true });
});

// This emergency action is deliberately distinct from a normal yank: it is
// admin + Clerk-session only and remains available while publishing is frozen.
maintenance.post(
  '/packages/:name/security-block',
  requireAuth,
  requireClerkSession,
  async (c) => {
    if (c.get('role') !== 'admin') throw forbidden('Administrator access is required.');
    await rateLimit(c, 'write', 10);
    const body = securityBlockSchema.parse(await c.req.json());
    const { repo, pkg } = await requireMaintainer(c, c.req.param('name')!);
    const version = await repo.getVersion(pkg.$id, body.version);
    if (!version || !['published', 'yanked', 'blocked'].includes(version.status)) {
      throw notFound(ErrorCodes.VERSION_NOT_FOUND, `Version ${body.version} not found`);
    }

    // The tombstone is written first so every gateway path fails closed even
    // if the later TablesDB update or cache invalidation fails.
    await c.env.KV.put(kvKeys.blocked(pkg.normalizedName, version.version), '1');
    await c.env.KV.delete(kvKeys.publicVersion(pkg.normalizedName, version.version)).catch(
      () => undefined,
    );

    const blockedAt = version.blockedAt ?? new Date().toISOString();
    if (version.status !== 'blocked' || version.blockReason !== body.reason) {
      await repo.versions.update(version.$id, {
        status: 'blocked',
        blockedAt,
        blockReason: body.reason,
        yankedAt: version.yankedAt ?? blockedAt,
      });
    }
    const tags = await repo.listTags(pkg.$id, { queries: [AppwriteQuery.limit(5_000)] });
    await Promise.all(
      tags.rows
        .filter((tag) => tag.version === body.version)
        .map((tag) => repo.tags.delete(tag.$id)),
    );
    await recomputeLatest(repo, pkg);
    await invalidatePackage(c.env.KV, pkg.normalizedName).catch(() => undefined);
    await audit(
      c,
      repo,
      pkg,
      'version.security_block',
      `${pkg.name}@${body.version}: ${body.reason}`,
    ).catch(() => undefined);
    return c.json({
      version: body.version,
      blocked: true,
      artifactRetained: true,
      blockedAt,
    });
  },
);
