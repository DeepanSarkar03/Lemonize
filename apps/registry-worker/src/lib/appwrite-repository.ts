import {
  AppwriteError,
  AppwriteQuery,
  AppwriteRestClient,
  type ListRowsOptions,
  type WriteRowOptions,
} from './appwrite.js';
import type {
  AppwriteRow,
  AppwriteRowList,
  ApiTokenData,
  AuditLogData,
  DistTagData,
  PackageData,
  RegistryRow,
  RegistryTableMap,
  RegistryTableName,
  ReportData,
  ReservationData,
  ScanJobData,
  UserData,
  VersionData,
} from './appwrite-types.js';

export interface RegistryAppwriteBindings {
  APPWRITE_ENDPOINT: string;
  APPWRITE_PROJECT_ID: string;
  APPWRITE_API_KEY: string;
  APPWRITE_DATABASE_ID?: string;
}

function readBinding(env: unknown, name: keyof RegistryAppwriteBindings): string | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Creates the registry repository without coupling the Worker Env type to migration bindings. */
export function registryAppwriteRepository(
  env: unknown,
  fetcher?: ConstructorParameters<typeof AppwriteRestClient>[0]['fetch'],
): RegistryAppwriteRepository {
  return new RegistryAppwriteRepository(
    new AppwriteRestClient({
      endpoint: readBinding(env, 'APPWRITE_ENDPOINT') ?? '',
      projectId: readBinding(env, 'APPWRITE_PROJECT_ID') ?? '',
      apiKey: readBinding(env, 'APPWRITE_API_KEY') ?? '',
      databaseId: readBinding(env, 'APPWRITE_DATABASE_ID') ?? 'registry',
      fetch: fetcher,
    }),
  );
}

function newRowId(): string {
  return crypto.randomUUID();
}

/** Typed CRUD facade for one provisioned registry table. */
export class RegistryTableStore<K extends RegistryTableName> {
  constructor(
    private readonly client: AppwriteRestClient,
    readonly tableId: K,
  ) {}

  create(
    data: RegistryTableMap[K],
    rowId = newRowId(),
    options?: WriteRowOptions,
  ): Promise<RegistryRow<K>> {
    return this.client.createRow<RegistryTableMap[K]>(this.tableId, rowId, data, options);
  }

  get(rowId: string, signal?: AbortSignal): Promise<RegistryRow<K>> {
    return this.client.getRow<RegistryTableMap[K]>(this.tableId, rowId, signal);
  }

  async getOrNull(rowId: string, signal?: AbortSignal): Promise<RegistryRow<K> | null> {
    try {
      return await this.get(rowId, signal);
    } catch (error) {
      if (error instanceof AppwriteError && error.status === 404) return null;
      throw error;
    }
  }

  list(options?: ListRowsOptions): Promise<AppwriteRowList<RegistryTableMap[K]>> {
    return this.client.listRows<RegistryTableMap[K]>(this.tableId, options);
  }

  async first(
    queries: readonly string[],
    signal?: AbortSignal,
  ): Promise<RegistryRow<K> | null> {
    const result = await this.list({
      queries: [...queries, AppwriteQuery.limit(1)],
      total: false,
      signal,
    });
    return result.rows[0] ?? null;
  }

  update(
    rowId: string,
    data: Partial<RegistryTableMap[K]>,
    options?: WriteRowOptions,
  ): Promise<RegistryRow<K>> {
    return this.client.updateRow<RegistryTableMap[K]>(this.tableId, rowId, data, options);
  }

  delete(rowId: string, signal?: AbortSignal): Promise<void> {
    return this.client.deleteRow(this.tableId, rowId, signal);
  }
}

export interface RegistryRepositoryOptions {
  client: AppwriteRestClient;
}

/**
 * Repository for the exact TablesDB resources in infrastructure/appwrite.
 * The table stores expose complete CRUD; the methods below encode indexed,
 * domain-specific lookups so callers do not hand-roll query strings.
 */
export class RegistryAppwriteRepository {
  readonly users: RegistryTableStore<'users'>;
  readonly tokens: RegistryTableStore<'api_tokens'>;
  readonly packages: RegistryTableStore<'packages'>;
  readonly versions: RegistryTableStore<'versions'>;
  readonly tags: RegistryTableStore<'dist_tags'>;
  readonly reservations: RegistryTableStore<'reservations'>;
  readonly reports: RegistryTableStore<'reports'>;
  readonly audit: RegistryTableStore<'audit_log'>;
  readonly scanJobs: RegistryTableStore<'scan_jobs'>;

  constructor(options: RegistryRepositoryOptions | AppwriteRestClient) {
    const client =
      options instanceof AppwriteRestClient ? options : options.client;
    this.users = new RegistryTableStore(client, 'users');
    this.tokens = new RegistryTableStore(client, 'api_tokens');
    this.packages = new RegistryTableStore(client, 'packages');
    this.versions = new RegistryTableStore(client, 'versions');
    this.tags = new RegistryTableStore(client, 'dist_tags');
    this.reservations = new RegistryTableStore(client, 'reservations');
    this.reports = new RegistryTableStore(client, 'reports');
    this.audit = new RegistryTableStore(client, 'audit_log');
    this.scanJobs = new RegistryTableStore(client, 'scan_jobs');
  }

  getUserByClerkId(clerkId: string, signal?: AbortSignal): Promise<AppwriteRow<UserData> | null> {
    return this.users.first([AppwriteQuery.equal('clerkId', clerkId)], signal);
  }

  getUserByNamespace(namespace: string, signal?: AbortSignal): Promise<AppwriteRow<UserData> | null> {
    return this.users.first([AppwriteQuery.equal('namespace', namespace)], signal);
  }

  getUserByGithubId(githubId: string, signal?: AbortSignal): Promise<AppwriteRow<UserData> | null> {
    return this.users.first([AppwriteQuery.equal('githubId', githubId)], signal);
  }

  listUsersByStatus(status: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<UserData>> {
    return this.users.list({
      ...options,
      queries: [AppwriteQuery.equal('status', status), ...(options.queries ?? [])],
    });
  }

  getTokenByHash(tokenHash: string, signal?: AbortSignal): Promise<AppwriteRow<ApiTokenData> | null> {
    return this.tokens.first([AppwriteQuery.equal('tokenHash', tokenHash)], signal);
  }

  listTokensByUser(
    userId: string,
    options: ListRowsOptions & { activeOnly?: boolean } = {},
  ): Promise<AppwriteRowList<ApiTokenData>> {
    const { activeOnly = false, ...listOptions } = options;
    return this.tokens.list({
      ...listOptions,
      queries: [
        AppwriteQuery.equal('userId', userId),
        ...(activeOnly ? [AppwriteQuery.isNull('revokedAt')] : []),
        AppwriteQuery.orderDesc('$createdAt'),
        ...(listOptions.queries ?? []),
      ],
    });
  }

  listTokensByRoot(
    userId: string,
    rootTokenId: string,
    options: ListRowsOptions & { activeOnly?: boolean } = {},
  ): Promise<AppwriteRowList<ApiTokenData>> {
    const { activeOnly = false, ...listOptions } = options;
    return this.tokens.list({
      ...listOptions,
      queries: [
        AppwriteQuery.equal('userId', userId),
        AppwriteQuery.equal('rootTokenId', rootTokenId),
        ...(activeOnly ? [AppwriteQuery.isNull('revokedAt')] : []),
        AppwriteQuery.orderDesc('$createdAt'),
        ...(listOptions.queries ?? []),
      ],
    });
  }

  revokeToken(rowId: string, revokedAt = new Date().toISOString()): Promise<AppwriteRow<ApiTokenData>> {
    return this.tokens.update(rowId, { revokedAt });
  }

  touchToken(rowId: string, lastUsedAt = new Date().toISOString()): Promise<AppwriteRow<ApiTokenData>> {
    return this.tokens.update(rowId, { lastUsedAt });
  }

  getPackageByNormalizedName(
    normalizedName: string,
    signal?: AbortSignal,
  ): Promise<AppwriteRow<PackageData> | null> {
    return this.packages.first(
      [AppwriteQuery.equal('normalizedName', normalizedName)],
      signal,
    );
  }

  listPackagesByOwner(ownerId: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<PackageData>> {
    return this.packages.list({
      ...options,
      queries: [AppwriteQuery.equal('ownerId', ownerId), ...(options.queries ?? [])],
    });
  }

  listPackagesByScope(scope: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<PackageData>> {
    return this.packages.list({
      ...options,
      queries: [AppwriteQuery.equal('scope', scope), ...(options.queries ?? [])],
    });
  }

  searchPackages(term: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<PackageData>> {
    return this.packages.list({
      ...options,
      queries: [
        AppwriteQuery.or([
          AppwriteQuery.search('name', term),
          AppwriteQuery.search('description', term),
        ]),
        ...(options.queries ?? []),
      ],
    });
  }

  getVersion(
    packageId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<AppwriteRow<VersionData> | null> {
    return this.versions.first(
      [
        AppwriteQuery.equal('packageId', packageId),
        AppwriteQuery.equal('version', version),
      ],
      signal,
    );
  }

  listVersions(
    packageId: string,
    options: ListRowsOptions & { status?: string } = {},
  ): Promise<AppwriteRowList<VersionData>> {
    const { status, ...listOptions } = options;
    return this.versions.list({
      ...listOptions,
      queries: [
        AppwriteQuery.equal('packageId', packageId),
        ...(status === undefined ? [] : [AppwriteQuery.equal('status', status)]),
        AppwriteQuery.orderAsc('$createdAt'),
        ...(listOptions.queries ?? []),
      ],
    });
  }

  getTag(packageId: string, tag: string, signal?: AbortSignal): Promise<AppwriteRow<DistTagData> | null> {
    return this.tags.first(
      [AppwriteQuery.equal('packageId', packageId), AppwriteQuery.equal('tag', tag)],
      signal,
    );
  }

  listTags(packageId: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<DistTagData>> {
    return this.tags.list({
      ...options,
      queries: [AppwriteQuery.equal('packageId', packageId), ...(options.queries ?? [])],
    });
  }

  async setTag(
    data: DistTagData,
    rowId = newRowId(),
  ): Promise<AppwriteRow<DistTagData>> {
    const existing = await this.getTag(data.packageId, data.tag);
    if (existing) return this.tags.update(existing.$id, { version: data.version });
    try {
      return await this.tags.create(data, rowId);
    } catch (error) {
      // Resolve a concurrent insert against the unique (packageId, tag) index.
      if (!(error instanceof AppwriteError) || error.status !== 409) throw error;
      const raced = await this.getTag(data.packageId, data.tag);
      if (!raced) throw error;
      return this.tags.update(raced.$id, { version: data.version });
    }
  }

  getReservation(
    packageId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<AppwriteRow<ReservationData> | null> {
    return this.reservations.first(
      [AppwriteQuery.equal('packageId', packageId), AppwriteQuery.equal('version', version)],
      signal,
    );
  }

  getReservationByIdempotencyKey(
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AppwriteRow<ReservationData> | null> {
    return this.reservations.first(
      [AppwriteQuery.equal('idempotencyKey', idempotencyKey)],
      signal,
    );
  }

  getReservationByUploadTokenHash(
    uploadTokenHash: string,
    signal?: AbortSignal,
  ): Promise<AppwriteRow<ReservationData> | null> {
    return this.reservations.first(
      [AppwriteQuery.equal('uploadTokenHash', uploadTokenHash)],
      signal,
    );
  }

  listExpiredReservations(
    before = new Date().toISOString(),
    options: ListRowsOptions = {},
  ): Promise<AppwriteRowList<ReservationData>> {
    return this.reservations.list({
      ...options,
      queries: [
        AppwriteQuery.lessThanEqual('expiresAt', before),
        AppwriteQuery.orderAsc('$updatedAt'),
        ...(options.queries ?? []),
      ],
    });
  }

  listReportsByStatus(status: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<ReportData>> {
    return this.reports.list({
      ...options,
      queries: [
        AppwriteQuery.equal('status', status),
        AppwriteQuery.orderAsc('$createdAt'),
        ...(options.queries ?? []),
      ],
    });
  }

  listReportsForPackage(packageId: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<ReportData>> {
    return this.reports.list({
      ...options,
      queries: [AppwriteQuery.equal('packageId', packageId), ...(options.queries ?? [])],
    });
  }

  resolveReport(
    rowId: string,
    resolvedBy: string,
    status = 'resolved',
    resolvedAt = new Date().toISOString(),
  ): Promise<AppwriteRow<ReportData>> {
    return this.reports.update(rowId, { status, resolvedBy, resolvedAt });
  }

  appendAudit(data: AuditLogData, rowId = newRowId()): Promise<AppwriteRow<AuditLogData>> {
    return this.audit.create(data, rowId);
  }

  listAuditForResource(
    resourceId: string,
    options: ListRowsOptions = {},
  ): Promise<AppwriteRowList<AuditLogData>> {
    return this.audit.list({
      ...options,
      queries: [
        AppwriteQuery.equal('resourceId', resourceId),
        AppwriteQuery.orderDesc('$createdAt'),
        ...(options.queries ?? []),
      ],
    });
  }

  listAuditByActor(actorId: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<AuditLogData>> {
    return this.audit.list({
      ...options,
      queries: [
        AppwriteQuery.equal('actorId', actorId),
        AppwriteQuery.orderDesc('$createdAt'),
        ...(options.queries ?? []),
      ],
    });
  }

  getScanJobByVersionId(
    versionId: string,
    signal?: AbortSignal,
  ): Promise<AppwriteRow<ScanJobData> | null> {
    return this.scanJobs.first([AppwriteQuery.equal('versionId', versionId)], signal);
  }

  listScanJobsByStatus(status: string, options: ListRowsOptions = {}): Promise<AppwriteRowList<ScanJobData>> {
    return this.scanJobs.list({
      ...options,
      queries: [AppwriteQuery.equal('status', status), ...(options.queries ?? [])],
    });
  }

  listReadyScanJobs(
    at = new Date().toISOString(),
    options: ListRowsOptions = {},
  ): Promise<AppwriteRowList<ScanJobData>> {
    return this.scanJobs.list({
      ...options,
      queries: [
        AppwriteQuery.lessThanEqual('nextAttemptAt', at),
        AppwriteQuery.orderAsc('nextAttemptAt'),
        ...(options.queries ?? []),
      ],
    });
  }

  completeScanJob(
    rowId: string,
    result: unknown,
    status = 'completed',
  ): Promise<AppwriteRow<ScanJobData>> {
    const serialized = JSON.stringify(result);
    return this.scanJobs.update(rowId, {
      status,
      result: serialized === undefined ? 'null' : serialized,
      lastError: null,
      nextAttemptAt: null,
    });
  }

  failScanJob(
    rowId: string,
    attempts: number,
    lastError: string,
    nextAttemptAt?: string | null,
  ): Promise<AppwriteRow<ScanJobData>> {
    return this.scanJobs.update(rowId, {
      status: nextAttemptAt ? 'retry' : 'failed',
      attempts,
      lastError: lastError.slice(0, 1_024),
      nextAttemptAt: nextAttemptAt ?? null,
    });
  }
}

export type {
  ApiTokenData,
  AuditLogData,
  DistTagData,
  PackageData,
  ReportData,
  ReservationData,
  ScanJobData,
  UserData,
  VersionData,
} from './appwrite-types.js';
