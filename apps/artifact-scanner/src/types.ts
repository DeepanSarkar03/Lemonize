export interface ScanJob {
  schemaVersion: 1;
  jobId: string;
  versionId: string;
  packageName: string;
  version: string;
  /** Expected SHA-256 digest as 64 lowercase/uppercase hexadecimal characters. */
  shasum: string;
  /** Expected Subresource Integrity value (`sha512-<base64>`). */
  integrity: string;
  /** SHA-256 of the canonical client-declared package manifest. */
  manifestSha256: string;
  tarballSize: number;
  fileCount: number;
  unpackedSize: number;
}

export interface ArchiveValidation {
  fileCount: number;
  unpackedSize: number;
  manifest: Record<string, unknown>;
}

export type ScanResultStatus = 'clean' | 'rejected' | 'error';

export interface ScanResult {
  schemaVersion: 1;
  jobId: string;
  versionId: string;
  status: ScanResultStatus;
  code: string;
  scannedAt: string;
  shasum?: string;
  integrity?: string;
  manifestSha256?: string;
  fileCount?: number;
  unpackedSize?: number;
  quarantineFileId?: string;
}

export type ScannerFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ScannerConfig {
  registryInternalUrl: string;
  signingSecret: string;
  appwriteEndpoint: string;
  appwriteProjectId: string;
  appwriteApiKey: string;
  quarantineBucketId: string;
  maxArchiveBytes: number;
  maxPackageFiles: number;
  maxClockSkewSeconds: number;
  fetch: ScannerFetch;
  now: () => Date;
}
