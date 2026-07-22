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

/** Makes a pre-dispatch manifest failure terminal while always attempting byte cleanup. */
export async function rejectInvalidStagedManifest(
  input: RejectInvalidStagedManifestInput,
): Promise<void> {
  let stateError: unknown;
  const update = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      stateError ??= error;
    }
  };

  await update(() =>
    input.repo.versions.update(input.version.$id, {
      status: 'rejected',
      scanError: 'invalid_manifest',
    }),
  );
  if (input.reservation) {
    await update(() =>
      input.repo.reservations.update(input.reservation!.$id, { status: 'rejected' }),
    );
  }
  await update(() =>
    input.repo.completeScanJob(
      input.job.$id,
      { status: 'rejected', code: 'invalid_manifest', versionId: input.version.$id },
      'rejected',
    ),
  );

  const stagingKey = input.version.stagingKey ?? input.reservation?.stagingKey;
  if (stagingKey) await input.bucket.delete(stagingKey).catch(() => undefined);
  if (stateError !== undefined) throw stateError;
}
