import type { PackageManifest, PackageMetadata, PackageVersion } from '@lemonize/shared';
import { AppwriteQuery } from './appwrite.js';
import type { RegistryAppwriteRepository } from './appwrite-repository.js';
import type {
  AppwriteRow,
  PackageData,
  UserData,
  VersionData,
} from './appwrite-types.js';

export function isPublicPackage(pkg: AppwriteRow<PackageData>): boolean {
  return (
    (pkg.status === 'active' || pkg.status === 'published') &&
    (pkg.publishedVersionCount ?? 0) > 0
  );
}

export function isPublishedVersion(version: AppwriteRow<VersionData>): boolean {
  return (
    version.status === 'published' &&
    !version.yankedAt
  );
}

function parseManifest(value: string): PackageManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as PackageManifest)
      : undefined;
  } catch {
    return undefined;
  }
}

function binMap(
  manifest: PackageManifest | undefined,
  packageName: string,
): Record<string, string> | undefined {
  if (typeof manifest?.bin === 'string') {
    const command = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName;
    return command ? { [command]: manifest.bin } : undefined;
  }
  if (typeof manifest?.bin !== 'object' || manifest.bin === null || Array.isArray(manifest.bin)) {
    return undefined;
  }
  const entries = Object.entries(manifest.bin).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function versionToWire(
  version: AppwriteRow<VersionData>,
  packageName: string,
  registryBase: string,
): PackageVersion {
  const manifest = parseManifest(version.manifest);
  const nodeEngine = manifest?.engines?.node;
  const moduleType = manifest?.type;
  const manifestDeprecation = typeof manifest?.deprecated === 'string' ? manifest.deprecated : null;
  return {
    version: version.version,
    tarball: `${registryBase}/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version.version)}/tarball`,
    integrity: version.integrity,
    shasum: version.computedShasum ?? version.shasum,
    unpackedSize: version.unpackedSize,
    tarballSize: version.tarballSize,
    fileCount: version.fileCount,
    engines: typeof nodeEngine === 'string' ? { node: nodeEngine } : undefined,
    moduleType: moduleType === 'module' || moduleType === 'commonjs' ? moduleType : undefined,
    bin: binMap(manifest, packageName),
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt ?? version.$createdAt,
    deprecated: version.deprecatedMessage ?? manifestDeprecation,
    yanked: false,
  };
}

function maintainerNamespace(owner: AppwriteRow<UserData> | null): string[] {
  if (!owner || owner.status === 'deleted') return [];
  return [owner.namespace];
}

export async function buildPackageMetadata(
  repo: RegistryAppwriteRepository,
  pkg: AppwriteRow<PackageData>,
  registryBase: string,
): Promise<PackageMetadata> {
  const [versions, tags, owner] = await Promise.all([
    repo.listVersions(pkg.$id, { queries: [AppwriteQuery.limit(5_000)] }),
    repo.listTags(pkg.$id, { queries: [AppwriteQuery.limit(5_000)] }),
    repo.users.getOrNull(pkg.ownerId),
  ]);
  const distTags: Record<string, string> = {};
  for (const row of tags.rows) distTags[row.tag] = row.version;

  const versionMap: Record<string, PackageVersion> = {};
  for (const version of versions.rows) {
    if (!isPublishedVersion(version)) continue;
    versionMap[version.version] = versionToWire(version, pkg.name, registryBase);
  }
  return {
    name: pkg.name,
    normalizedName: pkg.normalizedName,
    scope: pkg.scope || null,
    visibility: 'public',
    description: pkg.description ?? undefined,
    latest: pkg.latestVersion ?? distTags.latest,
    distTags,
    maintainers: maintainerNamespace(owner),
    createdAt: pkg.$createdAt,
    updatedAt: pkg.$updatedAt,
    versions: versionMap,
  };
}
