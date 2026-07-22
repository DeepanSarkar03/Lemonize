import { describe, expect, it, vi } from 'vitest';
import type {
  AppwriteRow,
  ReservationData,
  ScanJobData,
  VersionData,
} from '../src/lib/appwrite-types.js';
import type { RegistryAppwriteRepository } from '../src/lib/appwrite-repository.js';
import { rejectInvalidStagedManifest } from '../src/lib/staging-lifecycle.js';

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

describe('terminal staging rejection', () => {
  it('marks every state rejected and deletes bytes after canonicalization failure', async () => {
    const version = row<VersionData>('version-1', 'versions', {
      packageId: 'package-1',
      version: '1.0.0',
      status: 'scanning',
      stagingKey: 'staging/reservation-1/artifact.tgz',
      integrity: 'sha512-test',
      shasum: 'a'.repeat(64),
      tarballSize: 10,
      unpackedSize: 10,
      fileCount: 1,
      manifest: '{}',
      tag: 'latest',
      publishedBy: 'user-1',
    });
    const reservation = row<ReservationData>('reservation-1', 'reservations', {
      packageId: 'package-1',
      version: '1.0.0',
      userId: 'user-1',
      idempotencyKey: 'idempotency-1',
      uploadTokenHash: 'a'.repeat(64),
      stagingKey: version.stagingKey!,
      status: 'uploaded',
      expiresAt: timestamp,
    });
    const job = row<ScanJobData>('job-1', 'scan_jobs', {
      versionId: version.$id,
      status: 'pending',
      attempts: 0,
    });
    const updateVersion = vi.fn(async () => version);
    const updateReservation = vi.fn(async () => reservation);
    const completeScanJob = vi.fn(async () => job);
    const repo = {
      versions: { update: updateVersion },
      reservations: { update: updateReservation },
      completeScanJob,
    } as unknown as RegistryAppwriteRepository;
    const deleteObject = vi.fn(async () => undefined);

    await expect(
      rejectInvalidStagedManifest({
        bucket: { delete: deleteObject } as unknown as Pick<R2Bucket, 'delete'>,
        repo,
        job,
        version,
        reservation,
      }),
    ).resolves.toEqual({ complete: true, failedOperations: [], stagingDeleted: true });

    expect(updateVersion).toHaveBeenCalledWith(version.$id, {
      status: 'rejected',
      scanError: 'invalid_manifest',
    });
    expect(updateReservation).toHaveBeenCalledWith(reservation.$id, { status: 'rejected' });
    expect(completeScanJob).toHaveBeenCalledWith(
      job.$id,
      { status: 'rejected', code: 'invalid_manifest', versionId: version.$id },
      'rejected',
    );
    expect(deleteObject).toHaveBeenCalledWith(reservation.stagingKey);
    expect(updateReservation.mock.invocationCallOrder[0]).toBeLessThan(
      updateVersion.mock.invocationCallOrder[0]!,
    );
    expect(updateVersion.mock.invocationCallOrder[0]).toBeLessThan(
      completeScanJob.mock.invocationCallOrder[0]!,
    );
  });

  it('contains a reservation write failure and leaves dependent state retryable', async () => {
    const version = row<VersionData>('version-2', 'versions', {
      packageId: 'package-1',
      version: '1.0.1',
      status: 'scanning',
      stagingKey: 'staging/reservation-2/artifact.tgz',
      integrity: 'sha512-test',
      shasum: 'b'.repeat(64),
      tarballSize: 10,
      unpackedSize: 10,
      fileCount: 1,
      manifest: '{}',
      tag: 'latest',
      publishedBy: 'user-1',
    });
    const reservation = row<ReservationData>('reservation-2', 'reservations', {
      packageId: 'package-1',
      version: version.version,
      userId: 'user-1',
      idempotencyKey: 'idempotency-1',
      uploadTokenHash: 'b'.repeat(64),
      stagingKey: version.stagingKey!,
      status: 'scanning',
      expiresAt: timestamp,
    });
    const job = row<ScanJobData>('job-2', 'scan_jobs', {
      versionId: version.$id,
      status: 'retry',
      attempts: 1,
    });
    const updateVersion = vi.fn(async () => version);
    const updateReservation = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const completeScanJob = vi.fn(async () => job);
    const deleteObject = vi.fn(async () => undefined);
    const repo = {
      versions: { update: updateVersion },
      reservations: { update: updateReservation },
      completeScanJob,
    } as unknown as RegistryAppwriteRepository;

    await expect(
      rejectInvalidStagedManifest({
        bucket: { delete: deleteObject } as unknown as Pick<R2Bucket, 'delete'>,
        repo,
        job,
        version,
        reservation,
      }),
    ).resolves.toEqual({
      complete: false,
      failedOperations: ['reservation'],
      stagingDeleted: true,
    });
    expect(updateVersion).not.toHaveBeenCalled();
    expect(completeScanJob).not.toHaveBeenCalled();
    expect(deleteObject).toHaveBeenCalledWith(reservation.stagingKey);
  });

  it('keeps an orphaned job retryable when staging deletion fails', async () => {
    const version = row<VersionData>('version-3', 'versions', {
      packageId: 'package-1',
      version: '1.0.2',
      status: 'scanning',
      stagingKey: 'staging/reservation-3/artifact.tgz',
      integrity: 'sha512-test',
      shasum: 'c'.repeat(64),
      tarballSize: 10,
      unpackedSize: 10,
      fileCount: 1,
      manifest: '{}',
      tag: 'latest',
      publishedBy: 'user-1',
    });
    const job = row<ScanJobData>('job-3', 'scan_jobs', {
      versionId: version.$id,
      status: 'retry',
      attempts: 1,
    });
    const updateVersion = vi.fn(async () => version);
    const completeScanJob = vi.fn(async () => job);
    const repo = {
      versions: { update: updateVersion },
      reservations: { update: vi.fn() },
      completeScanJob,
    } as unknown as RegistryAppwriteRepository;

    await expect(
      rejectInvalidStagedManifest({
        bucket: {
          delete: vi.fn(async () => {
            throw new Error('r2 unavailable');
          }),
        } as unknown as Pick<R2Bucket, 'delete'>,
        repo,
        job,
        version,
        reservation: null,
      }),
    ).resolves.toEqual({
      complete: false,
      failedOperations: ['staging_delete'],
      stagingDeleted: false,
    });
    expect(updateVersion).toHaveBeenCalledWith(version.$id, {
      status: 'rejected',
      scanError: 'invalid_manifest',
    });
    expect(completeScanJob).not.toHaveBeenCalled();
  });
});
