import {
  ErrorCodes,
  isValidVersion,
  normalizePackageName,
  notFound,
  resolveVersion,
} from '@lemonize/shared';
import { AppwriteQuery } from './appwrite.js';
import type { RegistryAppwriteRepository } from './appwrite-repository.js';
import type { AppwriteRow, PackageData, VersionData } from './appwrite-types.js';
import { isPublicPackage, isPublishedVersion } from './metadata.js';

export async function getPublicPackage(
  repo: RegistryAppwriteRepository,
  name: string,
): Promise<AppwriteRow<PackageData>> {
  const normalized = normalizePackageName(name);
  const pkg = await repo.getPackageByNormalizedName(normalized);
  if (!pkg || !isPublicPackage(pkg)) {
    throw notFound(ErrorCodes.PACKAGE_NOT_FOUND, `Package ${name} was not found`);
  }
  return pkg;
}

/**
 * Artifact lookup keeps normally-yanked exact versions reproducible while
 * still treating package-level security blocks as not found.
 */
export async function getDownloadablePackage(
  repo: RegistryAppwriteRepository,
  name: string,
): Promise<AppwriteRow<PackageData>> {
  const normalized = normalizePackageName(name);
  const pkg = await repo.getPackageByNormalizedName(normalized);
  if (!pkg || (pkg.status !== 'active' && pkg.status !== 'published')) {
    throw notFound(ErrorCodes.PACKAGE_NOT_FOUND, `Package ${name} was not found`);
  }
  return pkg;
}

export async function resolvePublicVersion(
  repo: RegistryAppwriteRepository,
  pkg: AppwriteRow<PackageData>,
  requestedName: string,
  versionSpec: string,
): Promise<AppwriteRow<VersionData>> {
  const [versions, tags] = await Promise.all([
    repo.listVersions(pkg.$id, { queries: [AppwriteQuery.limit(5_000)] }),
    repo.listTags(pkg.$id, { queries: [AppwriteQuery.limit(5_000)] }),
  ]);
  const publicVersions = versions.rows.filter(isPublishedVersion);
  if (isValidVersion(versionSpec)) {
    const exact = versions.rows.find((candidate) => candidate.version === versionSpec);
    const normallyYanked =
      Boolean(exact?.yankedAt) &&
      (exact?.status === 'yanked' || exact?.status === 'published');
    if (exact && (isPublishedVersion(exact) || normallyYanked)) return exact;
  }
  const distTags: Record<string, string> = {};
  for (const tag of tags.rows) distTags[tag.tag] = tag.version;
  const resolved = resolveVersion(
    versionSpec,
    publicVersions.map((version) => version.version),
    distTags,
  );
  const version = resolved
    ? publicVersions.find((candidate) => candidate.version === resolved)
    : undefined;
  if (!version) {
    throw notFound(
      ErrorCodes.VERSION_NOT_FOUND,
      `Version ${versionSpec} of ${requestedName} was not found`,
    );
  }
  return version;
}
