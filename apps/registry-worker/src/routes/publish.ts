import { Hono, type Context } from 'hono';
import {
  publishIntentSchema,
  createPackageSchema,
  validatePackageName,
  normalizePackageName,
  isValidVersion,
  isGreater,
  randomToken,
  hashToken,
  sha256Hex,
  timingSafeEqual,
  badRequest,
  forbidden,
  conflict,
  notFound,
  tooLarge,
  ErrorCodes,
  LemonizeError,
} from '@lemonize/shared';
import { loadConfig, type AppBindings, type Env } from '../lib/env.js';
import { requireAuth, requirePublisher } from '../lib/auth.js';
import { rateLimit } from '../lib/ratelimit.js';
import { invalidatePackage, kvKeys } from '../lib/kv-cache.js';
import { registryRepository } from '../lib/registry.js';
import { AppwriteError, AppwriteQuery } from '../lib/appwrite.js';
import type {
  AppwriteRow,
  PackageData,
  ReservationData,
  VersionData,
} from '../lib/appwrite-types.js';
import type { RegistryAppwriteRepository } from '../lib/appwrite-repository.js';
import { globalArtifactQuotaUsage, publisherQuotaUsage } from '../lib/publisher-usage.js';
import {
  assertPublishingIdentity,
  assertGlobalArtifactQuota,
  assertPublishQuota,
  artifactPromotionEnabled,
  immutableStagingKey,
  PUBLISH_QUOTAS,
  readRequestBodyLimited,
  scannerSignedHeaders,
  verifyScannerSignature,
} from '../lib/publish-security.js';

export const publish = new Hono<AppBindings>();
/** Mounted at `/`, not `/v1`, so the Appwrite scanner has a stable private protocol path. */
export const internalScan = new Hono<AppBindings>();

const EMPTY_BODY = new Uint8Array();
const SCAN_RESULT_LIMIT = 32 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,64}$/;
const DIST_TAG = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_RESULT_CODE = /^[a-z0-9_]{1,64}$/;
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

interface ScanJobPayload {
  schemaVersion: 1;
  jobId: string;
  versionId: string;
  packageName: string;
  version: string;
  shasum: string;
  integrity: string;
  manifestSha256: string;
  tarballSize: number;
  fileCount: number;
  unpackedSize: number;
}

interface ScannerResult {
  schemaVersion: 1;
  jobId: string;
  versionId: string;
  status: 'clean' | 'rejected' | 'error';
  code: string;
  scannedAt: string;
  shasum?: string;
  integrity?: string;
  manifestSha256?: string;
  fileCount?: number;
  unpackedSize?: number;
  quarantineFileId?: string;
}

function actor(c: Context<AppBindings>): { userId: string; namespace: string } {
  const userId = c.get('userId');
  const namespace = c.get('namespace');
  if (!userId || !namespace) throw forbidden('Your registry identity is incomplete.');
  return { userId, namespace };
}

function ensurePublishingEnabled(c: Context<AppBindings>): void {
  const config = c.get('config');
  if (!artifactPromotionEnabled(config)) {
    throw new LemonizeError(
      403,
      ErrorCodes.FEATURE_DISABLED,
      'Publishing is disabled on this registry.',
    );
  }
}

function requireOwnedPackage(c: Context<AppBindings>, pkg: AppwriteRow<PackageData>): void {
  const userId = c.get('userId');
  if (!userId || (pkg.ownerId !== userId && c.get('role') !== 'admin')) {
    throw forbidden('You are not the owner of this package.');
  }
}

function validSha512Integrity(value: string): boolean {
  if (!value.startsWith('sha512-')) return false;
  const encoded = value.slice(7);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  try {
    const binary = atob(encoded);
    return binary.length === 64 && btoa(binary) === encoded;
  } catch {
    return false;
  }
}

async function appendAudit(
  c: Context<AppBindings>,
  repo: RegistryAppwriteRepository,
  input: { action: string; resourceType: string; resourceId: string; detail?: string },
): Promise<void> {
  await repo.appendAudit({
    actorId: c.get('userId') ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    detail: input.detail ?? null,
    requestId: c.get('requestId'),
    ipHash: null,
  });
}

async function findOrCreatePackage(
  c: Context<AppBindings>,
  repo: RegistryAppwriteRepository,
  input: {
    name: string;
    normalizedName: string;
    scope: string;
    userId: string;
    description?: string | null;
  },
): Promise<AppwriteRow<PackageData>> {
  const found = await repo.getPackageByNormalizedName(input.normalizedName);
  if (found) {
    requireOwnedPackage(c, found);
    if (found.status !== 'active') throw forbidden('This package is not active.');
    return found;
  }

  try {
    const created = await repo.packages.create({
      name: input.name,
      normalizedName: input.normalizedName,
      scope: input.scope,
      ownerId: input.userId,
      description: input.description ?? null,
      readme: null,
      status: 'active',
      latestVersion: null,
      storageBytes: 0,
      publishedVersionCount: 0,
    });
    await appendAudit(c, repo, {
      action: 'package.create',
      resourceType: 'package',
      resourceId: created.$id,
      detail: created.name,
    }).catch(() => undefined);
    return created;
  } catch (error) {
    if (!(error instanceof AppwriteError) || error.status !== 409) throw error;
    const raced = await repo.getPackageByNormalizedName(input.normalizedName);
    if (!raced) throw error;
    requireOwnedPackage(c, raced);
    if (raced.status !== 'active') throw forbidden('This package is not active.');
    return raced;
  }
}

function reservationExpired(reservation: AppwriteRow<ReservationData>): boolean {
  const expiry = Date.parse(reservation.expiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now();
}

async function acquirePublisherQuotaLock(env: Env, userId: string): Promise<string> {
  const key = `internal/quota-locks/${await hashToken(`publisher:${userId}`)}`;
  const attempt = () =>
    env.BUCKET.put(key, new TextEncoder().encode('1'), {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { cacheControl: 'private, no-store' },
    });
  let lock = await attempt();
  if (!lock) {
    const existing = await env.BUCKET.head(key);
    if (existing && existing.uploaded.getTime() < Date.now() - 2 * 60_000) {
      await env.BUCKET.delete(key);
      lock = await attempt();
    }
  }
  if (!lock) throw conflict(ErrorCodes.CONFLICT, 'Another publish operation is in progress.');
  return key;
}

async function acquireGlobalArtifactQuotaLock(env: Env): Promise<string> {
  const key = 'internal/quota-locks/global-artifact-reservations';
  const attempt = () =>
    env.BUCKET.put(key, new TextEncoder().encode('1'), {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { cacheControl: 'private, no-store' },
    });
  let lock = await attempt();
  if (!lock) {
    const existing = await env.BUCKET.head(key);
    if (existing && existing.uploaded.getTime() < Date.now() - 2 * 60_000) {
      await env.BUCKET.delete(key);
      lock = await attempt();
    }
  }
  if (!lock) throw conflict(ErrorCodes.CONFLICT, 'Another publish reservation is in progress.');
  return key;
}

function streamWithLimit(
  body: ReadableStream<Uint8Array>,
  limit: number,
  counter: { bytes: number },
): ReadableStream<Uint8Array> {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        counter.bytes += chunk.byteLength;
        if (counter.bytes > limit) {
          controller.error(new Error('upload_limit_exceeded'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function appwriteBase(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
}

async function deleteQuarantineFile(env: Env, fileId: string | null | undefined): Promise<void> {
  if (!fileId || !SAFE_FILE_ID.test(fileId)) return;
  const bucketId = env.APPWRITE_QUARANTINE_BUCKET_ID || 'quarantine';
  if (!SAFE_FILE_ID.test(bucketId)) return;
  const response = await fetch(
    `${appwriteBase(env.APPWRITE_ENDPOINT)}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}`,
    {
      method: 'DELETE',
      headers: {
        'X-Appwrite-Project': env.APPWRITE_PROJECT_ID,
        'X-Appwrite-Key': env.APPWRITE_API_KEY,
      },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Quarantine cleanup failed.');
  }
  await response.body?.cancel().catch(() => undefined);
}

async function dispatchScanner(env: Env, payload: ScanJobPayload): Promise<void> {
  const functionId = env.APPWRITE_SCANNER_FUNCTION_ID;
  if (!functionId || !SAFE_FILE_ID.test(functionId))
    throw new Error('Scanner function is not configured.');
  const functionPath = '/scan';
  const body = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(body);
  const signed = await scannerSignedHeaders({
    secret: env.SCANNER_SHARED_SECRET,
    method: 'POST',
    url: functionPath,
    body: bytes,
  });
  const response = await fetch(
    `${appwriteBase(env.APPWRITE_ENDPOINT)}/functions/${encodeURIComponent(functionId)}/executions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Appwrite-Project': env.APPWRITE_PROJECT_ID,
        'X-Appwrite-Key': env.APPWRITE_API_KEY,
      },
      body: JSON.stringify({
        body,
        async: true,
        path: functionPath,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signed,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Scanner dispatch failed with status ${response.status}.`);
  }
  await response.body?.cancel().catch(() => undefined);
}

/** Called by the Worker's scheduled handler. A small batch keeps free-tier CPU
 * and Appwrite execution usage bounded even during a provider incident. */
export async function retryReadyScans(env: Env, limit = 5): Promise<number> {
  if (!artifactPromotionEnabled(loadConfig(env))) return 0;
  const repo = registryRepository(env);
  const jobs = await repo.listReadyScanJobs(new Date().toISOString(), {
    queries: [],
    total: false,
  });
  let dispatched = 0;
  for (const job of jobs.rows.slice(0, Math.max(0, Math.min(limit, 10)))) {
    if (!['pending', 'retry', 'dispatching', 'queued', 'running'].includes(job.status)) continue;
    const version = await repo.versions.getOrNull(job.versionId);
    if (!version || !['scanning', 'published'].includes(version.status)) continue;
    const pkg = await repo.packages.getOrNull(version.packageId);
    if (!pkg) continue;
    if (version.status === 'published') {
      try {
        if (!version.artifactKey) continue;
        const artifact = await env.BUCKET.head(version.artifactKey);
        if (
          !artifact ||
          artifact.size !== version.tarballSize ||
          artifact.customMetadata?.shasum !== version.shasum
        ) {
          continue;
        }
        if (version.tag !== 'latest') {
          await repo.setTag({ packageId: pkg.$id, tag: version.tag, version: version.version });
        }
        await refreshPackageMetadata(repo, pkg, version);
        const reservation = await repo.getReservation(version.packageId, version.version);
        if (reservation) await repo.reservations.update(reservation.$id, { status: 'completed' });
        await repo.completeScanJob(job.$id, { reconciled: true, versionId: version.$id });
        if (version.stagingKey) await env.BUCKET.delete(version.stagingKey).catch(() => undefined);
        await invalidatePackage(env.KV, pkg.normalizedName).catch(() => undefined);
      } catch {
        // The job remains due and the next bounded maintenance pass retries it.
      }
      continue;
    }
    if (job.attempts >= 3) {
      await repo.failScanJob(job.$id, job.attempts, 'scan_result_timeout', null);
      await repo.versions.update(version.$id, {
        status: 'failed',
        scanError: 'scan_result_timeout',
      });
      const reservation = await repo.getReservation(version.packageId, version.version);
      if (reservation) await repo.reservations.update(reservation.$id, { status: 'failed' });
      continue;
    }
    let accepted = false;
    try {
      await repo.scanJobs.update(job.$id, {
        status: 'dispatching',
        attempts: job.attempts + 1,
        nextAttemptAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      });
      await dispatchScanner(env, await scanPayload(job.$id, version, pkg));
      accepted = true;
      const current = await repo.scanJobs.getOrNull(job.$id);
      if (current?.status === 'dispatching') {
        await repo.scanJobs.update(job.$id, {
          status: 'queued',
          nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          lastError: null,
        });
      }
      dispatched += 1;
    } catch {
      if (accepted) {
        dispatched += 1;
        continue;
      }
      const attempts = job.attempts + 1;
      const terminal = attempts >= 3;
      const nextAttemptAt = terminal
        ? null
        : new Date(Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** attempts)).toISOString();
      await repo.failScanJob(job.$id, attempts, 'scanner_dispatch_failed', nextAttemptAt);
      if (terminal) {
        await repo.versions.update(version.$id, {
          status: 'failed',
          scanError: 'scanner_dispatch_failed',
        });
        const reservation = await repo.getReservation(version.packageId, version.version);
        if (reservation) await repo.reservations.update(reservation.$id, { status: 'failed' });
      }
    }
  }
  return dispatched;
}

/** Two-phase expiry avoids racing an in-flight upload: one scheduled pass marks
 * the capability dead, and a later pass removes its private object and rows. */
export async function cleanupExpiredReservations(env: Env, limit = 20): Promise<number> {
  const repo = registryRepository(env);
  const reservations = await repo.listExpiredReservations(new Date().toISOString(), {
    total: false,
  });
  let cleaned = 0;
  for (const reservation of reservations.rows.slice(0, Math.max(0, Math.min(limit, 50)))) {
    if (['awaiting_upload', 'uploading', 'uploaded'].includes(reservation.status)) {
      await repo.reservations.update(reservation.$id, { status: 'expired' });
      continue;
    }
    if (reservation.status === 'failed') {
      const failedAt = Date.parse(reservation.$updatedAt);
      if (Number.isFinite(failedAt) && failedAt > Date.now() - 24 * 60 * 60 * 1_000) continue;
      await repo.reservations.update(reservation.$id, { status: 'expired' });
      continue;
    }
    if (reservation.status === 'scanning') {
      const scanningSince = Date.parse(reservation.$updatedAt);
      if (Number.isFinite(scanningSince) && scanningSince > Date.now() - 24 * 60 * 60 * 1_000) {
        continue;
      }
      const version = await repo.getVersion(reservation.packageId, reservation.version);
      const job = version ? await repo.getScanJobByVersionId(version.$id) : null;
      if (!version) {
        await repo.reservations.update(reservation.$id, { status: 'expired' });
      } else if (!job || job.status === 'failed') {
        await repo.versions.update(version.$id, {
          status: 'failed',
          scanError: 'scan_job_orphaned',
        });
        await repo.reservations.update(reservation.$id, { status: 'expired' });
      }
      continue;
    }
    if (reservation.status === 'expired') {
      const version = await repo.getVersion(reservation.packageId, reservation.version);
      if (version && ['reserved', 'failed'].includes(version.status)) {
        await deleteQuarantineFile(
          env,
          version.archiveFileId ?? `scan-${version.shasum.toLowerCase().slice(0, 30)}`,
        ).catch(() => undefined);
        const job = await repo.getScanJobByVersionId(version.$id);
        if (job) await repo.scanJobs.delete(job.$id);
        await repo.versions.delete(version.$id);
      }
      await env.BUCKET.delete(reservation.stagingKey).catch(() => undefined);
      await repo.reservations.delete(reservation.$id);
      cleaned += 1;
      continue;
    }
    if (['completed', 'rejected'].includes(reservation.status)) {
      const version = await repo.getVersion(reservation.packageId, reservation.version);
      if (version) {
        // Keep the antivirus-accepted Appwrite copy for published versions as
        // an independent recovery source. Rejected bytes are never retained.
        if (reservation.status === 'rejected') {
          await deleteQuarantineFile(
            env,
            version.archiveFileId ?? `scan-${version.shasum.toLowerCase().slice(0, 30)}`,
          ).catch(() => undefined);
        }
        const job = await repo.getScanJobByVersionId(version.$id);
        if (job) await repo.scanJobs.delete(job.$id);
      }
      await env.BUCKET.delete(reservation.stagingKey).catch(() => undefined);
      await repo.reservations.delete(reservation.$id);
      cleaned += 1;
    }
  }
  return cleaned;
}

export async function maintainPublishingState(env: Env): Promise<{
  scansDispatched: number;
  reservationsCleaned: number;
}> {
  const scansDispatched = await retryReadyScans(env, 2);
  const reservationsCleaned = await cleanupExpiredReservations(env, 3);
  return { scansDispatched, reservationsCleaned };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Stored manifest is not valid JSON data.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Stored manifest is not valid JSON data.');
}

async function declaredManifestSha256(manifestJson: string): Promise<string> {
  const parsed = JSON.parse(manifestJson) as unknown;
  return sha256Hex(new TextEncoder().encode(canonicalJson(parsed)));
}

async function scanPayload(
  jobId: string,
  version: AppwriteRow<VersionData>,
  pkg: AppwriteRow<PackageData>,
): Promise<ScanJobPayload> {
  return {
    schemaVersion: 1,
    jobId,
    versionId: version.$id,
    packageName: pkg.name,
    version: version.version,
    shasum: version.shasum,
    integrity: version.integrity,
    manifestSha256: await declaredManifestSha256(version.manifest),
    tarballSize: version.tarballSize,
    fileCount: version.fileCount,
    unpackedSize: version.unpackedSize,
  };
}

function scannerResult(value: unknown): ScannerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw badRequest('Invalid scan result.');
  const result = value as Partial<ScannerResult>;
  const date = typeof result.scannedAt === 'string' ? Date.parse(result.scannedAt) : Number.NaN;
  if (
    result.schemaVersion !== 1 ||
    typeof result.jobId !== 'string' ||
    !SAFE_FILE_ID.test(result.jobId) ||
    typeof result.versionId !== 'string' ||
    !SAFE_FILE_ID.test(result.versionId) ||
    !['clean', 'rejected', 'error'].includes(result.status ?? '') ||
    typeof result.code !== 'string' ||
    !SAFE_RESULT_CODE.test(result.code) ||
    !Number.isFinite(date)
  ) {
    throw badRequest('Invalid scan result.');
  }
  if (result.status === 'clean') {
    if (
      typeof result.shasum !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(result.shasum) ||
      typeof result.integrity !== 'string' ||
      !validSha512Integrity(result.integrity) ||
      typeof result.manifestSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(result.manifestSha256) ||
      !Number.isSafeInteger(result.fileCount) ||
      (result.fileCount ?? 0) < 1 ||
      !Number.isSafeInteger(result.unpackedSize) ||
      (result.unpackedSize ?? -1) < 0 ||
      typeof result.quarantineFileId !== 'string' ||
      !SAFE_FILE_ID.test(result.quarantineFileId)
    ) {
      throw badRequest('Incomplete clean scan result.');
    }
  }
  return result as ScannerResult;
}

async function refreshPackageMetadata(
  repo: RegistryAppwriteRepository,
  pkg: AppwriteRow<PackageData>,
  promoted: AppwriteRow<VersionData>,
): Promise<void> {
  const [versionList, latestTag] = await Promise.all([
    repo.listVersions(pkg.$id, {
      queries: [AppwriteQuery.limit(5_000)],
    }),
    repo.getTag(pkg.$id, 'latest'),
  ]);
  const published = versionList.rows.filter(
    (version) => version.status === 'published' && !version.yankedAt,
  );
  const taggedLatest = latestTag
    ? published.find((version) => version.version === latestTag.version)
    : undefined;
  let latest: string | null = taggedLatest?.version ?? null;
  if (
    promoted.tag === 'latest' &&
    published.some((version) => version.$id === promoted.$id) &&
    (!latest || isGreater(promoted.version, latest))
  ) {
    latest = promoted.version;
  }
  let storageBytes = 0;
  for (const version of versionList.rows.filter((candidate) => Boolean(candidate.artifactKey))) {
    storageBytes += version.tarballSize;
  }
  let readme = pkg.readme ?? null;
  if (latest) {
    const latestVersion = published.find((version) => version.version === latest);
    if (latestVersion) {
      try {
        const manifest = JSON.parse(latestVersion.manifest) as Record<string, unknown>;
        if (typeof manifest.readme === 'string') readme = manifest.readme;
      } catch {
        // Manifest JSON was validated before storage; retaining the old readme is safe.
      }
    }
  }
  await repo.packages.update(pkg.$id, {
    latestVersion: latest,
    storageBytes,
    publishedVersionCount: published.length,
    readme,
  });
  if (latest && latestTag?.version !== latest) {
    await repo.setTag({ packageId: pkg.$id, tag: 'latest', version: latest });
  } else if (!latest && latestTag) {
    await repo.tags.delete(latestTag.$id);
  }
}

// Create a package explicitly. Packages are always namespace-scoped.
publish.post('/packages', requireAuth, requirePublisher, async (c) => {
  ensurePublishingEnabled(c);
  const config = c.get('config');
  await rateLimit(c, 'write', config.rateLimitWritesPerMinute);
  const body = createPackageSchema.parse(await c.req.json());
  const check = validatePackageName(body.name);
  if (!check.ok || !check.parsed) throw badRequest('Invalid package name', check.errors);
  assertPublishingIdentity({
    namespace: c.get('namespace'),
    packageScope: check.parsed.scope,
    tokenScopes: c.get('tokenScopes'),
  });
  if (body.visibility === 'private') {
    throw new LemonizeError(
      403,
      ErrorCodes.FEATURE_DISABLED,
      'Private packages are not enabled on this registry.',
    );
  }
  const { userId } = actor(c);
  const repo = registryRepository(c.env);
  const normalizedName = normalizePackageName(body.name);
  const quotaLock = await acquirePublisherQuotaLock(c.env, userId);
  try {
    const usage = await publisherQuotaUsage(repo, userId);
    const existing = await repo.getPackageByNormalizedName(normalizedName);
    if (existing) throw conflict(ErrorCodes.NAME_TAKEN, `Package ${body.name} already exists.`);
    assertPublishQuota({
      packageCount: usage.packages.length,
      liveReservations: usage.liveReservations,
      storedAndReservedBytes: usage.storedAndReservedBytes,
      addsPackage: true,
      addsReservation: false,
    });
    const pkg = await findOrCreatePackage(c, repo, {
      name: check.parsed.full,
      normalizedName,
      scope: check.parsed.scope!,
      userId,
      description: body.description ?? null,
    });
    await repo.users.update(userId, { packageCount: usage.packages.length + 1 });
    return c.json({ id: pkg.$id, name: pkg.name, visibility: 'public' }, 201);
  } finally {
    await c.env.BUCKET.delete(quotaLock).catch(() => undefined);
  }
});

// Reserve a unique package version before handing out any upload capability.
publish.post('/packages/:name/versions', requireAuth, requirePublisher, async (c) => {
  ensurePublishingEnabled(c);
  const config = c.get('config');
  await rateLimit(c, 'write', config.rateLimitWritesPerMinute);
  const name = c.req.param('name')!;
  const intent = publishIntentSchema.parse(await c.req.json());
  const check = validatePackageName(name);
  if (!check.ok || !check.parsed) throw badRequest('Invalid package name', check.errors);
  assertPublishingIdentity({
    namespace: c.get('namespace'),
    packageScope: check.parsed.scope,
    tokenScopes: c.get('tokenScopes'),
  });
  if (intent.manifest.name !== check.parsed.full) {
    throw badRequest(`Manifest name "${intent.manifest.name}" does not match path "${name}".`);
  }
  if (!isValidVersion(intent.manifest.version)) throw badRequest('Invalid semver version.');
  if (!validSha512Integrity(intent.integrity)) throw badRequest('Invalid sha512 integrity.');
  const maxTarballSizeBytes = Math.min(
    config.maxTarballSizeBytes,
    PUBLISH_QUOTAS.maxTarballSizeBytes,
  );
  if (intent.tarballSize > maxTarballSizeBytes) {
    throw tooLarge(
      `Tarball ${intent.tarballSize} bytes exceeds limit ${maxTarballSizeBytes}.`,
    );
  }
  if (intent.unpackedSize > config.maxUnpackedSizeBytes) {
    throw tooLarge(`Unpacked package exceeds limit ${config.maxUnpackedSizeBytes}.`);
  }
  if (intent.fileCount > config.maxPackageFiles) {
    throw tooLarge(`Package has ${intent.fileCount} files; limit is ${config.maxPackageFiles}.`);
  }
  const tag = intent.tag ?? intent.manifest.lemonize?.tag ?? 'latest';
  if (!DIST_TAG.test(tag)) throw badRequest('Invalid distribution tag.');
  const access = intent.access ?? intent.manifest.lemonize?.access ?? 'public';
  if (access !== 'public') {
    throw new LemonizeError(403, ErrorCodes.FEATURE_DISABLED, 'Private packages are not enabled.');
  }
  const manifest = JSON.stringify(intent.manifest);
  if (new TextEncoder().encode(manifest).byteLength > 256 * 1024) {
    throw tooLarge('Manifest exceeds 256 KiB.');
  }

  const { userId } = actor(c);
  const repo = registryRepository(c.env);
  const normalizedName = normalizePackageName(name);
  const globalQuotaLock = await acquireGlobalArtifactQuotaLock(c.env);
  let quotaLock: string | null = null;
  try {
    quotaLock = await acquirePublisherQuotaLock(c.env, userId);
    const usage = await publisherQuotaUsage(repo, userId);
    const globalStoredAndReservedBytes = await globalArtifactQuotaUsage(repo);
    assertGlobalArtifactQuota({
      storedAndReservedBytes: globalStoredAndReservedBytes,
      additionalBytes: intent.tarballSize,
      maximumBytes: config.maxGlobalArtifactBytes,
    });
    const ownedPackage = usage.packages.find(
      (candidate) => candidate.normalizedName === normalizedName,
    );
    assertPublishQuota({
      packageCount: usage.packages.length,
      liveReservations: usage.liveReservations,
      storedAndReservedBytes: usage.storedAndReservedBytes,
      addsPackage: !ownedPackage,
      additionalBytes: intent.tarballSize,
    });
    const pkg = await findOrCreatePackage(c, repo, {
      name: check.parsed.full,
      normalizedName,
      scope: check.parsed.scope!,
      userId,
      description: intent.manifest.description ?? null,
    });
    if (!ownedPackage) {
      await repo.users.update(userId, { packageCount: usage.packages.length + 1 });
    }
    const existingVersions = await repo.listVersions(pkg.$id, {
      queries: [AppwriteQuery.limit(101)],
      total: false,
    });
    assertPublishQuota({
      packageCount: usage.packages.length,
      liveReservations: usage.liveReservations,
      storedAndReservedBytes: usage.storedAndReservedBytes,
      addsPackage: false,
      addsReservation: false,
      versionCount: existingVersions.rows.length,
    });
    if (await repo.getVersion(pkg.$id, intent.manifest.version)) {
      throw conflict(
        ErrorCodes.VERSION_EXISTS,
        `${pkg.name}@${intent.manifest.version} already exists and cannot be overwritten.`,
      );
    }

    const suppliedIdempotency = c.req.header('idempotency-key');
    if (suppliedIdempotency && !IDEMPOTENCY_KEY.test(suppliedIdempotency)) {
      throw badRequest('Invalid Idempotency-Key.');
    }
    const idempotencyKey = suppliedIdempotency ?? crypto.randomUUID();
    if (await repo.getReservationByIdempotencyKey(idempotencyKey)) {
      throw conflict(ErrorCodes.CONFLICT, 'This idempotency key has already been used.');
    }

    const reservationId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const uploadToken = randomToken(32);
    const uploadTokenHash = await hashToken(uploadToken);
    const stagingKey = immutableStagingKey(reservationId);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    try {
      await repo.reservations.create(
        {
          packageId: pkg.$id,
          version: intent.manifest.version,
          userId,
          idempotencyKey,
          uploadTokenHash,
          stagingKey,
          status: 'awaiting_upload',
          expiresAt,
        },
        reservationId,
      );
    } catch (error) {
      if (error instanceof AppwriteError && error.status === 409) {
        throw conflict(
          ErrorCodes.VERSION_EXISTS,
          `${pkg.name}@${intent.manifest.version} is already reserved or published.`,
        );
      }
      throw error;
    }

    try {
      await repo.versions.create(
        {
          packageId: pkg.$id,
          version: intent.manifest.version,
          status: 'reserved',
          stagingKey,
          artifactKey: null,
          archiveFileId: null,
          integrity: intent.integrity,
          shasum: intent.shasum,
          computedShasum: null,
          tarballSize: intent.tarballSize,
          unpackedSize: intent.unpackedSize,
          fileCount: intent.fileCount,
          manifest,
          tag,
          publishedBy: userId,
          scanError: null,
          publishedAt: null,
          yankedAt: null,
        },
        versionId,
      );
    } catch (error) {
      await repo.reservations.delete(reservationId).catch(() => undefined);
      if (error instanceof AppwriteError && error.status === 409) {
        throw conflict(
          ErrorCodes.VERSION_EXISTS,
          `${pkg.name}@${intent.manifest.version} already exists and cannot be overwritten.`,
        );
      }
      throw error;
    }

    await appendAudit(c, repo, {
      action: 'version.reserve',
      resourceType: 'version',
      resourceId: versionId,
      detail: `${pkg.name}@${intent.manifest.version}`,
    }).catch(() => undefined);
    return c.json({
      packageId: pkg.$id,
      version: intent.manifest.version,
      // The raw capability is deliberately kept out of the URL so edge access
      // logs contain only a non-secret reservation ID.
      uploadUrl: `${config.registryBaseUrl}/v1/uploads/${reservationId}`,
      uploadToken,
      method: 'PUT',
      expiresAt,
    });
  } finally {
    if (quotaLock) await c.env.BUCKET.delete(quotaLock).catch(() => undefined);
    await c.env.BUCKET.delete(globalQuotaLock).catch(() => undefined);
  }
});

// The random upload token resolves to an Appwrite reservation. R2's conditional
// write is the final guard against two concurrent requests overwriting a stage.
publish.put('/uploads/:reservationId', async (c) => {
  ensurePublishingEnabled(c);
  const config = c.get('config');
  const headerToken = c.req.header('x-lemonize-upload-token');
  if (!headerToken) throw forbidden('Upload token is required.');
  await rateLimit(c, 'upload', config.rateLimitWritesPerMinute);
  const repo = registryRepository(c.env);
  const reservation = await repo.getReservationByUploadTokenHash(await hashToken(headerToken));
  if (
    !reservation ||
    reservation.$id !== c.req.param('reservationId') ||
    reservationExpired(reservation)
  ) {
    throw notFound(ErrorCodes.NOT_FOUND, 'Upload session expired or not found.');
  }
  const version = await repo.getVersion(reservation.packageId, reservation.version);
  if (!version || version.stagingKey !== reservation.stagingKey) {
    throw notFound(ErrorCodes.NOT_FOUND, 'Upload session is invalid.');
  }
  if (reservation.status === 'uploaded') {
    const stored = await c.env.BUCKET.head(reservation.stagingKey);
    if (stored?.size === version.tarballSize) return c.json({ ok: true, size: stored.size });
  }
  if (!['awaiting_upload', 'uploading'].includes(reservation.status)) {
    throw conflict(ErrorCodes.CONFLICT, 'Upload session has already been consumed.');
  }
  const contentLength = c.req.header('content-length');
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw badRequest('Invalid Content-Length.');
    if (parsed > Math.min(config.maxTarballSizeBytes, PUBLISH_QUOTAS.maxTarballSizeBytes)) {
      throw tooLarge('Upload exceeds maximum tarball size.');
    }
    if (parsed !== version.tarballSize) {
      throw badRequest(`Upload size ${parsed} does not match declared ${version.tarballSize}.`);
    }
  }
  if (!c.req.raw.body) throw badRequest('Empty upload body.');

  if (reservation.status === 'uploading') {
    const stored = await c.env.BUCKET.head(reservation.stagingKey);
    if (stored?.size === version.tarballSize) {
      await repo.reservations.update(reservation.$id, { status: 'uploaded' });
      return c.json({ ok: true, size: stored.size });
    }
  }
  await repo.reservations.update(reservation.$id, { status: 'uploading' });
  const counter = { bytes: 0 };
  let put: R2Object | null;
  try {
    put = await c.env.BUCKET.put(
      reservation.stagingKey,
      streamWithLimit(c.req.raw.body, version.tarballSize, counter),
      {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/gzip', cacheControl: 'private, no-store' },
        customMetadata: {
          reservationId: reservation.$id,
          versionId: version.$id,
          shasum: version.shasum,
        },
      },
    );
  } catch (error) {
    await c.env.BUCKET.delete(reservation.stagingKey).catch(() => undefined);
    await repo.reservations
      .update(reservation.$id, { status: 'awaiting_upload' })
      .catch(() => undefined);
    if (counter.bytes > version.tarballSize) throw tooLarge('Upload exceeds its declared size.');
    throw error;
  }
  if (!put) throw conflict(ErrorCodes.CONFLICT, 'The staging object already exists.');
  if (put.size !== version.tarballSize || put.size > config.maxTarballSizeBytes) {
    await c.env.BUCKET.delete(reservation.stagingKey);
    await repo.reservations
      .update(reservation.$id, { status: 'awaiting_upload' })
      .catch(() => undefined);
    throw new LemonizeError(
      422,
      ErrorCodes.INTEGRITY_MISMATCH,
      `Stored size ${put.size} does not match declared ${version.tarballSize}.`,
    );
  }
  await repo.reservations.update(reservation.$id, { status: 'uploaded' });
  return c.json({ ok: true, size: put.size });
});

// Finalization queues scanning. It does not make the version visible.
publish.post(
  '/packages/:name/versions/:version/finalize',
  requireAuth,
  requirePublisher,
  async (c) => {
    ensurePublishingEnabled(c);
    const config = c.get('config');
    await rateLimit(c, 'write', config.rateLimitWritesPerMinute);
    const uploadToken = c.req.header('x-lemonize-upload-token');
    if (!uploadToken) throw badRequest('Missing upload token.');
    const repo = registryRepository(c.env);
    const reservation = await repo.getReservationByUploadTokenHash(await hashToken(uploadToken));
    const resumableStatus =
      reservation && ['scanning', 'failed', 'completed'].includes(reservation.status);
    if (!reservation || (reservationExpired(reservation) && !resumableStatus)) {
      throw notFound(ErrorCodes.NOT_FOUND, 'Upload session expired.');
    }
    const { userId } = actor(c);
    if (reservation.userId !== userId) throw forbidden('Upload does not belong to you.');
    if (reservation.version !== c.req.param('version')) throw badRequest('Version mismatch.');
    const pkg = await repo.packages.getOrNull(reservation.packageId);
    if (!pkg || normalizePackageName(pkg.name) !== normalizePackageName(c.req.param('name')!)) {
      throw badRequest('Package mismatch.');
    }
    requireOwnedPackage(c, pkg);
    const version = await repo.getVersion(pkg.$id, reservation.version);
    if (!version || version.stagingKey !== reservation.stagingKey) {
      throw notFound(ErrorCodes.VERSION_NOT_FOUND, 'Reserved version was not found.');
    }
    if (version.status === 'published') {
      if (!version.artifactKey) {
        throw new LemonizeError(
          422,
          ErrorCodes.ARTIFACT_MISSING,
          'Published artifact key is missing.',
        );
      }
      const artifact = await c.env.BUCKET.head(version.artifactKey);
      if (
        !artifact ||
        artifact.size !== version.tarballSize ||
        artifact.customMetadata?.shasum !== version.shasum
      ) {
        throw new LemonizeError(422, ErrorCodes.ARTIFACT_MISSING, 'Published artifact is missing.');
      }
      if (version.tag !== 'latest') {
        await repo.setTag({ packageId: pkg.$id, tag: version.tag, version: version.version });
      }
      await refreshPackageMetadata(repo, pkg, version);
      await repo.reservations.update(reservation.$id, { status: 'completed' });
      const existingJob = await repo.getScanJobByVersionId(version.$id);
      if (existingJob && existingJob.status !== 'completed') {
        await repo.completeScanJob(existingJob.$id, { reconciled: true, versionId: version.$id });
      }
      await c.env.BUCKET.delete(reservation.stagingKey).catch(() => undefined);
      await invalidatePackage(c.env.KV, pkg.normalizedName).catch(() => undefined);
      return c.json({
        name: pkg.name,
        version: version.version,
        integrity: version.integrity,
        shasum: version.shasum,
        tarballSize: version.tarballSize,
        tag: version.tag,
        latest: pkg.latestVersion === version.version,
        status: 'published',
      });
    }
    if (!['uploaded', 'scanning', 'failed'].includes(reservation.status)) {
      throw badRequest('Tarball has not been uploaded yet.');
    }
    const stored = await c.env.BUCKET.head(reservation.stagingKey);
    if (!stored) {
      throw new LemonizeError(422, ErrorCodes.ARTIFACT_MISSING, 'Uploaded artifact not found.');
    }
    if (stored.size !== version.tarballSize) {
      await c.env.BUCKET.delete(reservation.stagingKey);
      await repo.versions.update(version.$id, {
        status: 'rejected',
        scanError: 'tarball_size_mismatch',
      });
      await repo.reservations.update(reservation.$id, { status: 'rejected' });
      throw new LemonizeError(
        422,
        ErrorCodes.INTEGRITY_MISMATCH,
        'Stored size does not match declaration.',
      );
    }

    let job = await repo.getScanJobByVersionId(version.$id);
    let created = false;
    if (!job) {
      const jobId = crypto.randomUUID();
      try {
        job = await repo.scanJobs.create(
          {
            versionId: version.$id,
            status: 'pending',
            attempts: 0,
            lastError: null,
            nextAttemptAt: new Date().toISOString(),
            result: null,
          },
          jobId,
        );
        created = true;
      } catch (error) {
        if (!(error instanceof AppwriteError) || error.status !== 409) throw error;
        job = await repo.getScanJobByVersionId(version.$id);
        if (!job) throw error;
      }
    }
    if (job.status === 'failed' && job.attempts >= 3) {
      throw conflict(
        ErrorCodes.CONFLICT,
        'Artifact scanning retry budget is exhausted; an administrator must reset this publish.',
      );
    }
    await repo.versions.update(version.$id, { status: 'scanning', scanError: null });
    await repo.reservations.update(reservation.$id, { status: 'scanning' });
    if (created || ['pending', 'retry', 'failed'].includes(job.status)) {
      let accepted = false;
      try {
        await repo.scanJobs.update(job.$id, {
          status: 'dispatching',
          attempts: job.attempts + 1,
          nextAttemptAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        });
        await dispatchScanner(c.env, await scanPayload(job.$id, version, pkg));
        accepted = true;
        const current = await repo.scanJobs.getOrNull(job.$id);
        if (current?.status === 'dispatching') {
          await repo.scanJobs.update(job.$id, {
            status: 'queued',
            nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            lastError: null,
          });
        }
      } catch {
        if (!accepted) {
          const attempts = Math.max(1, job.attempts + 1);
          const terminal = attempts >= 3;
          await repo.failScanJob(
            job.$id,
            attempts,
            'scanner_dispatch_failed',
            terminal ? null : new Date(Date.now() + 60_000).toISOString(),
          );
          if (terminal) {
            await repo.versions.update(version.$id, {
              status: 'failed',
              scanError: 'scanner_dispatch_failed',
            });
            await repo.reservations.update(reservation.$id, { status: 'failed' });
          }
        }
        // Once Appwrite accepted the execution, the scanner or scheduled
        // reconciler owns progress; do not overwrite a running/completed job.
      }
    }
    await appendAudit(c, repo, {
      action: 'version.scan_queued',
      resourceType: 'version',
      resourceId: version.$id,
      detail: `${pkg.name}@${version.version}`,
    }).catch(() => undefined);
    return c.json(
      {
        name: pkg.name,
        version: version.version,
        integrity: version.integrity,
        shasum: version.shasum,
        tarballSize: version.tarballSize,
        tag: version.tag,
        latest: false,
        status: 'scanning',
        scanJobId: job.$id,
      },
      202,
    );
  },
);

internalScan.get('/internal/v1/scan-jobs/:jobId/artifact', async (c) => {
  await verifyScannerSignature({
    secret: c.env.SCANNER_SHARED_SECRET,
    method: c.req.method,
    url: c.req.url,
    headers: c.req.raw.headers,
    body: EMPTY_BODY,
  });
  const repo = registryRepository(c.env);
  const job = await repo.scanJobs.getOrNull(c.req.param('jobId'));
  if (!job || !['queued', 'dispatching', 'running', 'retry'].includes(job.status)) {
    throw notFound(ErrorCodes.NOT_FOUND, 'Scan job was not found.');
  }
  const version = await repo.versions.getOrNull(job.versionId);
  if (!version || !['scanning', 'published'].includes(version.status) || !version.stagingKey) {
    throw notFound(ErrorCodes.ARTIFACT_MISSING, 'Staged artifact was not found.');
  }
  const object = await c.env.BUCKET.get(version.stagingKey);
  if (!object || object.size !== version.tarballSize) {
    throw notFound(ErrorCodes.ARTIFACT_MISSING, 'Staged artifact was not found.');
  }
  await repo.scanJobs.update(job.$id, {
    status: 'running',
    nextAttemptAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  return new Response(object.body, {
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(object.size),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});

internalScan.post('/internal/v1/scan-jobs/:jobId/result', async (c) => {
  const body = await readRequestBodyLimited(c.req.raw, SCAN_RESULT_LIMIT);
  await verifyScannerSignature({
    secret: c.env.SCANNER_SHARED_SECRET,
    method: c.req.method,
    url: c.req.url,
    headers: c.req.raw.headers,
    body,
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
  } catch {
    throw badRequest('Invalid scan result JSON.');
  }
  const result = scannerResult(decoded);
  if (result.jobId !== c.req.param('jobId')) throw badRequest('Scan job mismatch.');
  const repo = registryRepository(c.env);
  const job = await repo.scanJobs.getOrNull(result.jobId);
  if (!job || job.versionId !== result.versionId)
    throw notFound(ErrorCodes.NOT_FOUND, 'Scan job was not found.');
  const version = await repo.versions.getOrNull(job.versionId);
  if (!version) throw notFound(ErrorCodes.VERSION_NOT_FOUND, 'Version was not found.');
  const pkg = await repo.packages.getOrNull(version.packageId);
  if (!pkg) throw notFound(ErrorCodes.PACKAGE_NOT_FOUND, 'Package was not found.');
  const reservation = await repo.getReservation(version.packageId, version.version);

  if (
    !['dispatching', 'queued', 'running', 'retry', 'failed', 'completed', 'rejected'].includes(
      job.status,
    )
  ) {
    throw conflict(ErrorCodes.CONFLICT, 'Scan job is not awaiting a result.');
  }
  if (!['scanning', 'failed', 'published', 'rejected', 'yanked'].includes(version.status)) {
    throw conflict(ErrorCodes.CONFLICT, 'Version is not awaiting a scan result.');
  }

  if (version.status === 'yanked') return c.json({ ok: true, status: 'yanked' });
  if (version.status === 'rejected' || job.status === 'rejected') {
    if (result.status !== 'rejected' && version.scanError !== 'scanner_result_mismatch') {
      throw conflict(ErrorCodes.CONFLICT, 'Rejected scan jobs are terminal.');
    }
    if (reservation) await repo.reservations.update(reservation.$id, { status: 'rejected' });
    if (job.status !== 'rejected') {
      await repo.completeScanJob(
        job.$id,
        version.scanError === 'scanner_result_mismatch'
          ? { ...result, code: 'scanner_result_mismatch' }
          : result,
        'rejected',
      );
    }
    if (version.stagingKey) await c.env.BUCKET.delete(version.stagingKey).catch(() => undefined);
    return c.json({ ok: true, status: 'rejected' });
  }
  if (job.status === 'completed' && version.status !== 'published') {
    throw conflict(ErrorCodes.CONFLICT, 'Completed scan state is inconsistent.');
  }
  if (job.status === 'completed' && version.status === 'published') {
    return c.json({ ok: true, status: 'published' });
  }

  if (result.status === 'error') {
    if (version.status === 'published') return c.json({ ok: true, status: 'published' });
    if (job.status === 'completed') {
      throw conflict(ErrorCodes.CONFLICT, 'Completed scan jobs are terminal.');
    }
    const attempts = Math.max(job.attempts, 1);
    const terminal = attempts >= 3;
    const nextAttemptAt = terminal
      ? null
      : new Date(Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** (attempts - 1))).toISOString();
    await repo.failScanJob(job.$id, attempts, result.code, nextAttemptAt);
    await repo.versions.update(version.$id, {
      status: terminal ? 'failed' : 'scanning',
      scanError: result.code,
    });
    if (reservation) {
      await repo.reservations.update(reservation.$id, { status: terminal ? 'failed' : 'scanning' });
    }
    return c.json({ ok: true, status: nextAttemptAt ? 'retry' : 'failed' });
  }

  if (result.status === 'rejected') {
    if (version.status === 'published')
      throw conflict(ErrorCodes.CONFLICT, 'Published version cannot be rejected.');
    await repo.versions.update(version.$id, { status: 'rejected', scanError: result.code });
    if (reservation) await repo.reservations.update(reservation.$id, { status: 'rejected' });
    await repo.completeScanJob(job.$id, result, 'rejected');
    if (version.stagingKey) await c.env.BUCKET.delete(version.stagingKey).catch(() => undefined);
    return c.json({ ok: true, status: 'rejected' });
  }

  if (
    !timingSafeEqual(result.shasum!.toLowerCase(), version.shasum.toLowerCase()) ||
    !timingSafeEqual(result.integrity!, version.integrity) ||
    !timingSafeEqual(
      result.manifestSha256!.toLowerCase(),
      await declaredManifestSha256(version.manifest),
    ) ||
    result.fileCount !== version.fileCount ||
    result.unpackedSize !== version.unpackedSize
  ) {
    await repo.versions.update(version.$id, {
      status: 'rejected',
      scanError: 'scanner_result_mismatch',
    });
    if (reservation) await repo.reservations.update(reservation.$id, { status: 'rejected' });
    await repo.completeScanJob(job.$id, { ...result, code: 'scanner_result_mismatch' }, 'rejected');
    if (version.stagingKey) await c.env.BUCKET.delete(version.stagingKey).catch(() => undefined);
    throw new LemonizeError(
      422,
      ErrorCodes.INTEGRITY_MISMATCH,
      'Scanner result did not match the reservation.',
    );
  }

  if (!artifactPromotionEnabled(c.get('config'))) {
    c.header('retry-after', '600');
    return c.json({ ok: false, status: 'deferred' }, 503);
  }

  const artifactKey = `artifacts/${pkg.$id}/${version.$id}/${version.shasum}.tgz`;
  const existing = await c.env.BUCKET.head(artifactKey);
  if (!existing) {
    if (!version.stagingKey)
      throw notFound(ErrorCodes.ARTIFACT_MISSING, 'Staged artifact was not found.');
    const staged = await c.env.BUCKET.get(version.stagingKey);
    if (!staged || staged.size !== version.tarballSize) {
      throw notFound(ErrorCodes.ARTIFACT_MISSING, 'Staged artifact was not found.');
    }
    const promoted = await c.env.BUCKET.put(artifactKey, staged.body, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: {
        contentType: 'application/gzip',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        versionId: version.$id,
        shasum: version.shasum,
        integrity: version.integrity,
      },
    });
    if (!promoted) {
      const raced = await c.env.BUCKET.head(artifactKey);
      if (
        !raced ||
        raced.size !== version.tarballSize ||
        raced.customMetadata?.shasum !== version.shasum
      ) {
        throw conflict(ErrorCodes.CONFLICT, 'Artifact promotion conflicted.');
      }
    } else if (promoted.size !== version.tarballSize) {
      await c.env.BUCKET.delete(artifactKey);
      throw new LemonizeError(
        422,
        ErrorCodes.INTEGRITY_MISMATCH,
        'Promoted artifact size mismatch.',
      );
    }
  } else if (
    existing.size !== version.tarballSize ||
    existing.customMetadata?.shasum !== version.shasum
  ) {
    throw conflict(ErrorCodes.CONFLICT, 'Immutable artifact key is occupied by different content.');
  }

  await repo.versions.update(version.$id, {
    status: 'published',
    artifactKey,
    archiveFileId: result.quarantineFileId!,
    computedShasum: result.shasum!.toLowerCase(),
    scanError: null,
    publishedAt: version.publishedAt ?? result.scannedAt,
  });
  if (version.tag !== 'latest') {
    await repo.setTag({ packageId: pkg.$id, tag: version.tag, version: version.version });
  }
  await refreshPackageMetadata(repo, pkg, version);
  c.executionCtx.waitUntil(
    c.env.KV
      .put(kvKeys.publicVersion(pkg.normalizedName, version.version), '1', {
        expirationTtl: 60,
      })
      .catch(() => undefined),
  );
  if (reservation) await repo.reservations.update(reservation.$id, { status: 'completed' });
  await repo.completeScanJob(job.$id, result);
  if (version.stagingKey) await c.env.BUCKET.delete(version.stagingKey).catch(() => undefined);
  await invalidatePackage(c.env.KV, pkg.normalizedName).catch(() => undefined);
  await repo
    .appendAudit({
      actorId: version.publishedBy,
      action: 'version.publish',
      resourceType: 'version',
      resourceId: version.$id,
      detail: `${pkg.name}@${version.version}`,
      requestId: c.get('requestId'),
      ipHash: null,
    })
    .catch(() => undefined);
  return c.json({ ok: true, status: 'published', name: pkg.name, version: version.version });
});

export type { ScanJobPayload, ScannerResult };
