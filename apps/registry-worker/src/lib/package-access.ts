import type { Context } from 'hono';
import { ErrorCodes, notFound } from '@lemonize/shared';
import type { AppBindings } from './env.js';
import type { AppwriteRow, PackageData } from './appwrite-types.js';
import { authenticate, hasScope } from './auth.js';
import {
  isPrivatePackage,
  packageVisibility,
  requirePrivatePackageRead,
} from './private-packages.js';

/**
 * Private packages currently have one tenant: their immutable registry owner.
 * Organization sharing is deliberately denied until membership is modeled.
 */
export async function requirePackageReadAccess(
  c: Context<AppBindings>,
  pkg: AppwriteRow<PackageData>,
): Promise<void> {
  if (packageVisibility(pkg) === 'public') return;
  // Apply private cache policy before authentication so denied/not-found
  // responses cannot be retained by an intermediary either.
  c.header('cache-control', 'private, no-store');
  c.header('pragma', 'no-cache');
  const vary = c.res.headers.get('vary');
  if (
    !vary
      ?.toLowerCase()
      .split(',')
      .some((value) => value.trim() === 'authorization')
  ) {
    c.header('vary', vary ? `${vary}, Authorization` : 'Authorization');
  }
  c.header('x-lemonize-cache', 'BYPASS');
  const authenticated = Boolean(c.get('userId')) || (await authenticate(c));
  if (!isPrivatePackage(pkg) || !authenticated || !hasScope(c, 'read')) {
    throw notFound(ErrorCodes.PACKAGE_NOT_FOUND, `Package ${pkg.name} was not found`);
  }
  await requirePrivatePackageRead(c, pkg);
}
