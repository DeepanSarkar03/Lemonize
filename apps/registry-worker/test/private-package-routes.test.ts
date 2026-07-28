import { Hono, type Context, type Next } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LemonizeError, ErrorCodes, sha256Hex } from '@lemonize/shared';
import type { AppBindings, Env } from '../src/lib/env.js';
import { loadConfig } from '../src/lib/env.js';
import { handleError } from '../src/lib/errors.js';
import { canonicalStoredManifest } from '../src/lib/manifest-json.js';
import { scannerSignedHeaders } from '../src/lib/publish-security.js';

const mocks = vi.hoisted(() => ({
  repo: {} as Record<string, unknown>,
  refreshPublisher: vi.fn(),
  defaultCache: vi.fn(),
  identity: {
    authenticated: true,
    userId: 'owner-1',
    clerkId: 'user_owner',
    namespace: 'owner',
  },
}));

vi.mock('../src/lib/registry.js', () => ({ registryRepository: () => mocks.repo }));
vi.mock('../src/lib/appwrite-repository.js', () => ({
  registryAppwriteRepository: () => mocks.repo,
}));
vi.mock('../src/lib/ratelimit.js', () => ({ rateLimit: vi.fn() }));
vi.mock('../src/lib/http-cache.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/http-cache.js')>();
  return { ...original, defaultCache: mocks.defaultCache };
});
vi.mock('../src/lib/auth.js', () => {
  const authenticate = async (c: Context<AppBindings>) => {
    if (!mocks.identity.authenticated) return false;
    c.set('userId', mocks.identity.userId);
    c.set('clerkId', mocks.identity.clerkId);
    c.set('namespace', mocks.identity.namespace);
    c.set('authorizedPackageScopes', [mocks.identity.namespace]);
    c.set('role', 'publisher');
    c.set('acceptedTermsVersion', '2026-07-17');
    c.set('authType', 'clerk');
    c.set('tokenScopes', ['read', 'publish', 'manage:packages', 'manage:tokens']);
    return true;
  };
  return {
    authenticate,
    hasScope: (_c: Context<AppBindings>, _scope: string) => true,
    requireAuth: async (c: Context<AppBindings>, next: Next) => {
      if (!(await authenticate(c)))
        throw new LemonizeError(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
      await next();
    },
    requirePublisher: async (_c: Context<AppBindings>, next: Next) => next(),
    refreshClerkUserForAuthorization: mocks.refreshPublisher,
  };
});

const [{ packages }, { tarball }, { publish, internalScan }] = await Promise.all([
  import('../src/routes/packages.js'),
  import('../src/routes/tarball.js'),
  import('../src/routes/publish.js'),
]);

const system = (tableId: string, id: string) => ({
  $id: id,
  $sequence: 1,
  $databaseId: 'registry',
  $tableId: tableId,
  $createdAt: '2026-07-28T00:00:00.000Z',
  $updatedAt: '2026-07-28T00:00:00.000Z',
  $permissions: [],
});

const pkg = {
  ...system('packages', 'package-1'),
  name: '@owner/private',
  normalizedName: '@owner/private',
  scope: 'owner',
  ownerId: 'owner-1',
  visibility: 'private' as const,
  status: 'active',
  latestVersion: '1.0.0',
  storageBytes: 128,
  publishedVersionCount: 1,
};
const integrity = `sha512-${btoa('\0'.repeat(64))}`;
const version = {
  ...system('versions', 'version-1'),
  packageId: pkg.$id,
  version: '1.0.0',
  status: 'published',
  artifactKey: 'artifacts/package-1/version-1/file.tgz',
  integrity,
  shasum: 'a'.repeat(64),
  computedShasum: 'a'.repeat(64),
  tarballSize: 128,
  unpackedSize: 256,
  fileCount: 2,
  manifest: JSON.stringify({ name: pkg.name, version: '1.0.0' }),
  tag: 'latest',
  publishedBy: 'owner-1',
  publishedAt: '2026-07-28T00:00:00.000Z',
};
const owner = {
  ...system('users', 'owner-1'),
  clerkId: 'user_owner',
  email: 'owner@example.test',
  githubUsername: null,
  githubId: null,
  namespace: 'owner',
  status: 'active',
  role: 'publisher',
  storageBytes: 128,
  packageCount: 1,
  acceptedTermsVersion: '2026-07-17',
};

function kv() {
  const values = new Map<string, string>();
  return {
    values,
    binding: {
      get: vi.fn(async (key: string, type?: string) => {
        const value = values.get(key) ?? null;
        return type === 'json' && value !== null ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => void values.set(key, value)),
      delete: vi.fn(async (key: string) => void values.delete(key)),
    } as unknown as KVNamespace,
  };
}

function testEnv(kvBinding: KVNamespace, bucket: Partial<R2Bucket> = {}): Env {
  return {
    ALLOW_PUBLIC_PUBLISH: 'true',
    ALLOW_PRIVATE_PACKAGES: 'true',
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
    APPWRITE_PROJECT_ID: 'test',
    APPWRITE_DATABASE_ID: 'registry',
    APPWRITE_API_KEY: 'test',
    APPWRITE_QUARANTINE_BUCKET_ID: 'quarantine',
    APPWRITE_SCANNER_FUNCTION_ID: 'scanner',
    CLERK_ISSUER: 'https://clerk.test',
    CLERK_AUTHORIZED_PARTIES: 'https://web.test',
    CLERK_PRIVATE_PACKAGES_FEATURE: 'private-packages',
    CLERK_SECRET_KEY: 'test-secret',
    SCANNER_SHARED_SECRET: '0123456789abcdef0123456789abcdef',
    KV: kvBinding,
    BUCKET: bucket as R2Bucket,
    DEVICE_APPROVALS: {} as DurableObjectNamespace,
    RATE_LIMITS: {} as DurableObjectNamespace,
  };
}

function app() {
  const result = new Hono<AppBindings>();
  result.use('*', async (c, next) => {
    c.set('requestId', 'request-1');
    c.set('config', loadConfig(c.env));
    await next();
  });
  result.route('/', internalScan);
  result.route('/v1', publish);
  result.route('/v1', tarball);
  result.route('/v1', packages);
  result.onError((error, c) => handleError(error, c));
  return result;
}

const ctx = () =>
  ({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  }) as unknown as ExecutionContext;
const paidSubscription = (payer = 'user_owner') => ({
  status: 'active',
  payer_id: payer,
  subscription_items: [
    {
      status: 'active',
      plan_period: 'month',
      payer_id: payer,
      is_free_trial: false,
      plan: {
        is_default: false,
        is_recurring: true,
        has_base_fee: true,
        fee: { amount: 900 },
        features: [{ slug: 'private-packages' }],
      },
    },
  ],
});

describe('paid private package routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.identity, {
      authenticated: true,
      userId: 'owner-1',
      clerkId: 'user_owner',
      namespace: 'owner',
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects unpaid private create, reserve, and finalize before mutation', async () => {
    const store = kv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    mocks.repo = {
      getReservationByUploadTokenHash: vi.fn().mockResolvedValue({
        ...system('reservations', 'reservation-1'),
        packageId: pkg.$id,
        version: version.version,
        userId: owner.$id,
        stagingKey: 'staging/file.tgz',
        status: 'uploaded',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      packages: { getOrNull: vi.fn().mockResolvedValue(pkg) },
    };
    const worker = app();
    const create = await worker.request(
      'https://registry.test/v1/packages',
      {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ name: '@owner/new', visibility: 'private' }),
      },
      testEnv(store.binding),
    );
    const reserve = await worker.request(
      'https://registry.test/v1/packages/%40owner%2Fprivate/versions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: { name: pkg.name, version: '2.0.0' },
          integrity,
          shasum: 'b'.repeat(64),
          tarballSize: 128,
          unpackedSize: 256,
          fileCount: 2,
          access: 'private',
        }),
      },
      testEnv(store.binding),
    );
    const finalize = await worker.request(
      'https://registry.test/v1/packages/%40owner%2Fprivate/versions/1.0.0/finalize',
      {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'x-lemonize-upload-token': 'upload-token' },
      },
      testEnv(store.binding),
    );
    expect([create.status, reserve.status, finalize.status]).toEqual([402, 402, 402]);
  });

  it('serves a paid owner privately without using metadata or edge response caches', async () => {
    const store = kv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(paidSubscription())),
    );
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(128));
        controller.close();
      },
    });
    const bucketGet = vi.fn().mockResolvedValue({ size: 128, body });
    mocks.repo = {
      getPackageByNormalizedName: vi.fn().mockResolvedValue(pkg),
      listVersions: vi.fn().mockResolvedValue({ total: 1, rows: [version] }),
      listTags: vi.fn().mockResolvedValue({ total: 0, rows: [] }),
      users: { getOrNull: vi.fn().mockResolvedValue(owner) },
    };
    const env = testEnv(store.binding, { get: bucketGet });
    const worker = app();
    const metadata = await worker.fetch(
      new Request('https://registry.test/v1/packages/%40owner%2Fprivate', {
        headers: { authorization: 'Bearer token' },
      }),
      env,
      ctx(),
    );
    const artifact = await worker.fetch(
      new Request('https://registry.test/v1/packages/%40owner%2Fprivate/versions/1.0.0/tarball', {
        headers: { authorization: 'Bearer token' },
      }),
      env,
      ctx(),
    );
    for (const response of [metadata, artifact]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toContain('Authorization');
      expect(response.headers.get('x-lemonize-cache')).toBe('BYPASS');
    }
    expect(mocks.defaultCache).not.toHaveBeenCalled();
    expect([...store.values.keys()].some((key) => key.startsWith('pkg:'))).toBe(false);
  });

  it('hides private reads from non-owners and prompts a lapsed owner to renew', async () => {
    const store = kv();
    mocks.repo = { getPackageByNormalizedName: vi.fn().mockResolvedValue(pkg) };
    Object.assign(mocks.identity, {
      userId: 'stranger-1',
      clerkId: 'user_stranger',
      namespace: 'stranger',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(paidSubscription('user_stranger'))),
    );
    const hidden = await app().request(
      'https://registry.test/v1/packages/%40owner%2Fprivate',
      { headers: { authorization: 'Bearer token' } },
      testEnv(store.binding),
    );
    expect(hidden.status).toBe(404);
    expect((await hidden.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'PACKAGE_NOT_FOUND' },
    });
    expect(hidden.headers.get('cache-control')).toBe('private, no-store');
    expect(hidden.headers.get('vary')).toContain('Authorization');
    expect(hidden.headers.get('x-lemonize-cache')).toBe('BYPASS');
    Object.assign(mocks.identity, { userId: 'owner-1', clerkId: 'user_owner', namespace: 'owner' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const renewal = await app().request(
      'https://registry.test/v1/packages/%40owner%2Fprivate',
      { headers: { authorization: 'Bearer token' } },
      testEnv(kv().binding),
    );
    expect(renewal.status).toBe(402);
    expect(renewal.headers.get('cache-control')).toBe('private, no-store');
    expect(renewal.headers.get('vary')).toContain('Authorization');
    expect(mocks.defaultCache).not.toHaveBeenCalled();
    expect([...store.values.keys()].some((key) => key.startsWith('pkg:'))).toBe(false);
  });

  it('prevents promotion when private entitlement is lost before the scanner result', async () => {
    const store = kv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const scanning = { ...version, status: 'scanning', stagingKey: 'staging/file.tgz' };
    const job = {
      ...system('scan_jobs', 'job-1'),
      versionId: version.$id,
      status: 'running',
      attempts: 1,
    };
    mocks.repo = {
      scanJobs: { getOrNull: vi.fn().mockResolvedValue(job) },
      versions: { getOrNull: vi.fn().mockResolvedValue(scanning), update: vi.fn() },
      packages: { getOrNull: vi.fn().mockResolvedValue(pkg) },
      users: { getOrNull: vi.fn().mockResolvedValue(owner) },
      getReservation: vi.fn().mockResolvedValue(null),
      getUserByNamespace: vi.fn().mockResolvedValue(owner),
      getForeignPackageOwner: vi.fn().mockResolvedValue(null),
    };
    mocks.refreshPublisher.mockResolvedValue(owner);
    const manifestSha256 = await sha256Hex(
      new TextEncoder().encode(canonicalStoredManifest(JSON.parse(version.manifest))),
    );
    const result = {
      schemaVersion: 1,
      jobId: job.$id,
      versionId: version.$id,
      status: 'clean',
      code: 'scan_passed',
      scannedAt: '2026-07-28T00:01:00.000Z',
      shasum: version.shasum,
      integrity,
      manifestSha256,
      fileCount: version.fileCount,
      unpackedSize: version.unpackedSize,
      quarantineFileId: 'quarantine-1',
    };
    const bytes = new TextEncoder().encode(JSON.stringify(result));
    const url = `https://registry.test/internal/v1/scan-jobs/${job.$id}/result`;
    const headers = await scannerSignedHeaders({
      secret: '0123456789abcdef0123456789abcdef',
      method: 'POST',
      url,
      body: bytes,
    });
    const bucket = { head: vi.fn(), get: vi.fn(), put: vi.fn() };
    const response = await app().request(
      url,
      { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: bytes },
      testEnv(store.binding, bucket),
    );
    expect(response.status).toBe(402);
    expect(bucket.head).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(mocks.repo.versions.update).not.toHaveBeenCalled();
  });
});
