import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@lemonize/shared';
import type { AppBindings, Env } from '../src/lib/env.js';
import { loadConfig } from '../src/lib/env.js';
import { canonicalStoredManifest } from '../src/lib/manifest-json.js';
import { handleError } from '../src/lib/errors.js';
import { scannerSignedHeaders } from '../src/lib/publish-security.js';

const mocks = vi.hoisted(() => ({
  repo: {} as Record<string, unknown>,
  refreshPublisher: vi.fn(),
}));

vi.mock('../src/lib/registry.js', () => ({
  registryRepository: () => mocks.repo,
}));

vi.mock('../src/lib/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/auth.js')>();
  return {
    ...original,
    refreshClerkUserForAuthorization: mocks.refreshPublisher,
  };
});

const { internalScan } = await import('../src/routes/publish.js');

const metadata = (tableId: string, id: string) => ({
  $id: id,
  $sequence: 1,
  $databaseId: 'registry',
  $tableId: tableId,
  $createdAt: '2026-07-27T00:00:00.000Z',
  $updatedAt: '2026-07-27T00:00:00.000Z',
  $permissions: [],
});

const scannerSecret = '0123456789abcdef0123456789abcdef';

function testEnv(bucket: Partial<R2Bucket>, kv: Partial<KVNamespace> = {}): Env {
  return {
    ALLOW_PUBLIC_PUBLISH: 'true',
    ALLOW_PRIVATE_PACKAGES: 'false',
    MAX_TARBALL_SIZE_BYTES: '10485760',
    MAX_UNPACKED_SIZE_BYTES: '104857600',
    MAX_PACKAGE_FILES: '2000',
    MAX_GLOBAL_ARTIFACT_BYTES: '1073741824',
    RATE_LIMIT_READS_PER_MINUTE: '600',
    RATE_LIMIT_WRITES_PER_MINUTE: '60',
    REGISTRY_BASE_URL: 'https://registry.test',
    WEB_BASE_URL: 'https://web.test',
    CORS_ALLOWED_ORIGINS: 'https://web.test',
    REGISTRY_MODE: 'public',
    ADMIN_CLERK_IDS: '',
    PACKAGE_SCOPE_GRANTS_JSON: '[]',
    APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io/v1',
    APPWRITE_PROJECT_ID: 'test-project',
    APPWRITE_DATABASE_ID: 'registry',
    APPWRITE_API_KEY: 'test-key',
    APPWRITE_QUARANTINE_BUCKET_ID: 'quarantine',
    APPWRITE_SCANNER_FUNCTION_ID: 'artifact-scanner',
    CLERK_ISSUER: 'https://clerk.test',
    CLERK_AUTHORIZED_PARTIES: 'https://web.test',
    CLERK_SECRET_KEY: 'test-clerk-key',
    SCANNER_SHARED_SECRET: scannerSecret,
    BUCKET: bucket as R2Bucket,
    KV: kv as KVNamespace,
    DEVICE_APPROVALS: {} as DurableObjectNamespace,
    RATE_LIMITS: {} as DurableObjectNamespace,
  };
}

describe('scanner promotion authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks a revoked grant and promotes only after current authorization passes', async () => {
    const manifest = JSON.stringify({ name: '@stape-ai/demo', version: '1.0.0' });
    const manifestSha256 = await sha256Hex(
      new TextEncoder().encode(canonicalStoredManifest(JSON.parse(manifest))),
    );
    const integrity = `sha512-${btoa('\0'.repeat(64))}`;
    const job = {
      ...metadata('scan_jobs', 'job-1'),
      versionId: 'version-1',
      status: 'running',
      attempts: 1,
    };
    const version = {
      ...metadata('versions', 'version-1'),
      packageId: 'package-1',
      version: '1.0.0',
      status: 'scanning',
      stagingKey: 'staging/reservation-1/file.tgz',
      integrity,
      shasum: 'a'.repeat(64),
      tarballSize: 128,
      unpackedSize: 256,
      fileCount: 2,
      manifest,
      tag: 'latest',
      publishedBy: 'user-1',
    };
    const pkg = {
      ...metadata('packages', 'package-1'),
      name: '@stape-ai/demo',
      normalizedName: '@stape-ai/demo',
      scope: 'stape-ai',
      ownerId: 'user-1',
      status: 'active',
      storageBytes: 0,
      publishedVersionCount: 0,
    };
    const publisher = {
      ...metadata('users', 'user-1'),
      clerkId: 'clerk-1',
      email: 'publisher@example.test',
      githubUsername: 'publisher',
      githubId: 'github-42',
      namespace: 'publisher',
      status: 'active',
      role: 'publisher',
      storageBytes: 0,
      packageCount: 1,
      acceptedTermsVersion: '2026-07-17',
    };
    const updateVersion = vi.fn();
    const completeScanJob = vi.fn();
    mocks.repo = {
      scanJobs: { getOrNull: vi.fn().mockResolvedValue(job) },
      versions: { getOrNull: vi.fn().mockResolvedValue(version), update: updateVersion },
      packages: { getOrNull: vi.fn().mockResolvedValue(pkg) },
      users: { getOrNull: vi.fn().mockResolvedValue(publisher) },
      getReservation: vi.fn().mockResolvedValue(null),
      completeScanJob,
      getUserByNamespace: vi.fn(),
      getForeignPackageOwner: vi.fn(),
    };
    mocks.refreshPublisher.mockResolvedValue(publisher);
    const head = vi.fn();
    const put = vi.fn();
    const env = testEnv({ head, put });
    const app = new Hono<AppBindings>();
    app.use('*', async (c, next) => {
      c.set('requestId', 'request-1');
      c.set('config', loadConfig(c.env));
      await next();
    });
    app.route('/', internalScan);
    app.onError((error, c) => handleError(error, c));

    const result = {
      schemaVersion: 1,
      jobId: job.$id,
      versionId: version.$id,
      status: 'clean',
      code: 'scan_passed',
      scannedAt: '2026-07-27T00:01:00.000Z',
      shasum: version.shasum,
      integrity,
      manifestSha256,
      fileCount: version.fileCount,
      unpackedSize: version.unpackedSize,
      quarantineFileId: 'quarantine-1',
    };
    const body = new TextEncoder().encode(JSON.stringify(result));
    const url = `https://registry.test/internal/v1/scan-jobs/${job.$id}/result`;
    const headers = await scannerSignedHeaders({
      secret: scannerSecret,
      method: 'POST',
      url,
      body,
    });
    const response = await app.request(
      url,
      { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body },
      env,
    );

    expect(response.status).toBe(403);
    expect(mocks.refreshPublisher).toHaveBeenCalledWith(expect.anything(), publisher.clerkId);
    expect(head).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(updateVersion).not.toHaveBeenCalledWith(
      version.$id,
      expect.objectContaining({ status: 'published' }),
    );
    expect(completeScanJob).not.toHaveBeenCalled();

    env.PACKAGE_SCOPE_GRANTS_JSON = JSON.stringify([
      { scope: 'stape-ai', githubId: publisher.githubId },
    ]);
    const artifactKey = `artifacts/${pkg.$id}/${version.$id}/${version.shasum}.tgz`;
    const stagedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(version.tarballSize));
        controller.close();
      },
    });
    const get = vi.fn().mockResolvedValue({ size: version.tarballSize, body: stagedBody });
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    head.mockResolvedValue(null);
    put.mockResolvedValue({ size: version.tarballSize });
    Object.assign(env.BUCKET, { get, delete: deleteObject });
    const publishedVersion = { ...version, status: 'published', artifactKey };
    updateVersion.mockResolvedValue(publishedVersion);
    const updatePackage = vi.fn().mockResolvedValue({ ...pkg, latestVersion: version.version });
    Object.assign(mocks.repo, {
      versions: { getOrNull: vi.fn().mockResolvedValue(version), update: updateVersion },
      packages: {
        getOrNull: vi.fn().mockResolvedValue(pkg),
        update: updatePackage,
      },
      getUserByNamespace: vi.fn().mockResolvedValue(null),
      getForeignPackageOwner: vi.fn().mockResolvedValue(null),
      listVersions: vi.fn().mockResolvedValue({ total: 1, rows: [publishedVersion] }),
      getTag: vi.fn().mockResolvedValue(null),
      setTag: vi.fn().mockResolvedValue({}),
      appendAudit: vi.fn().mockResolvedValue({}),
    });
    Object.assign(env.KV, {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    });
    const executionContext = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const allowed = await app.fetch(
      new Request(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
      }),
      env,
      executionContext,
    );

    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ ok: true, status: 'published' });
    expect(mocks.repo.getForeignPackageOwner).toHaveBeenCalledWith(pkg.scope, publisher.$id);
    expect(get).toHaveBeenCalledWith(version.stagingKey);
    expect(put).toHaveBeenCalledWith(
      artifactKey,
      stagedBody,
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: '*' } }),
    );
    expect(updateVersion).toHaveBeenCalledWith(
      version.$id,
      expect.objectContaining({ status: 'published', artifactKey }),
    );
    expect(completeScanJob).toHaveBeenCalledWith(job.$id, result);
  });
});
