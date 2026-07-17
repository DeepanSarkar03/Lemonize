import { Hono, type Context } from 'hono';
import {
  badRequest,
  ErrorCodes,
  isValidVersion,
  normalizePackageName,
  notFound,
  unauthorized,
  validatePackageName,
} from '@lemonize/shared';
import type { AppBindings } from '../lib/env.js';
import type {
  AppwriteRow,
  PackageData,
  VersionData,
} from '../lib/appwrite-types.js';
import type { RegistryAppwriteRepository } from '../lib/appwrite-repository.js';
import { AppwriteQuery } from '../lib/appwrite.js';
import { requireAuth, requireClerkSession, requireReader } from '../lib/auth.js';
import { registryRepository } from '../lib/registry.js';
import { publisherQuotaUsage } from '../lib/publisher-usage.js';
import { PUBLISH_QUOTAS, artifactPromotionEnabled } from '../lib/publish-security.js';
import { CURRENT_TERMS_VERSION, hasCurrentTerms } from '../lib/account-policy.js';
import { rateLimit } from '../lib/ratelimit.js';

export const account = new Hono<AppBindings>();

const REPORT_REASONS = new Set([
  'malware',
  'security',
  'spam',
  'copyright',
  'impersonation',
  'other',
]);

function noStore(c: Context<AppBindings>): void {
  c.header('cache-control', 'private, no-store');
  c.header('pragma', 'no-cache');
}

function intQuery(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw badRequest(`limit must be an integer from 1 to ${max}.`);
  }
  return parsed;
}

function packageWire(pkg: AppwriteRow<PackageData>) {
  return {
    id: pkg.$id,
    name: pkg.name,
    status: pkg.status,
    description: pkg.description ?? null,
    latestVersion: pkg.latestVersion ?? null,
    versionCount: pkg.publishedVersionCount ?? 0,
    storageBytes: pkg.storageBytes,
    createdAt: pkg.$createdAt,
    updatedAt: pkg.$updatedAt,
  };
}

function versionWire(version: AppwriteRow<VersionData>) {
  return {
    id: version.$id,
    version: version.version,
    status: version.status,
    tag: version.tag,
    tarballSize: version.tarballSize,
    scanError: version.scanError ?? null,
    publishedAt: version.publishedAt ?? null,
    yankedAt: version.yankedAt ?? null,
    createdAt: version.$createdAt,
    updatedAt: version.$updatedAt,
  };
}

async function ownedPackage(
  c: Context<AppBindings>,
  repo: RegistryAppwriteRepository,
  name: string,
): Promise<AppwriteRow<PackageData>> {
  const pkg = await repo.getPackageByNormalizedName(normalizePackageName(name));
  if (!pkg || (pkg.ownerId !== c.get('userId') && c.get('role') !== 'admin')) {
    throw notFound(ErrorCodes.PACKAGE_NOT_FOUND, `Package ${name} was not found.`);
  }
  return pkg;
}

async function statusPayload(
  repo: RegistryAppwriteRepository,
  pkg: AppwriteRow<PackageData>,
  version: AppwriteRow<VersionData>,
) {
  const [job, reservation] = await Promise.all([
    repo.getScanJobByVersionId(version.$id),
    repo.getReservation(pkg.$id, version.version),
  ]);
  const phase =
    version.status === 'published'
      ? 'published'
      : version.status === 'yanked'
        ? 'yanked'
        : version.status === 'blocked'
          ? 'blocked'
          : job?.status ?? reservation?.status ?? version.status;
  return {
    package: pkg.name,
    packageId: pkg.$id,
    version: version.version,
    versionId: version.$id,
    phase,
    versionStatus: version.status,
    downloadable: version.status === 'published' || version.status === 'yanked',
    scan: job
      ? {
          status: job.status,
          attempts: job.attempts,
          error: job.lastError ?? version.scanError ?? null,
          nextAttemptAt: job.nextAttemptAt ?? null,
        }
      : null,
    updatedAt: version.$updatedAt,
    publishedAt: version.publishedAt ?? null,
  };
}

account.get('/account', requireAuth, requireReader, async (c) => {
  const user = await registryRepository(c.env).users.getOrNull(c.get('userId')!);
  if (!user) throw unauthorized();
  const termsCurrent = hasCurrentTerms(user);
  const eligible =
    termsCurrent && (user.role === 'publisher' || user.role === 'admin');
  noStore(c);
  return c.json({
    account: {
      id: user.$id,
      namespace: user.namespace,
      email: user.email,
      githubUsername: user.githubUsername ?? null,
      githubLinked: Boolean(user.githubId),
      role: user.role,
      status: user.status,
      createdAt: user.$createdAt,
      lastLoginAt: user.lastLoginAt ?? null,
    },
    terms: {
      currentVersion: CURRENT_TERMS_VERSION,
      acceptedVersion: user.acceptedTermsVersion ?? null,
      acceptedAt: user.acceptedTermsAt ?? null,
      current: termsCurrent,
    },
    publishing: {
      eligible,
      enabled: eligible && artifactPromotionEnabled(c.get('config')),
      registryMode: c.get('config').registryMode,
      requiresGithub: user.role !== 'admin',
    },
  });
});

account.post('/account/terms', requireAuth, requireClerkSession, async (c) => {
  await rateLimit(c, 'write', 10);
  const raw: unknown = await c.req.json();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('Terms acceptance body must be an object.');
  }
  const version = (raw as Record<string, unknown>).version;
  if (version !== CURRENT_TERMS_VERSION) {
    throw badRequest(`You must accept terms version ${CURRENT_TERMS_VERSION}.`);
  }
  const repo = registryRepository(c.env);
  const acceptedAt = new Date().toISOString();
  const user = await repo.users.update(c.get('userId')!, {
    acceptedTermsAt: acceptedAt,
    acceptedTermsVersion: CURRENT_TERMS_VERSION,
  });
  await repo.appendAudit({
    actorId: user.$id,
    action: 'terms.accept',
    resourceType: 'account',
    resourceId: user.$id,
    detail: CURRENT_TERMS_VERSION,
    requestId: c.get('requestId'),
    ipHash: null,
  }).catch(() => undefined);
  noStore(c);
  return c.json({ version: CURRENT_TERMS_VERSION, acceptedAt });
});

account.get('/account/packages', requireAuth, requireReader, async (c) => {
  const repo = registryRepository(c.env);
  const rows = await repo.listPackagesByOwner(c.get('userId')!, {
    total: false,
    queries: [AppwriteQuery.orderDesc('$updatedAt'), AppwriteQuery.limit(25)],
  });
  const packages = await Promise.all(
    rows.rows.map(async (pkg) => {
      const versions = await repo.listVersions(pkg.$id, {
        total: false,
        queries: [AppwriteQuery.limit(PUBLISH_QUOTAS.maxVersionsPerPackage)],
      });
      return {
        ...packageWire(pkg),
        versions: versions.rows.reverse().map(versionWire),
      };
    }),
  );
  noStore(c);
  return c.json({ packages });
});

account.get('/account/usage', requireAuth, requireReader, async (c) => {
  const repo = registryRepository(c.env);
  const usage = await publisherQuotaUsage(repo, c.get('userId')!);
  const versionCounts = await Promise.all(
    usage.packages.map(async (pkg) =>
      (await repo.listVersions(pkg.$id, {
        total: false,
        queries: [AppwriteQuery.limit(PUBLISH_QUOTAS.maxVersionsPerPackage + 1)],
      })).rows.length,
    ),
  );
  noStore(c);
  return c.json({
    usage: {
      packages: usage.packages.length,
      versions: versionCounts.reduce((total, count) => total + count, 0),
      maxVersionsInPackage: Math.max(0, ...versionCounts),
      publishedBytes: usage.publishedBytes,
      reservedBytes: usage.reservedBytes,
      storedAndReservedBytes: usage.storedAndReservedBytes,
      activePublishes: usage.liveReservations,
    },
    limits: {
      packages: PUBLISH_QUOTAS.maxPackages,
      versionsPerPackage: PUBLISH_QUOTAS.maxVersionsPerPackage,
      tarballBytes: Math.min(
        c.get('config').maxTarballSizeBytes,
        PUBLISH_QUOTAS.maxTarballSizeBytes,
      ),
      storageBytes: PUBLISH_QUOTAS.maxStoredAndReservedBytes,
      activePublishes: PUBLISH_QUOTAS.maxLiveReservations,
    },
  });
});

account.get('/account/audit', requireAuth, requireReader, async (c) => {
  const limit = intQuery(c.req.query('limit'), 30, 100);
  const rows = await registryRepository(c.env).listAuditByActor(c.get('userId')!, {
    total: false,
    queries: [AppwriteQuery.limit(limit)],
  });
  noStore(c);
  return c.json({
    events: rows.rows.map((row) => ({
      id: row.$id,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      detail: row.detail ?? null,
      createdAt: row.$createdAt,
    })),
  });
});

account.get('/packages/:name/versions/:version/status', requireAuth, requireReader, async (c) => {
  const repo = registryRepository(c.env);
  const pkg = await ownedPackage(c, repo, c.req.param('name')!);
  const version = await repo.getVersion(pkg.$id, c.req.param('version')!);
  if (!version) {
    throw notFound(ErrorCodes.VERSION_NOT_FOUND, 'Package version was not found.');
  }
  noStore(c);
  return c.json(await statusPayload(repo, pkg, version));
});

account.get('/publish/status/:versionId', requireAuth, requireReader, async (c) => {
  const repo = registryRepository(c.env);
  const versionId = c.req.param('versionId')!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(versionId)) {
    throw notFound(ErrorCodes.VERSION_NOT_FOUND, 'Package version was not found.');
  }
  const version = await repo.versions.getOrNull(versionId);
  if (!version) throw notFound(ErrorCodes.VERSION_NOT_FOUND, 'Package version was not found.');
  const pkg = await repo.packages.getOrNull(version.packageId);
  if (!pkg || (pkg.ownerId !== c.get('userId') && c.get('role') !== 'admin')) {
    throw notFound(ErrorCodes.VERSION_NOT_FOUND, 'Package version was not found.');
  }
  noStore(c);
  return c.json(await statusPayload(repo, pkg, version));
});

account.post('/reports', requireAuth, async (c) => {
  await rateLimit(c, 'write', 10);
  const raw: unknown = await c.req.json();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw badRequest('Report body must be an object.');
  }
  const body = raw as Record<string, unknown>;
  const packageNameValue = body.packageName ?? body.package ?? body.name;
  const reasonValue = body.reason;
  const detailValue = body.detail;
  const versionValue = body.version;
  if (typeof packageNameValue !== 'string') throw badRequest('packageName is required.');
  const checkedName = validatePackageName(packageNameValue);
  if (!checkedName.ok || !checkedName.parsed) throw badRequest('Invalid package name.');
  if (typeof reasonValue !== 'string' || !REPORT_REASONS.has(reasonValue)) {
    throw badRequest(`reason must be one of: ${[...REPORT_REASONS].join(', ')}.`);
  }
  if (typeof detailValue !== 'string' || detailValue.trim().length < 10) {
    throw badRequest('detail must contain at least 10 characters.');
  }
  const detail = detailValue.trim();
  if (detail.length > 2_000) throw badRequest('detail must be at most 2000 characters.');
  if (versionValue !== undefined && (typeof versionValue !== 'string' || !isValidVersion(versionValue))) {
    throw badRequest('version must be a valid semantic version.');
  }

  const repo = registryRepository(c.env);
  const pkg = await repo.getPackageByNormalizedName(normalizePackageName(checkedName.parsed.full));
  if (!pkg || pkg.status === 'deleted') {
    throw notFound(ErrorCodes.PACKAGE_NOT_FOUND, 'Package was not found.');
  }
  if (typeof versionValue === 'string') {
    const version = await repo.getVersion(pkg.$id, versionValue);
    if (
      !version ||
      (!['published', 'yanked', 'blocked'].includes(version.status) && !version.yankedAt)
    ) {
      throw notFound(ErrorCodes.VERSION_NOT_FOUND, 'Package version was not found.');
    }
  }
  const report = await repo.reports.create({
    reporterId: c.get('userId')!,
    packageId: pkg.$id,
    version: typeof versionValue === 'string' ? versionValue : null,
    reason: reasonValue,
    detail,
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
  });
  await repo.appendAudit({
    actorId: c.get('userId')!,
    action: 'report.create',
    resourceType: 'report',
    resourceId: report.$id,
    detail: `${pkg.name}${versionValue ? `@${versionValue}` : ''}: ${reasonValue}`,
    requestId: c.get('requestId'),
    ipHash: null,
  }).catch(() => undefined);
  noStore(c);
  return c.json({ id: report.$id, status: report.status }, 201);
});
