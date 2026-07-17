import { describe, expect, it } from 'vitest';
import { AppwriteRestClient, type AppwriteFetch } from '../src/lib/appwrite.js';
import {
  RegistryAppwriteRepository,
  registryAppwriteRepository,
} from '../src/lib/appwrite-repository.js';
import { getPublicPackage, resolvePublicVersion } from '../src/lib/appwrite-public.js';
import { buildPackageMetadata } from '../src/lib/metadata.js';
import { hasSecurityBlockTombstone } from '../src/routes/tarball.js';
import type { AppwriteRow, PackageData, VersionData } from '../src/lib/appwrite-types.js';

const system = (tableId: string, id: string) => ({
  $id: id,
  $sequence: 1,
  $databaseId: 'registry',
  $tableId: tableId,
  $createdAt: '2026-07-01T00:00:00.000Z',
  $updatedAt: '2026-07-17T00:00:00.000Z',
  $permissions: [],
});

const pkg: AppwriteRow<PackageData> = {
  ...system('packages', 'pkg-1'),
  name: '@demo/pkg',
  normalizedName: '@demo/pkg',
  scope: '@demo',
  ownerId: 'owner-1',
  description: 'Demo package',
  readme: '# Demo',
  status: 'active',
  latestVersion: '1.2.0',
  storageBytes: 1234,
};

function version(
  id: string,
  value: string,
  status = 'published',
  extra: Partial<VersionData> = {},
): AppwriteRow<VersionData> {
  const manifest = JSON.stringify({
    name: '@demo/pkg',
    version: value,
    type: 'module',
    engines: { node: '>=20' },
    bin: { demo: 'bin/demo.js' },
  });
  return {
    ...system('versions', id),
    packageId: 'pkg-1',
    version: value,
    status,
    artifactKey: `packages/demo/pkg/${value}/package.tgz`,
    integrity: `sha512-${'a'.repeat(88)}`,
    shasum: 'b'.repeat(64),
    computedShasum: 'c'.repeat(64),
    tarballSize: 500,
    unpackedSize: 900,
    fileCount: 3,
    manifest,
    tag: 'latest',
    publishedBy: 'owner-1',
    publishedAt: '2026-07-10T00:00:00.000Z',
    ...extra,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function publicBackend(packageRow: AppwriteRow<PackageData> = pkg) {
  const urls: string[] = [];
  const rows = [
    version('ver-1', '1.0.0'),
    version('ver-2', '1.2.0'),
    version('ver-pending', '2.0.0', 'pending_scan'),
    version('ver-yanked', '0.9.0', 'published', {
      yankedAt: '2026-07-12T00:00:00.000Z',
    }),
    version('ver-blocked', '0.8.0', 'blocked'),
  ];
  const fetcher: AppwriteFetch = async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/tables/packages/rows')) {
      return json({ total: 1, rows: [packageRow] });
    }
    if (parsed.pathname.endsWith('/tables/versions/rows')) {
      return json({ total: rows.length, rows });
    }
    if (parsed.pathname.endsWith('/tables/dist_tags/rows')) {
      return json({
        total: 2,
        rows: [
          { ...system('dist_tags', 'tag-1'), packageId: 'pkg-1', tag: 'latest', version: '1.2.0' },
          { ...system('dist_tags', 'tag-2'), packageId: 'pkg-1', tag: 'stable', version: '1.0.0' },
        ],
      });
    }
    if (parsed.pathname.endsWith('/tables/users/rows/owner-1')) {
      return json({
        ...system('users', 'owner-1'),
        clerkId: 'user_123',
        email: 'owner@example.test',
        namespace: 'demo',
        status: 'active',
        role: 'publisher',
        storageBytes: 1234,
        packageCount: 1,
      });
    }
    return json({ type: 'row_not_found' }, 404);
  };
  return { fetcher, urls };
}

function repository(fetcher: AppwriteFetch): RegistryAppwriteRepository {
  return new RegistryAppwriteRepository(
    new AppwriteRestClient({
      endpoint: 'https://fra.cloud.appwrite.io/v1',
      projectId: 'lemonize-prod-2026',
      apiKey: 'test-key',
      fetch: fetcher,
    }),
  );
}

describe('Appwrite public registry reads', () => {
  it('lets a security-block tombstone override edge visibility state', async () => {
    const kv = {
      get: async (key: string) => (key === 'blocked:@demo/pkg:1.2.0' ? '1' : null),
    } as unknown as import('@cloudflare/workers-types').KVNamespace;
    await expect(hasSecurityBlockTombstone(kv, '@demo/pkg', '1.2.0')).resolves.toBe(true);
    await expect(hasSecurityBlockTombstone(kv, '@demo/pkg', '1.0.0')).resolves.toBe(false);
  });
  it('builds the existing package wire format from TablesDB rows', async () => {
    const backend = publicBackend();
    const metadata = await buildPackageMetadata(
      repository(backend.fetcher),
      pkg,
      'https://registry.example',
    );

    expect(metadata).toMatchObject({
      name: '@demo/pkg',
      normalizedName: '@demo/pkg',
      visibility: 'public',
      latest: '1.2.0',
      distTags: { latest: '1.2.0', stable: '1.0.0' },
      maintainers: ['demo'],
    });
    expect(Object.keys(metadata.versions)).toEqual(['1.0.0', '1.2.0']);
    expect(metadata.versions['1.2.0']).toMatchObject({
      shasum: 'c'.repeat(64),
      moduleType: 'module',
      engines: { node: '>=20' },
      bin: { demo: 'bin/demo.js' },
      tarball: 'https://registry.example/v1/packages/%40demo%2Fpkg/versions/1.2.0/tarball',
    });
    const listUrls = backend.urls.filter((url) => url.includes('/versions/') || url.includes('/dist_tags/'));
    expect(listUrls.every((url) => new URL(url).searchParams.getAll('queries[]').some((query) => query.includes('5000')))).toBe(true);
  });

  it('resolves tags and semver only against published, non-yanked versions', async () => {
    const backend = publicBackend();
    const repo = repository(backend.fetcher);

    await expect(resolvePublicVersion(repo, pkg, '@demo/pkg', 'latest')).resolves.toMatchObject({
      version: '1.2.0',
      artifactKey: 'packages/demo/pkg/1.2.0/package.tgz',
    });
    await expect(resolvePublicVersion(repo, pkg, '@demo/pkg', '^1.0.0')).resolves.toMatchObject({
      version: '1.2.0',
    });
    await expect(resolvePublicVersion(repo, pkg, '@demo/pkg', '2.0.0')).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND',
      status: 404,
    });
    await expect(resolvePublicVersion(repo, pkg, '@demo/pkg', '0.9.0')).resolves.toMatchObject({
      version: '0.9.0',
      yankedAt: '2026-07-12T00:00:00.000Z',
    });
    await expect(resolvePublicVersion(repo, pkg, '@demo/pkg', '0.8.0')).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND',
      status: 404,
    });
  });

  it('hides non-public package statuses with the existing not-found contract', async () => {
    const blocked = { ...pkg, status: 'blocked' };
    const backend = publicBackend(blocked);
    await expect(getPublicPackage(repository(backend.fetcher), '@demo/pkg')).rejects.toMatchObject({
      code: 'PACKAGE_NOT_FOUND',
      status: 404,
    });
  });

  it('constructs a repository from migration bindings without changing Env', async () => {
    const backend = publicBackend();
    const repo = registryAppwriteRepository(
      {
        APPWRITE_ENDPOINT: 'https://fra.cloud.appwrite.io/v1',
        APPWRITE_PROJECT_ID: 'lemonize-prod-2026',
        APPWRITE_DATABASE_ID: 'registry',
        APPWRITE_API_KEY: 'test-key',
      },
      backend.fetcher,
    );
    await expect(repo.getPackageByNormalizedName('@demo/pkg')).resolves.toMatchObject({
      name: '@demo/pkg',
    });
  });
});
