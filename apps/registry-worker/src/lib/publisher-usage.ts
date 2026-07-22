import { AppwriteQuery } from './appwrite.js';
import type { AppwriteRow, PackageData } from './appwrite-types.js';
import type { RegistryAppwriteRepository } from './appwrite-repository.js';
import { PUBLISH_QUOTAS } from './publish-security.js';

const LIVE_RESERVATION_STATUSES = new Set([
  'awaiting_upload',
  'uploading',
  'uploaded',
  'scanning',
]);

export interface PublisherQuotaUsage {
  packages: AppwriteRow<PackageData>[];
  liveReservations: number;
  publishedBytes: number;
  reservedBytes: number;
  storedAndReservedBytes: number;
}

export async function globalArtifactQuotaUsage(
  repo: RegistryAppwriteRepository,
): Promise<number> {
  const limit = 5_000;
  const [packages, reservations] = await Promise.all([
    repo.packages.list({ queries: [AppwriteQuery.limit(limit)], total: false }),
    repo.reservations.list({
      queries: [AppwriteQuery.orderDesc('$createdAt'), AppwriteQuery.limit(limit)],
      total: false,
    }),
  ]);
  // A truncated accounting scan could undercount and must fail closed.
  if (packages.rows.length >= limit || reservations.rows.length >= limit) {
    throw new Error('Global artifact accounting exceeded its safe scan limit.');
  }
  let total = packages.rows.reduce((sum, pkg) => {
    if (!Number.isSafeInteger(pkg.storageBytes) || pkg.storageBytes < 0) {
      throw new Error('Invalid package storage accounting.');
    }
    const next = sum + pkg.storageBytes;
    if (!Number.isSafeInteger(next)) throw new Error('Global artifact accounting overflowed.');
    return next;
  }, 0);
  // Reservation rows are removed only after R2 confirms staging deletion, so
  // every status remains byte-accounted while an object could still exist.
  const versions = await Promise.all(
    reservations.rows.map((reservation) =>
      repo.getVersion(reservation.packageId, reservation.version),
    ),
  );
  for (const version of versions) {
    if (!version) throw new Error('Reservation storage accounting is incomplete.');
    if (!Number.isSafeInteger(version.tarballSize) || version.tarballSize < 0) {
      throw new Error('Invalid reservation storage accounting.');
    }
    total += version.tarballSize;
    if (!Number.isSafeInteger(total)) throw new Error('Global artifact accounting overflowed.');
  }
  return total;
}

export async function publisherQuotaUsage(
  repo: RegistryAppwriteRepository,
  userId: string,
): Promise<PublisherQuotaUsage> {
  const reservationScanLimit =
    PUBLISH_QUOTAS.maxPackages * PUBLISH_QUOTAS.maxVersionsPerPackage + 1;
  const [packageList, reservationList] = await Promise.all([
    repo.listPackagesByOwner(userId, {
      queries: [AppwriteQuery.limit(PUBLISH_QUOTAS.maxPackages + 1)],
      total: false,
    }),
    repo.reservations.list({
      queries: [
        AppwriteQuery.equal('userId', userId),
        AppwriteQuery.orderDesc('$createdAt'),
        AppwriteQuery.limit(reservationScanLimit),
      ],
      total: false,
    }),
  ]);
  if (reservationList.rows.length >= reservationScanLimit) {
    throw new Error('Publisher reservation accounting exceeded its safe scan limit.');
  }
  const live = reservationList.rows.filter((reservation) =>
    LIVE_RESERVATION_STATUSES.has(reservation.status),
  );
  const versions = await Promise.all(
    reservationList.rows.map((reservation) =>
      repo.getVersion(reservation.packageId, reservation.version),
    ),
  );
  const publishedBytes = packageList.rows.reduce((total, pkg) => {
    if (!Number.isSafeInteger(pkg.storageBytes) || pkg.storageBytes < 0) {
      throw new Error('Invalid package storage accounting.');
    }
    const next = total + pkg.storageBytes;
    if (!Number.isSafeInteger(next)) throw new Error('Package storage accounting overflowed.');
    return next;
  }, 0);
  const reservedBytes = versions.reduce((total, version) => {
    if (!version) throw new Error('Reservation storage accounting is incomplete.');
    if (!Number.isSafeInteger(version.tarballSize) || version.tarballSize < 0) {
      throw new Error('Invalid reservation storage accounting.');
    }
    const next = total + version.tarballSize;
    if (!Number.isSafeInteger(next)) throw new Error('Reservation storage accounting overflowed.');
    return next;
  }, 0);
  const storedAndReservedBytes = publishedBytes + reservedBytes;
  if (!Number.isSafeInteger(storedAndReservedBytes)) {
    throw new Error('Publisher storage accounting overflowed.');
  }
  return {
    packages: packageList.rows,
    liveReservations: live.length,
    publishedBytes,
    reservedBytes,
    storedAndReservedBytes,
  };
}
