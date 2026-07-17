export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** System fields returned by the Appwrite TablesDB row endpoints. */
export interface AppwriteRowMetadata {
  $id: string;
  $sequence: number;
  $databaseId: string;
  $tableId: string;
  $createdAt: string;
  $updatedAt: string;
  $permissions: string[];
}

export type AppwriteRow<T extends object> = T & AppwriteRowMetadata;

export interface AppwriteRowList<T extends object> {
  total: number;
  rows: Array<AppwriteRow<T>>;
}

export interface UserData {
  clerkId: string;
  email: string;
  githubUsername?: string | null;
  /** Stable GitHub external account id supplied by Clerk. */
  githubId?: string | null;
  namespace: string;
  namespaceClaimedAt?: string | null;
  status: string;
  role: string;
  storageBytes: number;
  packageCount: number;
  acceptedTermsAt?: string | null;
  acceptedTermsVersion?: string | null;
  lastLoginAt?: string | null;
}

export interface ApiTokenData {
  userId: string;
  tokenHash: string;
  prefix: string;
  label: string;
  /** Comma-separated scopes, matching the provisioned TablesDB column. */
  scopes: string;
  expiresAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface PackageData {
  name: string;
  normalizedName: string;
  scope: string;
  ownerId: string;
  description?: string | null;
  readme?: string | null;
  status: string;
  latestVersion?: string | null;
  storageBytes: number;
  publishedVersionCount?: number;
}

export interface VersionData {
  packageId: string;
  version: string;
  status: string;
  stagingKey?: string | null;
  artifactKey?: string | null;
  archiveFileId?: string | null;
  integrity: string;
  shasum: string;
  computedShasum?: string | null;
  tarballSize: number;
  unpackedSize: number;
  fileCount: number;
  manifest: string;
  tag: string;
  publishedBy: string;
  deprecatedMessage?: string | null;
  scanError?: string | null;
  publishedAt?: string | null;
  yankedAt?: string | null;
  blockedAt?: string | null;
  blockReason?: string | null;
}

export interface DistTagData {
  packageId: string;
  tag: string;
  version: string;
}

export interface ReservationData {
  packageId: string;
  version: string;
  userId: string;
  idempotencyKey: string;
  uploadTokenHash: string;
  stagingKey: string;
  status: string;
  expiresAt: string;
}

export interface ReportData {
  reporterId: string;
  packageId: string;
  version?: string | null;
  reason: string;
  detail: string;
  status: string;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
}

export interface AuditLogData {
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  detail?: string | null;
  requestId: string;
  ipHash?: string | null;
}

export interface ScanJobData {
  versionId: string;
  status: string;
  attempts: number;
  lastError?: string | null;
  nextAttemptAt?: string | null;
  result?: string | null;
}

export interface RegistryTableMap {
  users: UserData;
  api_tokens: ApiTokenData;
  packages: PackageData;
  versions: VersionData;
  dist_tags: DistTagData;
  reservations: ReservationData;
  reports: ReportData;
  audit_log: AuditLogData;
  scan_jobs: ScanJobData;
}

export type RegistryTableName = keyof RegistryTableMap;
export type RegistryRow<K extends RegistryTableName> = AppwriteRow<RegistryTableMap[K]>;
export type RegistryRowList<K extends RegistryTableName> = AppwriteRowList<RegistryTableMap[K]>;
