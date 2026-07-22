import type {
  AppwriteRow,
  ReservationData,
  ScanJobData,
  VersionData,
} from './appwrite-types.js';
import type { RegistryAppwriteRepository } from './appwrite-repository.js';

interface RejectInvalidStagedManifestInput {
  bucket: Pick<R2Bucket, 'delete'>;
  repo: RegistryAppwriteRepository;
  job: AppwriteRow<ScanJobData>;
  version: AppwriteRow<VersionData>;
  reservation: AppwriteRow<ReservationData> | null;
}

export type InvalidManifestRejectionOperation =
  'reservation' | 'version' | 'scan_job' | 'staging_delete';

export interface InvalidManifestRejectionResult {
  complete: boolean;
  failedOperations: InvalidManifestRejectionOperation[];
  stagingDeleted: boolean;
}

/**
 * Makes a manifest failure terminal without turning a partial provider outage
 * into an untracked state. Dependent transitions stop when their cleanup or
 * retry prerequisite did not persist, while staging deletion is always tried.
 */
export async function rejectInvalidStagedManifest(
  input: RejectInvalidStagedManifestInput,
): Promise<InvalidManifestRejectionResult> {
  const failedOperations: InvalidManifestRejectionOperation[] = [];
  const update = async (
    label: InvalidManifestRejectionOperation,
    operation: () => Promise<unknown>,
  ): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch {
      failedOperations.push(label);
      return false;
    }
  };

  // A rejected reservation guarantees that cleanup can reclaim retained bytes.
  // If it cannot be written, leave the version and job retryable.
  let reservationRejected = input.reservation === null;
  if (input.reservation) {
    reservationRejected = await update('reservation', () =>
      input.repo.reservations.update(input.reservation!.$id, { status: 'rejected' }),
    );
  }

  let versionRejected = false;
  if (reservationRejected) {
    versionRejected = await update('version', () =>
      input.repo.versions.update(input.version.$id, {
        status: 'rejected',
        scanError: 'invalid_manifest',
      }),
    );
  }

  const stagingKey = input.version.stagingKey ?? input.reservation?.stagingKey;
  let stagingDeleted = stagingKey === undefined || stagingKey === null;
  if (stagingKey) {
    stagingDeleted = await update('staging_delete', () => input.bucket.delete(stagingKey));
  }

  // With a reservation, its rejected state gives cleanup a retry path. Without
  // one, do not terminally close the job until the only tracked staging key is gone.
  if (versionRejected && (input.reservation !== null || stagingDeleted)) {
    await update('scan_job', () =>
      input.repo.completeScanJob(
        input.job.$id,
        { status: 'rejected', code: 'invalid_manifest', versionId: input.version.$id },
        'rejected',
      ),
    );
  }

  return {
    complete: failedOperations.length === 0,
    failedOperations,
    stagingDeleted,
  };
}
