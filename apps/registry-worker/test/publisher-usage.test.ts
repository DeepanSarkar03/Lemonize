import { describe, expect, it, vi } from 'vitest';
import type {
  AppwriteRow,
  PackageData,
  ReservationData,
  VersionData,
} from '../src/lib/appwrite-types.js';
import type { RegistryAppwriteRepository } from '../src/lib/appwrite-repository.js';
import {
  globalArtifactQuotaUsage,
  publisherQuotaUsage,
} from '../src/lib/publisher-usage.js';

const timestamp = '2026-07-17T00:00:00.000Z';

function row<T extends object>(id: string, table: string, data: T): AppwriteRow<T> {
  return {
    ...data,
    $id: id,
    $sequence: 1,
    $databaseId: 'registry',
    $tableId: table,
    $createdAt: timestamp,
    $updatedAt: timestamp,
    $permissions: [],
  };
}

describe('publisher artifact accounting', () => {
  it('counts failed, expired, and completed staging reservations until row cleanup', async () => {
    const pkg = row<PackageData>('package-1', 'packages', {
      name: '@demo/pkg',
      normalizedName: '@demo/pkg',
      scope: 'demo',
      ownerId: 'user-1',
      status: 'active',
      storageBytes: 100,
    });
    const statuses = ['failed', 'expired', 'completed', 'uploading'] as const;
    const reservations = statuses.map((status, index) =>
      row<ReservationData>(`reservation-${index}`, 'reservations', {
        packageId: pkg.$id,
        version: `1.0.${index}`,
        userId: 'user-1',
        idempotencyKey: `idempotency-${index}`,
        uploadTokenHash: String(index).repeat(64),
        stagingKey: `staging/reservation-${index}/artifact.tgz`,
        status,
        expiresAt: timestamp,
      }),
    );
    const versions = new Map(
      reservations.map((reservation, index) => [
        reservation.version,
        row<VersionData>(`version-${index}`, 'versions', {
          packageId: pkg.$id,
          version: reservation.version,
          status: reservation.status,
          stagingKey: reservation.stagingKey,
          integrity: 'sha512-test',
          shasum: 'a'.repeat(64),
          tarballSize: (index + 1) * 10,
          unpackedSize: 1,
          fileCount: 1,
          manifest: '{}',
          tag: 'latest',
          publishedBy: 'user-1',
        }),
      ]),
    );
    const repo = {
      listPackagesByOwner: vi.fn(async () => ({ total: 1, rows: [pkg] })),
      packages: { list: vi.fn(async () => ({ total: 1, rows: [pkg] })) },
      reservations: {
        list: vi.fn(async () => ({ total: reservations.length, rows: reservations })),
      },
      getVersion: vi.fn(async (_packageId: string, version: string) => versions.get(version) ?? null),
    } as unknown as RegistryAppwriteRepository;

    await expect(globalArtifactQuotaUsage(repo)).resolves.toBe(200);
    await expect(publisherQuotaUsage(repo, 'user-1')).resolves.toMatchObject({
      liveReservations: 1,
      publishedBytes: 100,
      reservedBytes: 100,
      storedAndReservedBytes: 200,
    });
  });
});
